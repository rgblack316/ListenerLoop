import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  canEdit,
  csrfValid,
  isOwner,
  endSession,
  getSession,
  LoginThrottle,
  startSession,
  type AdminSession,
} from '../auth.js';
import type { AppContext } from '../context.js';
import {
  cleanSubject,
  defaultReplySubject,
  MAX_REPLIES_PER_HOUR,
  MAX_REPLIES_PER_MESSAGE,
  MAX_REPLY_BODY,
  REPLY_BLOCK_TEXT,
  replyBlocked,
  sendReply,
} from '../reply.js';
import { checkFeedUrl, clearCover, refreshCover } from '../cover.js';
import { buildZip, MAX_ZIP_MESSAGES } from '../zip.js';
import { queueTranscription, transcriptionAvailable } from '../transcribe.js';
import { notifyNewMessage, purgeMessage, retryMessage } from '../process.js';
import {
  INBOX_FILTERS,
  NOISE_REDUCTION_LEVELS,
  type NoiseReduction,
  normalizeOrigin,
  parseOriginList,
  RESERVED_SLUGS,
  showOrigins,
  type InboxFilter,
  type Show,
  ftsQuery,
} from '../db/repo.js';
import { MAX_IMPORT_MB } from '../restore.js';
import { backupDir, backupRunning, loadBackupSettings, nextSlot } from '../backup.js';
import { registerBackupRoutes } from './backups.js';
import { registerUserRoutes } from './users.js';
import { registerWebhookRoutes } from './webhooks.js';
import { registerExportRoutes } from './export.js';
import { hashRecoveryCode, verifyTotp } from '../totp.js';
import { hmacHex, safeEqual } from '../lib/util.js';
import { cleanText, isValidEmail, parseRange, randomToken, safeFilePart, slugify, ulid } from '../lib/util.js';
import { homePage, inboxPage, type ReplyView, loginPage, messagePage, messageRow, settingsPage, showFormPage, showsPage, type SettingsView, type ShowFormValues } from '../views/pages.js';

const PAGE_SIZE = 25;
const appVersion = (): string => {
  try {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
};
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
  retrying: 'Retrying. This usually takes a few seconds; reload to see the result.',
  transcribing: 'Transcribing. This can take a few minutes; reload to see the result.',
  nopicked: 'Tick the messages you want to download first.',
  replied: 'Reply sent.',
  replyfailed: 'The reply could not be sent. The reason is shown below, and you can try again.',
  coverok: 'Cover art updated.',
  coverfail: 'Saved, but the cover art could not be fetched. The reason is shown below.',
  notranscribe: 'Transcription is not switched on for this server.',
  alert: 'Alert email handled. If it failed again, the reason is shown below.',
};

