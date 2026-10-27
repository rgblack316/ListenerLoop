import http from 'node:http';
import https from 'node:https';
import { createHmac } from 'node:crypto';
import type { AppContext } from './context.js';
import type { MessageWithShow, Reply, WebhookEvent } from './db/repo.js';
import { WEBHOOK_EVENTS } from './db/repo.js';
import { checkUrl, FetchError, guardedLookup } from './feed.js';

export const MAX_WEBHOOKS_PER_SHOW = 3;
export const MAX_ATTEMPTS = 5;
/** Wait before attempt 2, 3, 4 and 5. */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
const TIMEOUT_MS = 10_000;

export const EVENT_LABELS: Record<WebhookEvent, string> = {
  'message.ready': 'A new message is ready',
  'message.transcribed': 'A transcript is finished',
  'reply.sent': 'A reply was sent',
};

/** An address from a form: https only (http only when tests allow local addresses), no login in it. */
export function checkWebhookUrl(raw: string, allowPrivate = false): { url: string } | { error: string } {
  const value = raw.trim();
  if (!value) return { error: 'Enter the address to send to.' };
  if (value.length > 500) return { error: 'That address is too long.' };
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) return { error: 'The address must start with https://' };
    checkUrl(value, allowPrivate);
    return { url: u.toString() };
  } catch (err) {
    return { error: err instanceof FetchError ? err.message : 'That does not look like a web address.' };
  }
}

export const signature = (secret: string, timestamp: string, body: string): string =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

interface PostResult {
  status: number;
}

/** POST once to a public address. Redirects are not followed; the reply body is read only to be dropped. */
function postOnce(urlText: string, body: string, headers: Record<string, string>, allowPrivate: boolean): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = checkUrl(urlText, allowPrivate);
    } catch (err) {
      return reject(err);
    }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      { method: 'POST', lookup: guardedLookup(allowPrivate), headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) } },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        res.on('error', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new FetchError('The server took too long to answer.')));
    req.on('error', (e) => reject(e instanceof FetchError ? e : new FetchError(`Could not connect: ${e.message}`)));
    req.end(body);
  });
}

async function send(ctx: AppContext, url: string, secret: string, deliveryId: string, event: string, body: string): Promise<PostResult> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return postOnce(
    url,
    body,
    {
      'content-type': 'application/json',
      'user-agent': 'ListenerLoop-Webhook/1.0',
      'x-listenerloop-event': event,
      'x-listenerloop-delivery': deliveryId,
      'x-listenerloop-timestamp': timestamp,
      'x-listenerloop-signature': signature(secret, timestamp, body),
    },
    ctx.config.feedAllowPrivate,
  );
}

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 300);

// ---------------------------------------------------------------- payloads
function showPart(m: MessageWithShow): { id: string; slug: string; name: string } {
  return { id: m.show_id, slug: m.show_slug, name: m.show_name };
}

export function messagePayload(ctx: AppContext, event: WebhookEvent, m: MessageWithShow, reply?: Reply): Record<string, unknown> {
  return {
    event,
    created_at: new Date().toISOString(),
    show: showPart(m),
    message: {
      id: m.id,
      received_at: m.created_at,
      name: m.sender_name,
      email: m.sender_email,
      duration_seconds: m.duration_seconds,
      transcript: m.transcript_status === 'done' ? m.transcript : null,
      starred: !!m.starred,
      admin_url: `${ctx.config.appUrl}/shows/${m.show_slug}/messages/${m.id}`,
    },
    ...(reply ? { reply: { id: reply.id, subject: reply.subject, to: reply.to_email, sent_at: new Date().toISOString() } } : {}),
  };
}

// ---------------------------------------------------------------- queue and delivery
const inflight = new Set<Promise<void>>();

/** Tests: resolves when every delivery started so far has finished. */
export async function webhooksIdle(): Promise<void> {
  while (inflight.size) await Promise.allSettled([...inflight]);
}

/** Records a delivery for each enabled webhook of the show that listens for the event, and starts sending. */
export function fireWebhooks(ctx: AppContext, showId: string, event: WebhookEvent, payload: Record<string, unknown>): void {
  try {
    const hooks = ctx.repo.listWebhooks(showId).filter((h) => h.enabled && (JSON.parse(h.events) as string[]).includes(event));
    if (!hooks.length) return;
    for (const h of hooks) ctx.repo.enqueueDelivery(h.id, event, JSON.stringify(payload));
    const p: Promise<void> = deliverDue(ctx).then(() => undefined).finally(() => inflight.delete(p));
    inflight.add(p);
  } catch (err) {
    ctx.log.warn({ err }, 'could not queue webhooks');
  }
}

let running = false;

/** Attempts every delivery that is due. Failed attempts are rescheduled with a growing delay, up to five attempts. */
export async function deliverDue(ctx: AppContext): Promise<number> {
  if (running) return 0;
  running = true;
  let handled = 0;
  try {
    for (;;) {
      const due = ctx.repo.dueDeliveries();
      if (!due.length) break;
      for (const d of due) {
        handled++;
        if (!d.enabled) {
          ctx.repo.updateDelivery(d.id, { status: 'failed', error: 'The webhook was turned off.', next_attempt_at: null });
          continue;
        }
        const attempts = d.attempts + 1;
        try {
          const res = await send(ctx, d.url, d.secret, d.id, d.event, d.payload);
          if (res.status >= 200 && res.status < 300) {
            ctx.repo.updateDelivery(d.id, { status: 'sent', attempts, response_code: res.status, error: null, next_attempt_at: null, delivered_at: new Date().toISOString() });
            continue;
          }
          throw new FetchError(`The server answered ${res.status}.`, { cause: res.status });
        } catch (err) {
          const code = err instanceof FetchError && typeof err.cause === 'number' ? err.cause : null;
          const final = attempts >= MAX_ATTEMPTS;
          ctx.repo.updateDelivery(d.id, {
            status: final ? 'failed' : 'pending',
            attempts,
            response_code: code,
            error: reason(err),
            next_attempt_at: final ? null : new Date(Date.now() + BACKOFF_MS[attempts - 1]!).toISOString(),
          });
        }
      }
    }
  } finally {
    running = false;
  }
  return handled;
}

/** Sends a sample event straight away and returns what happened, so a new address can be checked. */
export async function sendTest(ctx: AppContext, hookId: string): Promise<{ ok: boolean; message: string }> {
  const hook = ctx.repo.getWebhook(hookId);
  const show = hook ? ctx.repo.getShow(hook.show_id) : undefined;
  if (!hook || !show) return { ok: false, message: 'Webhook not found.' };
  const body = JSON.stringify({ event: 'ping', created_at: new Date().toISOString(), show: { id: show.id, slug: show.slug, name: show.name }, message: 'This is a test from ListenerLoop.' });
  try {
    const res = await send(ctx, hook.url, hook.secret, 'test', 'ping', body);
    return res.status >= 200 && res.status < 300 ? { ok: true, message: `Your server answered ${res.status}.` } : { ok: false, message: `Your server answered ${res.status}.` };
  } catch (err) {
    return { ok: false, message: reason(err) };
  }
}

export const isEvent = (v: string): v is WebhookEvent => (WEBHOOK_EVENTS as readonly string[]).includes(v);
