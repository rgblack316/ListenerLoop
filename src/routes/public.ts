import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { showOrigins, type Show } from '../db/repo.js';
import { processMessage, uploadPath } from '../process.js';
import { isTestSecret } from '../turnstile.js';
import { cleanText, decryptSecret, hashIp, isValidEmail, ulid } from '../lib/util.js';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function turnstileKeysFor(ctx: AppContext, show: Show): { siteKey: string; secretKey: string } {
  if (show.turnstile_site_key && show.turnstile_secret_key) {
    return { siteKey: show.turnstile_site_key, secretKey: decryptSecret(show.turnstile_secret_key, ctx.config.sessionSecret) };
  }
  return ctx.config.turnstile;
}

function fail(reply: FastifyReply, status: number, error: string, message: string): FastifyReply {
  return reply.code(status).send({ error, message });
}

export function widgetCsp(origins: string[]): string {
  return [
    "default-src 'none'",
    "script-src 'self' https://challenges.cloudflare.com",
    'frame-src https://challenges.cloudflare.com',
    "connect-src 'self' https://challenges.cloudflare.com",
    "style-src 'self'",
    "img-src 'self' data:",
    "media-src 'self' blob:",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${origins.length ? origins.join(' ') : "'none'"}`,
  ].join('; ');
}

export function registerPublicRoutes(app: FastifyInstance, ctx: AppContext, staticDir: string): void {
  const { config, repo } = ctx;
  const widgetHtml = fs.readFileSync(`${staticDir}/widget.html`, 'utf8');

  app.get('/embed.js', (_req, reply) => {
    void reply
      .header('Cache-Control', 'public, max-age=300')
      .header('Content-Type', 'application/javascript; charset=utf-8')
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .send(fs.createReadStream(`${staticDir}/embed.js`));
  });

  app.get('/widget', (req, reply) => {
    const { key } = req.query as { key?: string };
    const show = key ? repo.getShowByKey(key) : undefined;
    if (!show) {
      return reply.code(404).header('Content-Security-Policy', widgetCsp([])).type('text/plain').send('Unknown site key.');
    }
    return reply
      .header('Content-Security-Policy', widgetCsp(showOrigins(show)))
      .header('Cache-Control', 'no-cache')
      .type('text/html; charset=utf-8')
      .send(widgetHtml);
  });

  app.get('/api/public/config', (req, reply) => {
    const { key } = req.query as { key?: string };
    const show = key ? repo.getShowByKey(key) : undefined;
    if (!show) return fail(reply, 404, 'unknown_site_key', 'Unknown site key.');

    // embed.js runs on the podcast site, so only that show's allowed origins may read its settings.
    const origin = req.headers.origin;
    if (origin && showOrigins(show).includes(origin)) {
      void reply.header('Access-Control-Allow-Origin', origin);
    }
    void reply.header('Vary', 'Origin').header('Cache-Control', 'no-cache');

    return reply.send({
      show: {
        name: show.name,
        buttonLabel: show.button_label,
        accentColor: HEX_COLOR.test(show.accent_color) ? show.accent_color : '#21649E',
        promptText: show.prompt_text,
        thanksText: show.thanks_text,
        consentText: show.consent_text,
        maxSeconds: show.max_seconds,
        askEmail: show.ask_email === 1,
      },
      turnstileSiteKey: turnstileKeysFor(ctx, show).siteKey,
    });
  });

  interface Outcome {
    status: number;
    body: Record<string, unknown>;
  }
  const bad = (status: number, error: string, message: string): Outcome => ({ status, body: { error, message } });

  /** Reads and validates one submission. Never sends a reply itself, so cleanup can finish before the response goes out. */
  async function receive(req: FastifyRequest, id: string, tmp: string): Promise<{ outcome: Outcome; accepted: boolean }> {
    const fields: Record<string, string> = {};
    let mime = '';
    let gotFile = false;
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== 'audio' || gotFile) {
          part.file.resume();
          continue;
        }
        await pipeline(part.file, fs.createWriteStream(tmp, { flags: 'wx' }));
        gotFile = true;
        mime = part.mimetype;
      } else if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      }
    }

    const reject = (status: number, error: string, message: string) => ({ outcome: bad(status, error, message), accepted: false });

    const show = fields.key ? repo.getShowByKey(fields.key) : undefined;
    if (!show) return reject(404, 'unknown_site_key', 'Unknown site key.');

    const name = cleanText(fields.name, 100);
    if (!name) return reject(400, 'name_required', 'Please enter your name.');

    let email: string | null = null;
    if (show.ask_email === 1) {
      const rawEmail = cleanText(fields.email, 254);
      if (rawEmail) {
        if (!isValidEmail(rawEmail)) return reject(400, 'invalid_email', 'That email address does not look right.');
        email = rawEmail;
      }
    }

    const consent = ['true', 'on', '1', 'yes'].includes((fields.consent ?? '').toLowerCase());
    if (show.consent_text.trim() && !consent) return reject(400, 'consent_required', 'Please accept the consent notice.');

    const size = gotFile ? (await fs.promises.stat(tmp)).size : 0;
    if (size === 0) return reject(400, 'audio_required', 'No recording was received.');

    const ipHash = hashIp(req.ip, config.sessionSecret);
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    if (repo.countRecentByIp(ipHash, since) >= config.rateLimitPerHour) {
      return reject(429, 'rate_limited', 'Too many messages from your network. Please try again later.');
    }

    const token = fields['cf-turnstile-response'];
    if (!token) return reject(400, 'turnstile_required', 'Please complete the verification challenge.');
    const { secretKey } = turnstileKeysFor(ctx, show);
    const result = await ctx.verifyTurnstile({ secret: secretKey, token, remoteIp: req.ip });
    // The challenge runs inside the widget iframe, so it must have been solved on this app's own domain.
    const hostOk = isTestSecret(secretKey) || result.hostname?.toLowerCase() === config.appHostname;
    if (!result.success || !hostOk) {
      ctx.log.warn({ errorCodes: result.errorCodes, hostname: result.hostname }, 'turnstile verification failed');
      return reject(403, 'turnstile_failed', 'Verification failed. Please try again.');
    }

    repo.insertMessage({
      id,
      show_id: show.id,
      sender_name: name,
      sender_email: email,
      consent_given: consent ? 1 : 0,
      original_mime: mime.slice(0, 100) || null,
      ip_hash: ipHash,
      user_agent: cleanText(req.headers['user-agent'], 300) || null,
    });
    ctx.queue.add(() => processMessage(ctx, id));
    return { outcome: { status: 202, body: { id, status: 'processing', message: show.thanks_text } }, accepted: true };
  }

  app.post('/api/public/messages', async (req, reply) => {
    // The widget iframe is served from this app, so real submissions are same-origin.
    const origin = req.headers.origin;
    if (origin && origin !== config.appOrigin) return fail(reply, 403, 'bad_origin', 'Submissions must come from the ListenerLoop widget.');
    if (!req.isMultipart()) return fail(reply, 415, 'bad_request', 'Expected multipart form data.');

    const id = ulid();
    const tmp = uploadPath(ctx, id);
    let accepted = false;
    let outcome: Outcome;
    try {
      ({ outcome, accepted } = await receive(req, id, tmp));
    } finally {
      // Remove the temporary upload before replying so a rejected submission leaves nothing behind.
      if (!accepted) await fs.promises.rm(tmp, { force: true });
    }
    return reply.code(outcome.status).send(outcome.body);
  });
}