export function adminCsp(): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "media-src 'self' https:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-src 'self'",
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
    if (!session) return reply.redirect('/login');
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

  const forbidden = (reply: FastifyReply): FastifyReply => reply.code(403).type('text/plain').send('You do not have permission to do that.');
  /** State-changing request that needs the editor or owner role. */
  const editing = (handler: Handler) => mutating((req, reply, session) => (canEdit(session) ? handler(req, reply, session) : forbidden(reply)));
  const ownerAuthed = (handler: Handler) => authed((req, reply, session) => (isOwner(session) ? handler(req, reply, session) : forbidden(reply)));
  const ownerMutating = (handler: Handler) => mutating((req, reply, session) => (isOwner(session) ? handler(req, reply, session) : forbidden(reply)));

  const isHtmx = (req: FastifyRequest): boolean => req.headers['hx-request'] === 'true';

  // ---------------------------------------------------------------- auth
  const TICKET_MS = 5 * 60 * 1000;
  const signTicket = (userId: string): string => {
    const exp = String(Date.now() + TICKET_MS);
    return `${userId}.${exp}.${hmacHex(config.sessionSecret, `ticket:${userId}:${exp}`)}`;
  };
  const readTicket = (ticket: string): string | null => {
    const [userId, exp, mac] = ticket.split('.');
    if (!userId || !exp || !mac || Number(exp) < Date.now()) return null;
    return safeEqual(hmacHex(config.sessionSecret, `ticket:${userId}:${exp}`), mac) ? userId : null;
  };
  const finishLogin = (req: FastifyRequest, reply: FastifyReply, userId: string): FastifyReply => {
    throttle.clear(req.ip);
    repo.updateUser(userId, { last_login_at: new Date().toISOString() });
    startSession(ctx, reply, userId);
    return reply.redirect('/');
  };

  app.get('/login', (req, reply) => {
    if (getSession(ctx, req)) return reply.redirect('/');
    return page(reply, loginPage());
  });

  app.post('/login', async (req, reply) => {
    if (!sameOrigin(req)) return reply.code(403).type('text/plain').send('Forbidden');
    if (throttle.blocked(req.ip)) return page(reply, loginPage('Too many attempts. Please wait a few minutes and try again.'), 429);
    const email = field(req.body, 'email').trim().toLowerCase();
    const password = field(req.body, 'password');
    const user = repo.getUserByEmail(email);
    const usable = !!user && !user.disabled_at;
    let ok = false;
    try {
      ok = await verify(usable && user ? user.password_hash : await dummyHash, password);
    } catch {
      ok = false;
    }
    if (!ok || !usable || !user) {
      throttle.fail(req.ip);
      return page(reply, loginPage('That email and password do not match.'), 401);
    }
    if (user.totp_enabled) return page(reply, loginPage(undefined, signTicket(user.id)));
    return finishLogin(req, reply, user.id);
  });

  // Second step for users with two-step sign-in on. The ticket proves the password step passed.
  app.post('/login/verify', (req, reply) => {
    if (!sameOrigin(req)) return reply.code(403).type('text/plain').send('Forbidden');
    if (throttle.blocked(req.ip)) return page(reply, loginPage('Too many attempts. Please wait a few minutes and try again.'), 429);
    const ticket = field(req.body, 'ticket');
    const userId = readTicket(ticket);
    const user = userId ? repo.getUser(userId) : undefined;
    if (!user || user.disabled_at || !user.totp_enabled || !user.totp_secret) {
      return page(reply, loginPage('That sign-in expired. Please start again.'), 401);
    }
    const code = field(req.body, 'code').trim();
    const step = verifyTotp(user.totp_secret, code, user.totp_last_step);
    if (step !== null) {
      repo.updateUser(user.id, { totp_last_step: step });
      return finishLogin(req, reply, user.id);
    }
    if (repo.useRecoveryCode(user.id, hashRecoveryCode(code))) return finishLogin(req, reply, user.id);
    throttle.fail(req.ip);
    return page(reply, loginPage('That code is not right. Try again, or use a recovery code.', ticket), 401);
  });

  app.post(
    '/logout',
    mutating((req, reply) => {
      endSession(ctx, req, reply);
      return reply.redirect('/login');
    }),
  );

  // ---------------------------------------------------------------- home and inboxes
  // Every show the signed-in user may open: owners see all, everyone else sees the shows they were given.
  // Every route below goes through this, so access is decided in exactly one place.
  const accessibleShows = (session: AdminSession): Show[] => {
    const all = repo.listShows();
    if (isOwner(session)) return all;
    const mine = new Set(repo.userShowIds(session.userId));
    return all.filter((sh) => mine.has(sh.id));
  };
  /** The show ids to query for the "all messages" views. */
  const scopeIds = (session: AdminSession): string[] => accessibleShows(session).map((sh) => sh.id);
  const showFor = (req: FastifyRequest, session: AdminSession): Show | undefined => {
    const { slug } = req.params as { slug: string };
    return accessibleShows(session).find((s) => s.slug === slug);
  };
  const notFound = (reply: FastifyReply): FastifyReply => page(reply, '<p>Not found.</p>', 404);

  app.get(
    '/',
    authed((_req, reply, session) => {
      const shows = accessibleShows(session);
      if (shows.length === 0 && isOwner(session)) return reply.redirect('/shows/new');
      if (shows.length === 1) return reply.redirect(`/shows/${shows[0]!.slug}`);
      const summaries = shows.map((show) => ({
        show,
        unread: repo.countMessages('new', show.id),
        total: repo.countMessages('inbox', show.id),
      }));
      return page(reply, homePage(summaries, repo.countMessages('new', scopeIds(session)), session.csrf, session.role));
    }),
  );

  const renderInbox = (req: FastifyRequest, reply: FastifyReply, session: AdminSession, show?: Show): FastifyReply => {
    const q = req.query as { filter?: string; page?: string; q?: string };
    const search = (q.q ?? '').trim().slice(0, 200);
    const searching = ftsQuery(search) !== null;
    // A search looks through everything in this inbox, whichever tab was open.
    const filter: InboxFilter = searching ? 'all' : INBOX_FILTERS.includes(q.filter as InboxFilter) ? (q.filter as InboxFilter) : 'inbox';
    const showId = show ? show.id : scopeIds(session);
    const total = repo.countMessages(filter, showId, searching ? search : undefined);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const pageNo = Math.min(Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1), pages);
    const messages = repo.listMessages(filter, { showId, limit: PAGE_SIZE, offset: (pageNo - 1) * PAGE_SIZE, search: searching ? search : undefined });
    const snippets = searching ? repo.transcriptSnippets(search, messages.map((m) => m.id)) : new Map<string, string>();
    const counts = Object.fromEntries(INBOX_FILTERS.map((f) => [f, repo.countMessages(f, showId)])) as Record<InboxFilter, number>;
    return page(
      reply,
      inboxPage({ csrf: session.csrf, role: session.role, messages, snippets, search: searching ? search : '', filter, show, hasShows: accessibleShows(session).length > 0, counts, page: pageNo, pages, total }),
    );
  };

  app.get('/inbox', authed((req, reply, session) => renderInbox(req, reply, session)));

  // ---------------------------------------------------------------- bulk download
  const sendZip = (req: FastifyRequest, reply: FastifyReply, session: AdminSession, show?: Show): FastifyReply => {
    const raw = (req.body as Body | undefined)?.ids as unknown;
    const ids = [...new Set((Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []).filter((v): v is string => typeof v === 'string'))];
    const allowed = new Set((show ? [show] : accessibleShows(session)).map((s) => s.id));
    const messages = ids
      .slice(0, MAX_ZIP_MESSAGES)
      .map((id) => repo.getMessage(id))
      .filter((m): m is NonNullable<typeof m> => !!m && allowed.has(m.show_id) && m.status === 'ready' && !!m.mp3_key)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const back = show ? `/shows/${show.slug}` : '/inbox';
    if (messages.length === 0) return reply.redirect(`${back}?flash=nopicked`);
    const stamp = new Date().toISOString().slice(0, 10);
    const name = `listenerloop-${show ? show.slug : 'messages'}-${stamp}.zip`;
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('cache-control', 'private, no-store')
      .send(buildZip(ctx, messages));
  };

  app.post('/inbox/download', mutating((req, reply, session) => sendZip(req, reply, session)));
  app.post(
    '/shows/:slug/download',
    mutating((req, reply, session) => {
      const show = showFor(req, session);
      return show ? sendZip(req, reply, session, show) : notFound(reply);
    }),
  );

  // ---------------------------------------------------------------- message
  /** A message, only if it belongs to the show in the URL and that show is open to this user. */
  const messageFor = (req: FastifyRequest, session: AdminSession) => {
    const show = showFor(req, session);
    const m = show ? repo.getMessage((req.params as { id: string }).id) : undefined;
    return show && m && m.show_id === show.id ? m : undefined;
  };
  const here = (m: { show_slug: string; id: string }): string => `/shows/${m.show_slug}/messages/${m.id}`;

  /** What the message page needs to show the reply box and the conversation so far. */
  const replyView = (m: NonNullable<ReturnType<typeof messageFor>>, draft?: { subject: string; body: string; error: string }): ReplyView => {
    const blocked = replyBlocked(ctx, m);
    return {
      replies: repo.listReplies(m.id),
      blockedText: blocked ? REPLY_BLOCK_TEXT[blocked] : null,
      blockedCode: blocked,
      draft: draft ?? { subject: defaultReplySubject(m.show_name), body: '', error: '' },
      maxBody: MAX_REPLY_BODY,
    };
  };

  app.get(
    '/shows/:slug/messages/:id',
    authed((req, reply, session) => {
      const m = messageFor(req, session);
      if (!m) return notFound(reply);
      if (m.status === 'ready' && !m.read_at) repo.updateMessage(m.id, { read_at: new Date().toISOString() });
      const flash = FLASH[(req.query as { flash?: string }).flash ?? ''];
      return page(reply, messagePage(m, session.csrf, session.role, flash, transcriptionAvailable(ctx), replyView(m)));
    }),
  );

  const afterAction = (req: FastifyRequest, reply: FastifyReply, to: string, htmxBody: string, flash = 'saved'): FastifyReply => {
    if (isHtmx(req)) return reply.type('text/html; charset=utf-8').send(htmxBody);
    return reply.redirect(`${to}?flash=${flash}`);
  };

  app.post(
    '/shows/:slug/messages/:id/star',
    editing((req, reply, session) => {
      const m = messageFor(req, session);
      if (!m) return notFound(reply);
      repo.updateMessage(m.id, { starred: m.starred ? 0 : 1 });
      return afterAction(req, reply, here(m), messageRow(repo.getMessage(m.id)!).toString());
    }),
  );

  app.post(
    '/shows/:slug/messages/:id/archive',
    editing((req, reply, session) => {
      const m = messageFor(req, session);
      if (!m) return notFound(reply);
      repo.updateMessage(m.id, { archived: m.archived ? 0 : 1 });
      // In a list, the row leaves the current view; on the detail page we stay put.
      return afterAction(req, reply, here(m), '');
    }),
  );

  app.post(
    '/shows/:slug/messages/:id/delete',
    editing(async (req, reply, session) => {
      const m = messageFor(req, session);
      if (!m) return notFound(reply);
      // Hide it at once, then remove the audio and the record; a failed removal is retried by the hourly sweep.
      repo.updateMessage(m.id, { deleted_at: new Date().toISOString() });
      await purgeMessage(ctx, m);
      if (isHtmx(req)) return reply.type('text/html; charset=utf-8').send('');
      return reply.redirect(`/shows/${m.show_slug}`);
    }),
  );

  app.post(
    '/shows/:slug/messages/:id/retry',
    editing(async (req, reply, session) => {
      const m = messageFor(req, session);
      if (!m) return notFound(reply);
      const result = await retryMessage(ctx, m);
      if (result === 'not_failed') return reply.redirect(here(m));
      if (result !== 'queued') {
        const why = result === 'no_original' ? 'The original recording was not saved, so this message cannot be retried.' : 'The original recording could not be read from storage. Try again in a moment.';
        return page(reply, `<p>${why}</p><p><a href="${here(m)}">Back to the message</a></p>`, 409);
      }
      return afterAction(req, reply, here(m), messageRow(repo.getMessage(m.id)!).toString(), 'retrying');
    }),
  );

  app.post(
    '/shows/:slug/messages/:id/resend-alert',
    editing(async (req, reply, session) => {
      const m = messageFor(req, session);
      if (!m) return notFound(reply);
      if (m.status === 'ready') await notifyNewMessage(ctx, m.id);
      return reply.redirect(`${here(m)}?flash=alert`);
    }),
  );

  app.post(
    '/shows/:slug/messages/:id/reply',
    editing(async (req, reply, session) => {
      const m = messageFor(req, session);
      if (!m) return notFound(reply);
      const subject = cleanSubject(field(req.body, 'subject')) || defaultReplySubject(m.show_name);
      const body = field(req.body, 'body').replace(/\r\n/g, '\n').trim();
      const refuse = (error: string): FastifyReply =>
        page(reply, messagePage(m, session.csrf, session.role, undefined, transcriptionAvailable(ctx), replyView(m, { subject, body, error })), 400);
      const blocked = replyBlocked(ctx, m);
      if (blocked) return refuse(REPLY_BLOCK_TEXT[blocked]);
      if (!body) return refuse('Write your reply first.');
      if (body.length > MAX_REPLY_BODY) return refuse(`Keep the reply under ${MAX_REPLY_BODY} characters.`);
      if (repo.countRepliesForMessage(m.id) >= MAX_REPLIES_PER_MESSAGE) return refuse('That is the most replies this message allows.');
      if (repo.countRepliesSince(new Date(Date.now() - 3_600_000).toISOString()) >= MAX_REPLIES_PER_HOUR) return refuse('Too many replies this hour. Please wait a while.');
      const result = await sendReply(ctx, m, { subject, body });
      return reply.redirect(`${here(m)}?flash=${result.ok ? 'replied' : 'replyfailed'}`);
    }),
  );

  app.post(
    '/shows/:slug/messages/:id/replies/:rid/resend',
    editing(async (req, reply, session) => {
      const m = messageFor(req, session);
      const prior = m ? repo.getReply((req.params as { rid: string }).rid) : undefined;
      if (!m || !prior || prior.message_id !== m.id) return notFound(reply);
      if (prior.status === 'failed') {
        if (repo.countRepliesSince(new Date(Date.now() - 3_600_000).toISOString()) >= MAX_REPLIES_PER_HOUR) {
          return reply.redirect(`${here(m)}?flash=replyfailed`);
        }
        const result = await sendReply(ctx, m, { subject: prior.subject, body: prior.body }, prior.id);
        return reply.redirect(`${here(m)}?flash=${result.ok ? 'replied' : 'replyfailed'}`);
      }
      return reply.redirect(here(m));
    }),
  );

  app.post(
    '/shows/:slug/messages/:id/transcribe',
    editing((req, reply, session) => {
      const m = messageFor(req, session);
      if (!m) return notFound(reply);
      if (m.transcript_status === 'pending') return reply.redirect(`${here(m)}?flash=transcribing`);
      const queued = queueTranscription(ctx, m.id);
      return reply.redirect(`${here(m)}?flash=${queued ? 'transcribing' : 'notranscribe'}`);
    }),
  );

  app.get(
    '/shows/:slug/messages/:id/transcript.txt',
    authed((req, reply, session) => {
      const m = messageFor(req, session);
      if (!m || m.transcript_status !== 'done') return notFound(reply);
      const name = `${m.show_slug}-${m.created_at.slice(0, 10)}-${m.sender_name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'message'}.txt`;
      return reply
        .header('content-type', 'text/plain; charset=utf-8')
        .header('content-disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`)
        .header('cache-control', 'private, no-store')
        .send(`${m.sender_name} - ${m.show_name} - ${m.created_at}\n\n${m.transcript ?? ''}\n`);
    }),
  );

  app.post(
    '/shows/:slug/messages/:id/notes',
    editing((req, reply, session) => {
      const m = messageFor(req, session);
      if (!m) return notFound(reply);
      repo.updateMessage(m.id, { notes: field(req.body, 'notes').slice(0, 4000) || null });
      return reply.redirect(`${here(m)}?flash=saved`);
    }),
  );

  /** The recording as the browser sent it. Only audio and video types are passed on, so a stored value can never turn into a page. */
  const ORIGINAL_TYPES: Record<string, string> = {
    'audio/webm': 'webm', 'video/webm': 'webm', 'audio/ogg': 'ogg', 'video/ogg': 'ogg', 'audio/mp4': 'm4a', 'video/mp4': 'm4a', 'audio/x-m4a': 'm4a',
    'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/3gpp': '3gp', 'audio/flac': 'flac',
  };
  const originalKind = (mime: string | null): { type: string; ext: string } => {
    const base = (mime ?? '').split(';')[0]!.trim().toLowerCase();
    return ORIGINAL_TYPES[base] ? { type: base, ext: ORIGINAL_TYPES[base]! } : { type: 'application/octet-stream', ext: 'bin' };
  };

  app.get(
    '/shows/:slug/messages/:id/audio',
    authed(async (req, reply, session) => {
      const m = messageFor(req, session);
      if (!m) return reply.code(404).type('text/plain').send('Not found');
      const q = req.query as { download?: string; version?: string };
      const original = q.version === 'original';
      const key = original ? m.original_key : m.mp3_key;
      if (!key || (!original && m.status !== 'ready')) return reply.code(404).type('text/plain').send('Not found');
      const download = q.download === '1';
      const kind = original ? originalKind(m.original_mime) : { type: 'audio/mpeg', ext: 'mp3' };
      const filename = `${safeFilePart(m.show_slug)}-${safeFilePart(m.sender_name)}-${m.created_at.slice(0, 10)}${original ? '-original' : ''}.${kind.ext}`;

      if (storage.getSignedUrl) {
        const url = await storage.getSignedUrl(key, 300, {
          contentType: kind.type,
          downloadName: download ? filename : undefined,
        });
        return reply.header('Cache-Control', 'no-store').redirect(url);
      }

      const size = await storage.size(key);
      if (size === null) return reply.code(404).type('text/plain').send('Audio file is missing.');
      const range = parseRange(req.headers.range, size);
      void reply
        .header('Content-Type', kind.type)
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
        return reply.send(await storage.getStream(key, range));
      }
      void reply.header('Content-Length', size);
      return reply.send(await storage.getStream(key));
    }),
  );

  // ---------------------------------------------------------------- settings
  const settingsView = (session: AdminSession, result?: SettingsView['result']): SettingsView => ({
    csrf: session.csrf,
    adminEmail: session.email,
    appUrl: config.appUrl,
    version: appVersion(),
    mail: { provider: config.mail.provider, configured: !!ctx.mailer, from: config.mail.from },
    storage: {
      driver: config.storageDriver,
      location: config.storageDriver === 's3' ? `${config.s3.endpoint || 'AWS S3'} / ${config.s3.bucket}` : config.localStoragePath,
    },
    turnstile: { siteKey: config.turnstile.siteKey },
    limits: {
      rateLimitPerHour: config.rateLimitPerHour,
      rateLimitPerShowHour: config.rateLimitPerShowHour,
      dailyCapPerShow: config.dailyCapPerShow,
      maxUploadMb: config.maxUploadMb,
      maxSecondsDefault: config.maxSecondsDefault,
      retentionDays: config.retentionDays,
      keepOriginals: config.keepOriginals,
      mp3BitrateKbps: config.mp3BitrateKbps,
    },
    backups: {
      settings: loadBackupSettings(repo),
      list: repo.listBackups(15),
      next: nextSlot(loadBackupSettings(repo), new Date())?.toISOString() ?? null,
      storage: storage.name,
      running: backupRunning(),
      dir: backupDir(ctx),
      lastRestore: (() => {
        try {
          const raw = repo.getSetting('last_restore');
          return raw ? (JSON.parse(raw) as NonNullable<SettingsView['backups']['lastRestore']>) : null;
        } catch {
          return null;
        }
      })(),
      importMb: MAX_IMPORT_MB,
    },
    result,
  });

  const BACKUP_FLASH: Record<string, { ok: boolean; message: string }> = {
    started: { ok: true, message: 'Backup started. Reload this page in a moment to see it finish.' },
    saved: { ok: true, message: 'Backup schedule saved.' },
    deleted: { ok: true, message: 'Backup deleted.' },
    running: { ok: false, message: 'A backup is already running.' },
    imported: { ok: true, message: 'Backup added to the list. Choose Restore to use it.' },
    scanned: { ok: true, message: 'Checked the backups folder.' },
  };
  app.get('/settings', ownerAuthed((req, reply, session) => {
    const flash = BACKUP_FLASH[(req.query as { backup?: string }).backup ?? ''];
    return page(reply, settingsPage(settingsView(session, flash ? { section: 'backups', ...flash } : undefined)));
  }));

  app.post(
    '/settings/test-email',
    ownerMutating(async (_req, reply, session) => {
      const to = session.email;
      if (!ctx.mailer || !to) return page(reply, settingsPage(settingsView(session, { section: 'email', ok: false, message: 'Email is not configured. Set MAIL_PROVIDER and its settings in .env.' })));
      try {
        await ctx.mailer.send({ to, subject: 'ListenerLoop test email', text: `This is a test from ${config.appUrl}.\n\nIf you can read this, email alerts will reach you.` });
        return page(reply, settingsPage(settingsView(session, { section: 'email', ok: true, message: `Test email sent to ${to}. Check your inbox (and spam folder).` })));
      } catch (err) {
        ctx.log.error({ err }, 'test email failed');
        const reason = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 300);
        return page(reply, settingsPage(settingsView(session, { section: 'email', ok: false, message: `The test email could not be sent: ${reason}` })));
      }
    }),
  );

  app.post(
    '/settings/test-storage',
    ownerMutating(async (_req, reply, session) => {
      const key = `healthcheck/${ulid()}.txt`;
      const body = Buffer.from('ListenerLoop storage check');
      const steps: string[] = [];
      try {
        await storage.put(key, body, 'text/plain');
        steps.push('Wrote a test file');
        const size = await storage.size(key);
        if (size !== body.length) throw new Error('The test file was not the size that was written');
        const chunks: Buffer[] = [];
        for await (const c of await storage.getStream(key)) chunks.push(c as Buffer);
        if (Buffer.concat(chunks).toString() !== body.toString()) throw new Error('The test file read back differently');
        steps.push('Read it back');
        await storage.delete(key);
        if (await storage.exists(key)) throw new Error('The test file was not deleted');
        steps.push('Deleted it');
        return page(reply, settingsPage(settingsView(session, { section: 'storage', ok: true, message: 'Storage works.', steps })));
      } catch (err) {
        ctx.log.error({ err }, 'storage check failed');
        await storage.delete(key).catch(() => undefined);
        const reason = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 300);
        return page(reply, settingsPage(settingsView(session, { section: 'storage', ok: false, message: `Storage check failed: ${reason}`, steps })));
      }
    }),
  );

  // User management, account and sign-in links live in routes/users.ts
  const renderSettings = (reply: FastifyReply, session: AdminSession, result: NonNullable<SettingsView['result']>, status = 200): FastifyReply => page(reply, settingsPage(settingsView(session, result)), status);
  const kit = { renderSettings, authed, mutating, ownerAuthed, ownerMutating, page, sameOrigin, field, forbidden, accessibleShows, notFound };
  registerUserRoutes(app, ctx, kit);
  registerWebhookRoutes(app, ctx, kit);
  registerExportRoutes(app, ctx, kit);
  registerBackupRoutes(app, ctx, kit);

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
    embed_blurb: '',
    embed_style: 'card',
    accent_color: '#21649E',
    prompt_text: 'Record a message for the show.',
    thanks_text: 'Thank you! Your message was sent.',
    retain_original: false,
    transcribe: false,
    normalize_loudness: false,
    noise_reduction: 'off',
    feed_url: '',
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
    embed_blurb: s.embed_blurb ?? '',
    embed_style: s.embed_style,
    accent_color: s.accent_color,
    prompt_text: s.prompt_text,
    thanks_text: s.thanks_text,
    retain_original: s.retain_original === 1,
    transcribe: s.transcribe === 1,
    normalize_loudness: s.normalize_loudness === 1,
    noise_reduction: s.noise_reduction,
    feed_url: s.feed_url ?? '',
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
    embed_blurb: cleanText(field(body, 'embed_blurb'), 240),
    embed_style: field(body, 'embed_style') === 'button' ? 'button' : 'card',
    accent_color: field(body, 'accent_color'),
    prompt_text: cleanText(field(body, 'prompt_text'), 300),
    thanks_text: cleanText(field(body, 'thanks_text'), 300),
    retain_original: field(body, 'retain_original') === '1',
    transcribe: field(body, 'transcribe') === '1',
    normalize_loudness: field(body, 'normalize_loudness') === '1',
    feed_url: cleanText(field(body, 'feed_url'), 500),
    noise_reduction: NOISE_REDUCTION_LEVELS.includes(field(body, 'noise_reduction') as NoiseReduction) ? (field(body, 'noise_reduction') as NoiseReduction) : 'off',
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
    if (!v.notify_email) errors.push("The show's email address is required. Alerts go there, and listener replies use it as the Reply-To address.");
    else if (!isValidEmail(v.notify_email)) errors.push('The show email address does not look right.');
    const feed = checkFeedUrl(v.feed_url);
    if ('error' in feed) errors.push(feed.error);
    const maxSeconds = Number.parseInt(v.max_seconds, 10);
    if (!Number.isInteger(maxSeconds) || maxSeconds < 5 || maxSeconds > MAX_SECONDS_LIMIT) {
      errors.push(`Maximum length must be between 5 and ${MAX_SECONDS_LIMIT} seconds.`);
    }
    if (!HEX_COLOR.test(v.accent_color)) errors.push('Accent color must be a hex color like #21649E.');
    let slug = existing?.slug;
    if (existing) {
      slug = slugify(v.slug);
      const taken = repo.getShowBySlug(slug);
      if (RESERVED_SLUGS.includes(slug) || (taken && taken.id !== existing.id)) errors.push('That URL slug is already used by another show.');
    }

    return {
      errors,
      fields: {
        name: v.name,
        ...(slug ? { slug } : {}),
        allowed_origins: JSON.stringify(origins),
        notify_email: v.notify_email,
        max_seconds: maxSeconds,
        ask_email: v.ask_email ? 1 : 0,
        consent_text: v.consent_text,
        button_label: v.button_label,
        embed_blurb: v.embed_blurb || null,
        embed_style: v.embed_style,
        accent_color: v.accent_color,
        prompt_text: v.prompt_text,
        thanks_text: v.thanks_text,
        retain_original: v.retain_original ? 1 : 0,
        transcribe: v.transcribe ? 1 : 0,
        normalize_loudness: v.normalize_loudness ? 1 : 0,
        noise_reduction: v.noise_reduction,
        feed_url: 'url' in feed && feed.url ? feed.url : null,
      },
    };
  };

  app.get(
    '/shows',
    ownerAuthed((req, reply, session) => {
      const flash = FLASH[(req.query as { flash?: string }).flash ?? ''];
      return page(reply, showsPage(accessibleShows(session), config.appUrl, session.csrf, flash));
    }),
  );

  app.get(
    '/shows/new',
    ownerAuthed((_req, reply, session) =>
      page(reply, showFormPage({ csrf: session.csrf, show: null, values: blankValues(), errors: [], maxSecondsLimit: MAX_SECONDS_LIMIT, transcriptionOn: transcriptionAvailable(ctx) })),
    ),
  );

  app.post(
    '/shows',
    ownerMutating(async (req, reply, session) => {
      const values = valuesFromBody(req.body, blankValues());
      const { errors, fields } = parseShowForm(req.body, values, null);
      if (errors.length) {
        return page(reply, showFormPage({ csrf: session.csrf, show: null, values, errors, maxSecondsLimit: MAX_SECONDS_LIMIT, transcriptionOn: transcriptionAvailable(ctx) }), 400);
      }
      const created = repo.createShow({ ...(fields as Omit<typeof fields, 'name'>), name: values.name });
      if (created.feed_url) {
        const cover = await refreshCover(ctx, created);
        if (!cover.ok) return reply.redirect(`/shows/${created.slug}/settings?flash=coverfail`);
      }
      return reply.redirect('/shows?flash=created');
    }),
  );

  app.get(
    '/shows/:slug',
    authed((req, reply, session) => {
      const show = showFor(req, session);
      return show ? renderInbox(req, reply, session, show) : notFound(reply);
    }),
  );

  app.get(
    '/shows/:slug/settings',
    ownerAuthed((req, reply, session) => {
      const show = showFor(req, session);
      if (!show) return notFound(reply);
      const flash = FLASH[(req.query as { flash?: string }).flash ?? ''];
      return page(reply, showFormPage({ csrf: session.csrf, show, values: valuesFromShow(show), errors: [], maxSecondsLimit: MAX_SECONDS_LIMIT, transcriptionOn: transcriptionAvailable(ctx), flash }));
    }),
  );

  app.post(
    '/shows/:slug/settings',
    ownerMutating(async (req, reply, session) => {
      const show = showFor(req, session);
      if (!show) return notFound(reply);
      const values = valuesFromBody(req.body, valuesFromShow(show));
      const { errors, fields } = parseShowForm(req.body, values, show);
      if (errors.length) {
        return page(reply, showFormPage({ csrf: session.csrf, show, values, errors, maxSecondsLimit: MAX_SECONDS_LIMIT, transcriptionOn: transcriptionAvailable(ctx) }), 400);
      }
      repo.updateShow(show.id, fields);
      if ((fields.feed_url ?? null) !== (show.feed_url ?? null)) {
        const updated = repo.getShow(show.id)!;
        if (!updated.feed_url) await clearCover(ctx, updated);
        else if (!(await refreshCover(ctx, updated)).ok) return reply.redirect(`/shows/${updated.slug}/settings?flash=coverfail`);
      }
      return reply.redirect('/shows?flash=saved');
    }),
  );

  app.get(
    '/shows/:slug/cover',
    authed(async (req, reply, session) => {
      const show = showFor(req, session);
      if (!show || !show.cover_key) return notFound(reply);
      if ((await ctx.storage.size(show.cover_key)) === null) return notFound(reply);
      return reply
        .header('content-type', 'image/jpeg')
        .header('cache-control', 'private, max-age=86400')
        .header('x-content-type-options', 'nosniff')
        .send(await ctx.storage.getStream(show.cover_key));
    }),
  );

  app.post(
    '/shows/:slug/cover/refresh',
    ownerMutating(async (req, reply, session) => {
      const show = showFor(req, session);
      if (!show) return notFound(reply);
      const result = show.feed_url ? await refreshCover(ctx, show) : { ok: false as const, error: '' };
      return reply.redirect(`/shows/${show.slug}/settings?flash=${result.ok ? 'coverok' : 'coverfail'}`);
    }),
  );

  app.post(
    '/shows/:slug/rotate-key',
    ownerMutating((req, reply, session) => {
      const show = showFor(req, session);
      if (!show) return notFound(reply);
      repo.rotateSiteKey(show.id);
      return reply.redirect('/shows?flash=rotated');
    }),
  );
}

export { normalizeOrigin };
