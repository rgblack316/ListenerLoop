import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  csrfValid,
  endSession,
  getSession,
  LoginThrottle,
  startSession,
  type AdminSession,
} from '../auth.js';
import type { AppContext } from '../context.js';
import {
  INBOX_FILTERS,
  normalizeOrigin,
  parseOriginList,
  showOrigins,
  type InboxFilter,
  type Show,
} from '../db/repo.js';
import { cleanText, encryptSecret, isValidEmail, parseRange, randomToken, safeFilePart, slugify } from '../lib/util.js';
import { inboxPage, loginPage, messagePage, messageRow, showFormPage, showsPage, type ShowFormValues } from '../views/pages.js';

const PAGE_SIZE = 25;
const MAX_SECONDS_LIMIT = 600;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
type Body = Record<string, unknown>;
const field = (body: unknown, name: string): string => {
  const v = (body as Body | undefined)?.[name];
  return typeof v === 'string' ? v : '';
};

const FLASH: Record<string, string> = {
  saved: 'Changes saved.',
  created: 'Show created. Copy the embed code below into your site.',
  rotated: 'Site key rotated. Update the embed code on your site.',
};

export function adminCsp(): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "media-src 'self' https:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { repo, config, storage } = ctx;
  const throttle = new LoginThrottle();
  // Verified against when the email does not match, so login timing does not reveal which part was wrong.
  const dummyHash = hash(randomToken(16));

  const page = (reply: FastifyReply, body: string, status = 200): FastifyReply =>
    reply
      .code(status)
      .header('Content-Security-Policy', adminCsp())
      .header('X-Frame-Options', 'DENY')
      .header('Cache-Control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(body);

  const sameOrigin = (req: FastifyRequest): boolean => {
    const origin = req.headers.origin;
    return !origin || origin === config.appOrigin;
  };

  type Handler = (req: FastifyRequest, reply: FastifyReply, session: AdminSession) => unknown;

  /** Signed-in GET page. */
  const authed = (handler: Handler) => async (req: FastifyRequest, reply: FastifyReply) => {
    const session = getSession(ctx, req);
    if (!session) return reply.redirect('/admin/login');
    return handler(req, reply, session);
  };

  /** Signed-in state-changing request: same-origin plus a valid CSRF token. */
  const mutating = (handler: Handler) =>
    authed((req, reply, session) => {
      const token = (req.body as Body | undefined)?._csrf ?? req.headers['x-csrf-token'];
      if (!sameOrigin(req) || !csrfValid(session, token)) {
        return reply.code(403).type('text/plain').send('Request could not be verified. Reload the page and try again.');
      }
      return handler(req, reply, session);
    });

  const isHtmx = (req: FastifyRequest): boolean => req.headers['hx-request'] === 'true';

  // ---------------------------------------------------------------- auth
  app.get('/admin', (_req, reply) => reply.redirect('/admin/inbox'));

  app.get('/admin/login', (req, reply) => {
    if (getSession(ctx, req)) return reply.redirect('/admin/inbox');
    return page(reply, loginPage());
  });

  app.post('/admin/login', async (req, reply) => {
    if (!sameOrigin(req)) return reply.code(403).type('text/plain').send('Forbidden');
    if (throttle.blocked(req.ip)) return page(reply, loginPage('Too many attempts. Please wait a few minutes and try again.'), 429);
    const email = field(req.body, 'email').trim().toLowerCase();
    const password = field(req.body, 'password');
    const admin = repo.getAdmin();
    const emailMatches = !!admin && admin.email.toLowerCase() === email;
    let ok = false;
    try {
      ok = await verify(emailMatches && admin ? admin.password_hash : await dummyHash, password);
    } catch {
      ok = false;
    }
    if (!ok || !emailMatches || !admin) {
      throttle.fail(req.ip);
      return page(reply, loginPage('That email and password do not match.'), 401);
    }
    throttle.clear(req.ip);
    startSession(ctx, reply, admin.id);
    return reply.redirect('/admin/inbox');
  });

  app.post(
    '/admin/logout',
    mutating((req, reply) => {
      endSession(ctx, req, reply);
      return reply.redirect('/admin/login');
    }),
  );

  // ---------------------------------------------------------------- inbox
  app.get(
    '/admin/inbox',
    authed((req, reply, session) => {
      const q = req.query as { filter?: string; show?: string; page?: string };
      const filter: InboxFilter = INBOX_FILTERS.includes(q.filter as InboxFilter) ? (q.filter as InboxFilter) : 'inbox';
      const shows = repo.listShows();
      const showId = q.show && shows.some((s) => s.id === q.show) ? q.show : undefined;
      const total = repo.countMessages(filter, showId);
      const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      const pageNo = Math.min(Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1), pages);
      const messages = repo.listMessages(filter, { showId, limit: PAGE_SIZE, offset: (pageNo - 1) * PAGE_SIZE });
      const counts = Object.fromEntries(INBOX_FILTERS.map((f) => [f, repo.countMessages(f, showId)])) as Record<InboxFilter, number>;
      return page(reply, inboxPage({ csrf: session.csrf, messages, filter, showId, shows, counts, page: pageNo, pages, total }));
    }),
  );

  // ---------------------------------------------------------------- message
  app.get(
    '/admin/messages/:id',
    authed((req, reply, session) => {
      const { id } = req.params as { id: string };
      const m = repo.getMessage(id);
      if (!m) return page(reply, '<p>Message not found.</p>', 404);
      if (m.status === 'ready' && !m.read_at) repo.updateMessage(id, { read_at: new Date().toISOString() });
      const flash = FLASH[(req.query as { flash?: string }).flash ?? ''];
      return page(reply, messagePage(m, session.csrf, flash));
    }),
  );

  const afterAction = (req: FastifyRequest, reply: FastifyReply, id: string, htmxBody: string): FastifyReply => {
    if (isHtmx(req)) return reply.type('text/html; charset=utf-8').send(htmxBody);
    return reply.redirect(`/admin/messages/${id}?flash=saved`);
  };

  app.post(
    '/admin/messages/:id/star',
    mutating((req, reply) => {
      const { id } = req.params as { id: string };
      const m = repo.getMessage(id);
      if (!m) return reply.code(404).send('Not found');
      repo.updateMessage(id, { starred: m.starred ? 0 : 1 });
      return afterAction(req, reply, id, messageRow(repo.getMessage(id)!).toString());
    }),
  );

  app.post(
    '/admin/messages/:id/archive',
    mutating((req, reply) => {
      const { id } = req.params as { id: string };
      const m = repo.getMessage(id);
      if (!m) return reply.code(404).send('Not found');
      repo.updateMessage(id, { archived: m.archived ? 0 : 1 });
      // In a list, the row leaves the current view; on the detail page we stay put.
      return afterAction(req, reply, id, '');
    }),
  );

  app.post(
    '/admin/messages/:id/delete',
    mutating((req, reply) => {
      const { id } = req.params as { id: string };
      if (!repo.getMessage(id)) return reply.code(404).send('Not found');
      repo.updateMessage(id, { deleted_at: new Date().toISOString() });
      if (isHtmx(req)) return reply.type('text/html; charset=utf-8').send('');
      return reply.redirect('/admin/inbox');
    }),
  );

  app.post(
    '/admin/messages/:id/notes',
    mutating((req, reply) => {
      const { id } = req.params as { id: string };
      if (!repo.getMessage(id)) return reply.code(404).send('Not found');
      repo.updateMessage(id, { notes: field(req.body, 'notes').slice(0, 4000) || null });
      return reply.redirect(`/admin/messages/${id}?flash=saved`);
    }),
  );

  app.get(
    '/admin/messages/:id/audio',
    authed(async (req, reply) => {
      const { id } = req.params as { id: string };
      const m = repo.getMessage(id);
      if (!m || m.status !== 'ready' || !m.mp3_key) return reply.code(404).type('text/plain').send('Not found');
      const download = (req.query as { download?: string }).download === '1';
      const filename = `${safeFilePart(m.show_slug)}-${safeFilePart(m.sender_name)}-${m.created_at.slice(0, 10)}.mp3`;

      if (storage.getSignedUrl) {
        const url = await storage.getSignedUrl(m.mp3_key, 300, {
          contentType: 'audio/mpeg',
          downloadName: download ? filename : undefined,
        });
        return reply.header('Cache-Control', 'no-store').redirect(url);
      }

      const size = await storage.size(m.mp3_key);
      if (size === null) return reply.code(404).type('text/plain').send('Audio file is missing.');
      const range = parseRange(req.headers.range, size);
      void reply
        .header('Content-Type', 'audio/mpeg')
        .header('Accept-Ranges', 'bytes')
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff');
      if (download) void reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      if (range === 'invalid') return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      if (range) {
        void reply
          .code(206)
          .header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
          .header('Content-Length', range.end - range.start + 1);
        return reply.send(await storage.getStream(m.mp3_key, range));
      }
      void reply.header('Content-Length', size);
      return reply.send(await storage.getStream(m.mp3_key));
    }),
  );

  // ---------------------------------------------------------------- shows
  const blankValues = (): ShowFormValues => ({
    name: '',
    slug: '',
    allowed_origins: '',
    notify_email: '',
    max_seconds: String(config.maxSecondsDefault),
    ask_email: true,
    consent_text: 'By sending this message you agree that it may be played on the show.',
    button_label: 'Leave a voicemail',
    accent_color: '#21649E',
    prompt_text: 'Record a message for the show.',
    thanks_text: 'Thank you! Your message was sent.',
    retain_original: false,
    turnstile_site_key: '',
    has_turnstile_secret: false,
  });

  const valuesFromShow = (s: Show): ShowFormValues => ({
    name: s.name,
    slug: s.slug,
    allowed_origins: showOrigins(s).join('\n'),
    notify_email: s.notify_email ?? '',
    max_seconds: String(s.max_seconds),
    ask_email: s.ask_email === 1,
    consent_text: s.consent_text,
    button_label: s.button_label,
    accent_color: s.accent_color,
    prompt_text: s.prompt_text,
    thanks_text: s.thanks_text,
    retain_original: s.retain_original === 1,
    turnstile_site_key: s.turnstile_site_key ?? '',
    has_turnstile_secret: !!s.turnstile_secret_key,
  });

  const valuesFromBody = (body: unknown, prev: ShowFormValues): ShowFormValues => ({
    name: cleanText(field(body, 'name'), 100),
    slug: cleanText(field(body, 'slug'), 48).toLowerCase(),
    allowed_origins: field(body, 'allowed_origins'),
    notify_email: cleanText(field(body, 'notify_email'), 254),
    max_seconds: cleanText(field(body, 'max_seconds'), 5),
    ask_email: field(body, 'ask_email') === '1',
    consent_text: cleanText(field(body, 'consent_text'), 500),
    button_label: cleanText(field(body, 'button_label'), 60) || 'Leave a voicemail',
    accent_color: field(body, 'accent_color'),
    prompt_text: cleanText(field(body, 'prompt_text'), 300),
    thanks_text: cleanText(field(body, 'thanks_text'), 300),
    retain_original: field(body, 'retain_original') === '1',
    turnstile_site_key: cleanText(field(body, 'turnstile_site_key'), 100),
    has_turnstile_secret: prev.has_turnstile_secret,
  });

  interface Parsed {
    errors: string[];
    fields: Partial<Omit<Show, 'id' | 'created_at'>>;
  }

  const parseShowForm = (body: unknown, v: ShowFormValues, existing: Show | null): Parsed => {
    const errors: string[] = [];
    if (!v.name) errors.push('Show name is required.');
    const { origins, invalid } = parseOriginList(v.allowed_origins);
    if (invalid.length) errors.push(`These sites are not valid addresses: ${invalid.join(', ')}`);
    if (v.notify_email && !isValidEmail(v.notify_email)) errors.push('The notification email does not look right.');
    const maxSeconds = Number.parseInt(v.max_seconds, 10);
    if (!Number.isInteger(maxSeconds) || maxSeconds < 5 || maxSeconds > MAX_SECONDS_LIMIT) {
      errors.push(`Maximum length must be between 5 and ${MAX_SECONDS_LIMIT} seconds.`);
    }
    if (!HEX_COLOR.test(v.accent_color)) errors.push('Accent color must be a hex color like #21649E.');
    let slug = existing?.slug;
    if (existing) {
      slug = slugify(v.slug);
      const taken = repo.getShowBySlug(slug);
      if (taken && taken.id !== existing.id) errors.push('That URL slug is already used by another show.');
    }

    const newSecret = field(body, 'turnstile_secret_key').trim();
    const clear = field(body, 'clear_turnstile') === '1';
    let tsSite: string | null = existing?.turnstile_site_key ?? null;
    let tsSecret: string | null = existing?.turnstile_secret_key ?? null;
    if (clear) {
      tsSite = null;
      tsSecret = null;
    } else if (v.turnstile_site_key || newSecret) {
      const site = v.turnstile_site_key || tsSite;
      if (!site || (!newSecret && !tsSecret)) errors.push('Set both the Turnstile site key and secret key, or leave both empty.');
      else {
        tsSite = site;
        if (newSecret) tsSecret = encryptSecret(newSecret, config.sessionSecret);
      }
    }

    return {
      errors,
      fields: {
        name: v.name,
        ...(slug ? { slug } : {}),
        allowed_origins: JSON.stringify(origins),
        notify_email: v.notify_email || null,
        max_seconds: maxSeconds,
        ask_email: v.ask_email ? 1 : 0,
        consent_text: v.consent_text,
        button_label: v.button_label,
        accent_color: v.accent_color,
        prompt_text: v.prompt_text,
        thanks_text: v.thanks_text,
        retain_original: v.retain_original ? 1 : 0,
        turnstile_site_key: tsSite,
        turnstile_secret_key: tsSecret,
      },
    };
  };

  app.get(
    '/admin/shows',
    authed((req, reply, session) => {
      const flash = FLASH[(req.query as { flash?: string }).flash ?? ''];
      return page(reply, showsPage(repo.listShows(), config.appUrl, session.csrf, flash));
    }),
  );

  app.get(
    '/admin/shows/new',
    authed((_req, reply, session) =>
      page(reply, showFormPage({ csrf: session.csrf, show: null, values: blankValues(), errors: [], maxSecondsLimit: MAX_SECONDS_LIMIT })),
    ),
  );

  app.post(
    '/admin/shows',
    mutating((req, reply, session) => {
      const values = valuesFromBody(req.body, blankValues());
      const { errors, fields } = parseShowForm(req.body, values, null);
      if (errors.length) {
        return page(reply, showFormPage({ csrf: session.csrf, show: null, values, errors, maxSecondsLimit: MAX_SECONDS_LIMIT }), 400);
      }
      repo.createShow({ ...(fields as Omit<typeof fields, 'name'>), name: values.name });
      return reply.redirect('/admin/shows?flash=created');
    }),
  );

  app.get(
    '/admin/shows/:id',
    authed((req, reply, session) => {
      const show = repo.getShow((req.params as { id: string }).id);
      if (!show) return page(reply, '<p>Show not found.</p>', 404);
      return page(reply, showFormPage({ csrf: session.csrf, show, values: valuesFromShow(show), errors: [], maxSecondsLimit: MAX_SECONDS_LIMIT }));
    }),
  );

  app.post(
    '/admin/shows/:id',
    mutating((req, reply, session) => {
      const show = repo.getShow((req.params as { id: string }).id);
      if (!show) return page(reply, '<p>Show not found.</p>', 404);
      const values = valuesFromBody(req.body, valuesFromShow(show));
      const { errors, fields } = parseShowForm(req.body, values, show);
      if (errors.length) {
        return page(reply, showFormPage({ csrf: session.csrf, show, values, errors, maxSecondsLimit: MAX_SECONDS_LIMIT }), 400);
      }
      repo.updateShow(show.id, fields);
      return reply.redirect('/admin/shows?flash=saved');
    }),
  );

  app.post(
    '/admin/shows/:id/rotate-key',
    mutating((req, reply) => {
      const show = repo.getShow((req.params as { id: string }).id);
      if (!show) return reply.code(404).send('Not found');
      repo.rotateSiteKey(show.id);
      return reply.redirect('/admin/shows?flash=rotated');
    }),
  );
}

export { normalizeOrigin };
