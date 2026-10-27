import { html, raw, type Raw } from '../lib/html.js';
import { WEBHOOK_EVENTS, type Show, type Webhook, type WebhookDelivery, type WebhookEvent } from '../db/repo.js';
import { EVENT_LABELS } from '../webhook.js';
import { csrfField, layout, timeTag } from './layout.js';

export interface WebhooksView {
  csrf: string;
  show: Show;
  hooks: Array<Webhook & { deliveries: WebhookDelivery[] }>;
  canAdd: boolean;
  notice?: { ok: boolean; message: string };
}

const statusBadge = (d: WebhookDelivery): Raw =>
  d.status === 'sent' ? html`<span class="badge">sent</span>` : d.status === 'pending' ? html`<span class="badge">retrying</span>` : html`<span class="badge bad">failed</span>`;

export function webhooksPage(v: WebhooksView): string {
  const s = v.show;
  return layout({
    title: `Webhooks · ${s.name}`,
    csrf: v.csrf,
    role: 'owner',
    nav: 'shows',
    body: html`<p><a href="/shows/${s.slug}/settings">&larr; Back to ${s.name} settings</a></p>
    <h1>Webhooks</h1>
    <p class="muted">ListenerLoop sends a small JSON message to your address when something happens, so other services can react. Each request is signed so you can check it came from here.</p>
    ${v.notice ? html`<div class="${v.notice.ok ? 'notice' : 'alert'}" role="${v.notice.ok ? 'status' : 'alert'}"><p>${v.notice.message}</p></div>` : ''}
    ${v.hooks.map(
      (h) => html`<section class="card">
        <h2>${h.url} ${h.enabled ? '' : html`<span class="badge bad">off</span>`}</h2>
        <dl class="details">
          <dt>Events</dt><dd>${(JSON.parse(h.events) as WebhookEvent[]).map((e) => EVENT_LABELS[e] ?? e).join(', ') || 'None'}</dd>
          <dt>Signing secret</dt><dd><input class="copy-field" type="text" readonly value="${h.secret}" aria-label="Signing secret" data-select-on-focus></dd>
        </dl>
        <div class="actions">
          <form method="post" action="/shows/${s.slug}/webhooks/${h.id}/test">${csrfField(v.csrf)}<button class="btn">Send a test</button></form>
          <form method="post" action="/shows/${s.slug}/webhooks/${h.id}/toggle">${csrfField(v.csrf)}<button class="btn">${h.enabled ? 'Turn off' : 'Turn on'}</button></form>
          <form method="post" action="/shows/${s.slug}/webhooks/${h.id}/secret" data-confirm="Make a new secret? Your server must be updated to use it.">${csrfField(v.csrf)}<button class="btn">New secret</button></form>
          <form method="post" action="/shows/${s.slug}/webhooks/${h.id}/delete" data-confirm="Delete this webhook?">${csrfField(v.csrf)}<button class="btn danger">Delete</button></form>
        </div>
        ${h.deliveries.length
          ? html`<h3>Recent deliveries</h3><ul class="msgs">${h.deliveries.map(
              (d) => html`<li class="msg"><span class="msg-main"><span class="who">${d.event} ${statusBadge(d)}</span>
                <span class="meta">${timeTag(d.created_at)} &middot; ${d.attempts} ${d.attempts === 1 ? 'attempt' : 'attempts'}${d.error ? html` &middot; ${d.error}` : ''}</span></span></li>`,
            )}</ul>`
          : html`<p class="muted">Nothing sent yet.</p>`}
      </section>`,
    )}
    ${v.canAdd
      ? html`<section class="card">
        <h2>Add a webhook</h2>
        <form method="post" action="/shows/${s.slug}/webhooks" class="stack">${csrfField(v.csrf)}
          <label>Address to send to<input type="url" name="url" required maxlength="500" placeholder="https://example.com/listenerloop"></label>
          <fieldset class="checks"><legend>Send when</legend>
            ${WEBHOOK_EVENTS.map((e) => html`<label class="check"><input type="checkbox" name="events" value="${e}" ${e === 'message.ready' ? raw('checked') : ''}> ${EVENT_LABELS[e]}</label>`)}
          </fieldset>
          <button class="btn primary" type="submit">Add webhook</button>
        </form>
      </section>`
      : html`<p class="muted">This show has the most webhooks allowed. Delete one to add another.</p>`}
    <section class="card">
      <h2>What gets sent</h2>
      <p class="muted">A POST with <code>content-type: application/json</code>. Reply with any 2xx status. Failed deliveries are retried up to 5 times over about 3 hours.</p>
      <p class="muted">Headers: <code>X-ListenerLoop-Event</code>, <code>X-ListenerLoop-Delivery</code>, <code>X-ListenerLoop-Timestamp</code> and <code>X-ListenerLoop-Signature</code> (<code>sha256=</code> plus the HMAC-SHA256 of <code>timestamp.body</code> using your secret).</p>
      <pre class="codes">{
  "event": "message.ready",
  "created_at": "2026-10-27T19:20:00.000Z",
  "show": { "id": "...", "slug": "my-show", "name": "My Show" },
  "message": {
    "id": "...", "received_at": "...", "name": "Pat",
    "email": null, "duration_seconds": 42.1,
    "transcript": null, "starred": false,
    "admin_url": "https://.../shows/my-show/messages/..."
  }
}</pre>
    </section>`,
  });
}
