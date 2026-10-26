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
import { purgeMessage } from '../process.js';
import {
  INBOX_FILTERS,
  normalizeOrigin,
  parseOriginList,
  RESERVED_SLUGS,
  showOrigins,
  type InboxFilter,
  type Show,
} from '../db/repo.js';
import { cleanText, encryptSecret, isValidEmail, parseRange, randomToken, safeFilePart, slugify } from '../lib/util.js';
import { homePage, inboxPage, loginPage, messagePage, messageRow, showFormPage, showsPage, type ShowFormValues } from '../views/pages.js';

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

  const isHtmx = (req: FastifyRequest): boolean => req.headers['hx-request'] === 'true';

  // ---------------------------------------------------------------- auth
  app.get('/login', (req, reply) => {
    if (getSession(ctx, req)) return reply.redirect('/');
    return page(reply, loginPage());
  });

  app.post('/login', async (req, reply) => {
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
    return reply.redirect('/');
  });

  app.post(
    '/logout',
    mutating((req, reply) => {
      endSession(ctx, req, reply);
      return reply.redirect('/login');
    }),
  );

  // ---------------------------------------------------------------- home and inboxes
  // Every show the signed-in user may open. Today the single admin sees all shows; when multi-user
  // arrives, this is the one place that narrows the list, and every route below goes through it.
  const accessibleShows = (_session: AdminSession): Show[] => repo.listShows();
  const showFor = (req: FastifyRequest, session: AdminSession): Show | undefined => {
    const { slug } = req.params as { slug: string };
    return accessibleShows(session).find((s) => s.slug === slug);
  };
  const notFound = (reply: FastifyReply): FastifyReply => page(reply, '<p>Not found.</p>', 404);

  app.get(
    '/',
    authed((_req, reply, session) => {
      const shows = accessibleShows(session);
      if (shows.length === 0) return reply.redirect('/shows/new');
      if (shows.length === 1) return reply.redirect(`/shows/${shows[0]!.slug}`);
      const summaries = shows.map((show) => ({
        show,
        unread: repo.countMessages('new', show.id),
        total: repo.countMessages('inbox', show.id),
      }));
      return page(reply, homePage(summaries, repo.countMessages('new'), session.csrf));
    }),
  );

  const renderInbox = (req: FastifyRequest, reply: FastifyReply, session: AdminSession, show?: Show): FastifyReply => {
    const q = req.query as { filter?: string; page?: string };
    const filter: InboxFilter = INBOX_FILTERS.includes(q.filter as InboxFilter) ? (q.filter as InboxFilter) : 'inbox';
    const showId = show?.id;
    const total = repo.countMessages(filter, showId);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const pageNo = Math.min(Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1), pages);
    const messages = repo.listMessages(filter, { showId, limit: PAGE_SIZE, offset: (pageNo - 1) * PAGE_SIZE });
    const counts = Object.fromEntries(INBOX_FILTERS.map((f) => [f, repo.countMessages(f, showId)])) as Record<InboxFilter, number>;
    return page(
      reply,
      inboxPage({ csrf: session.csrf, messages, filter, show, hasShows: accessibleShows(session).length > 0, counts, page: pageNo, pages, total }),
    );
  };

  app.get('/inbox', authed((req, reply, session) => renderInbox(req, reply, session)));

  // ---------------------------------------------------------------- message
  /** A message, only if it belongs to the show in the URL and that show is open to this user. */
  const messageFor = (req: FastifyRequest, session: AdminSession) => {
    const show = showFor(req, session);
    const m = show ? repo.getMessage((req.params as { id: string }).id) : undefined;
    return show && m && m.show_id === show.id ? m : undefined;
  };
  const here = (m: { show_slug: string; id: string }): string => `/shows/${m.show_slug}/messages/${m.id}`;

  app.get(
    '/shows/:slug/messages/:id',
    authed((req, reply, session) => {
      const m = messageFor(req, session);
      if (!m) return notFound(reply);
      if (m.status === 'ready' && !m.read_at) repo.updateMessage(m.id, { read_at: new Date().toISOString() });
      const flash = FLASH[(req.query as { flash?: string }).flash ?? ''];
      return page(reply, messagePage(m, session.csrf, flash));
    }),
  );

  const afterAction = (req: FastifyRequest, reply: FastifyReply, to: string, htmxBody: string): FastifyReply => {
    if (isHtmx(req)) return reply.type('text/html; charset=utf-8').send(htmxBody);
    return reply.redirect(`${to}?flash=saved`);
  };

  app.post(
    '/shows/:slug/messages/:id/star',
    mutating((req, reply, session) => {
      const m = messageFor(req, session);
      if (!m) return notFound(reply);
      repo.updateMessage(m.id, { starred: m.starred ? 0 : 1 });
      return afterAction(req, reply, here(m), messageRow(repo.getMessage(m.id)!).toString());
    }),
  );

  app.post(
    '/shows/:slug/messages/:id/archive',
    mutating((req, reply, session) => {
      const m = messageFor(req, session);
      if (!m) return notFound(reply);
      repo.updateMessage(m.id, { archived: m.archived ? 0 : 1 });
      // In a list, the row leaves the current view; on the detail page we stay put.
      return afterAction(req, reply, here(m), '');
    }),
  );

  app.post(
    '/shows/:slug/messages/:id/delete',
    mutating(async (req, reply, session) => {
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
    '/shows/:slug/messages/:id/notes',
    mutating((req, reply, session) => {
      const m = messageFor(req, session);
      if (!m) return notFound(reply);
      repo.updateMessage(m.id, { notes: field(req.body, 'notes').slice(0, 4000) || null });
      return reply.redirect(`${here(m)}?flash=saved`);
    }),
  );

  app.get(
    '/shows/:slug/messages/:id/audio',
    authed(async (req, reply, session) => {
      const m = messageFor(req, session);
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
      if (RESERVED_SLUGS.includes(slug) || (taken && taken.id !== existing.id)) errors.push('That URL slug is already used by another show.');
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
    '/shows',
    authed((req, reply, session) => {
      const flash = FLASH[(req.query as { flash?: string }).flash ?? ''];
      return page(reply, showsPage(accessibleShows(session), config.appUrl, session.csrf, flash));
    }),
  );

  app.get(
    '/shows/new',
    authed((_req, reply, session) =>
      page(reply, showFormPage({ csrf: session.csrf, show: null, values: blankValues(), errors: [], maxSecondsLimit: MAX_SECONDS_LIMIT })),
    ),
  );

  app.post(
    '/shows',
    mutating((req, reply, session) => {
      const values = valuesFromBody(req.body, blankValues());
      const { errors, fields } = parseShowForm(req.body, values, null);
      if (errors.length) {
        return page(reply, showFormPage({ csrf: session.csrf, show: null, values, errors, maxSecondsLimit: MAX_SECONDS_LIMIT }), 400);
      }
      repo.createShow({ ...(fields as Omit<typeof fields, 'name'>), name: values.name });
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
    authed((req, reply, session) => {
      const show = showFor(req, session);
      if (!show) return notFound(reply);
      return page(reply, showFormPage({ csrf: session.csrf, show, values: valuesFromShow(show), errors: [], maxSecondsLimit: MAX_SECONDS_LIMIT }));
    }),
  );

  app.post(
    '/shows/:slug/settings',
    mutating((req, reply, session) => {
      const show = showFor(req, session);
      if (!show) return notFound(reply);
      const values = valuesFromBody(req.body, valuesFromShow(show));
      const { errors, fields } = parseShowForm(req.body, values, show);
      if (errors.length) {
        return page(reply, showFormPage({ csrf: session.csrf, show, values, errors, maxSecondsLimit: MAX_SECONDS_LIMIT }), 400);
      }
      repo.updateShow(show.id, fields);
      return reply.redirect('/shows?flash=saved');
    }),
  );

  app.post(
    '/shows/:slug/rotate-key',
    mutating((req, reply, session) => {
      const show = showFor(req, session);
      if (!show) return notFound(reply);
      repo.rotateSiteKey(show.id);
      return reply.redirect('/shows?flash=rotated');
    }),
  );
}

export { normalizeOrigin };
