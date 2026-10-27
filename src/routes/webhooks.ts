import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { WEBHOOK_EVENTS, type Show, type WebhookEvent } from '../db/repo.js';
import { checkWebhookUrl, isEvent, MAX_WEBHOOKS_PER_SHOW, sendTest } from '../webhook.js';
import { webhooksPage } from '../views/webhooks.js';
import type { AdminSession } from '../auth.js';
import type { RouteKit } from './users.js';

export function registerWebhookRoutes(app: FastifyInstance, ctx: AppContext, kit: RouteKit): void {
  const { repo, config } = ctx;
  const { ownerAuthed, ownerMutating, page, field, notFound } = kit;

  const showOf = (req: FastifyRequest, session: AdminSession): Show | undefined => {
    const { slug } = req.params as { slug: string };
    return kit.accessibleShows(session).find((s) => s.slug === slug);
  };
  const view = (reply: FastifyReply, session: AdminSession, show: Show, notice?: { ok: boolean; message: string }, status = 200): FastifyReply => {
    const hooks = repo.listWebhooks(show.id).map((h) => ({ ...h, deliveries: repo.recentDeliveries(h.id) }));
    return page(reply, webhooksPage({ csrf: session.csrf, show, hooks, canAdd: hooks.length < MAX_WEBHOOKS_PER_SHOW, notice }), status);
  };
  /** The hook named in the address, only if it belongs to the show in the address. */
  const hookOf = (req: FastifyRequest, show: Show) => {
    const hook = repo.getWebhook((req.params as { hid: string }).hid);
    return hook && hook.show_id === show.id ? hook : undefined;
  };

  app.get('/shows/:slug/webhooks', ownerAuthed((req, reply, session) => {
    const show = showOf(req, session);
    return show ? view(reply, session, show) : notFound(reply);
  }));

  app.post('/shows/:slug/webhooks', ownerMutating((req, reply, session) => {
    const show = showOf(req, session);
    if (!show) return notFound(reply);
    if (repo.listWebhooks(show.id).length >= MAX_WEBHOOKS_PER_SHOW) return view(reply, session, show, { ok: false, message: 'This show already has the most webhooks allowed.' }, 400);
    const checked = checkWebhookUrl(field(req.body, 'url'), config.feedAllowPrivate);
    if ('error' in checked) return view(reply, session, show, { ok: false, message: checked.error }, 400);
    const raw = (req.body as Record<string, unknown>).events;
    const events = [...new Set((Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []).filter((e): e is WebhookEvent => typeof e === 'string' && isEvent(e)))];
    if (!events.length) return view(reply, session, show, { ok: false, message: `Choose at least one event (${WEBHOOK_EVENTS.length} are available).` }, 400);
    repo.createWebhook(show.id, checked.url, events);
    return view(reply, session, show, { ok: true, message: 'Webhook added. Use "Send a test" to check your server.' });
  }));

  app.post('/shows/:slug/webhooks/:hid/test', ownerMutating(async (req, reply, session) => {
    const show = showOf(req, session);
    const hook = show && hookOf(req, show);
    if (!show || !hook) return notFound(reply);
    const r = await sendTest(ctx, hook.id);
    return view(reply, session, show, { ok: r.ok, message: r.ok ? `Test sent. ${r.message}` : `The test failed: ${r.message}` });
  }));

  app.post('/shows/:slug/webhooks/:hid/toggle', ownerMutating((req, reply, session) => {
    const show = showOf(req, session);
    const hook = show && hookOf(req, show);
    if (!show || !hook) return notFound(reply);
    repo.updateWebhook(hook.id, { enabled: hook.enabled ? 0 : 1 });
    return view(reply, session, show, { ok: true, message: hook.enabled ? 'Turned off.' : 'Turned on.' });
  }));

  app.post('/shows/:slug/webhooks/:hid/secret', ownerMutating((req, reply, session) => {
    const show = showOf(req, session);
    const hook = show && hookOf(req, show);
    if (!show || !hook) return notFound(reply);
    repo.updateWebhook(hook.id, { secret: `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url')}` });
    return view(reply, session, show, { ok: true, message: 'New secret made. Update your server to use it.' });
  }));

  app.post('/shows/:slug/webhooks/:hid/delete', ownerMutating((req, reply, session) => {
    const show = showOf(req, session);
    const hook = show && hookOf(req, show);
    if (!show || !hook) return notFound(reply);
    repo.deleteWebhook(hook.id);
    return view(reply, session, show, { ok: true, message: 'Webhook deleted.' });
  }));
}
