import { html, raw, type Raw } from '../lib/html.js';
import { INBOX_FILTERS, showOrigins, type InboxFilter, type MessageWithShow, type Show } from '../db/repo.js';
import { csrfField, durationText, layout, timeTag } from './layout.js';

const FILTER_LABELS: Record<InboxFilter, string> = {
  inbox: 'Inbox',
  new: 'New',
  starred: 'Starred',
  archived: 'Archived',
  failed: 'Failed',
  all: 'All',
};

// ---------------------------------------------------------------- login
export function loginPage(error?: string): string {
  return layout({
    title: 'Sign in',
    body: html`<section class="card narrow">
      <h1>Sign in</h1>
      ${error ? html`<p class="alert" role="alert">${error}</p>` : ''}
      <form method="post" action="/admin/login" class="stack">
        <label>Email<input type="email" name="email" autocomplete="username" required autofocus></label>
        <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
        <button type="submit" class="btn primary">Sign in</button>
      </form>
    </section>`,
  });
}

// ---------------------------------------------------------------- inbox
export function messageRow(m: MessageWithShow): Raw {
  const unread = m.status === 'ready' && !m.read_at;
  return html`<li id="row-${m.id}" class="msg${unread ? ' unread' : ''}">
    <button class="star${m.starred ? ' on' : ''}" hx-post="/admin/messages/${m.id}/star" hx-target="#row-${m.id}" hx-swap="outerHTML"
      aria-label="${m.starred ? 'Remove star' : 'Star message'}" aria-pressed="${m.starred ? 'true' : 'false'}">${m.starred ? '★' : '☆'}</button>
    <a class="msg-main" href="/admin/messages/${m.id}">
      <span class="who">${m.sender_name}${unread ? html` <span class="badge new">new</span>` : ''}${m.status === 'failed' ? html` <span class="badge bad">failed</span>` : ''}${m.status === 'processing' ? html` <span class="badge">processing</span>` : ''}</span>
      <span class="meta">${m.show_name}${m.duration_seconds !== null ? ` · ${durationText(m.duration_seconds)}` : ''} · ${timeTag(m.created_at)}</span>
    </a>
    <span class="row-actions">
      <button class="link" hx-post="/admin/messages/${m.id}/archive" hx-target="#row-${m.id}" hx-swap="outerHTML">${m.archived ? 'Unarchive' : 'Archive'}</button>
      <button class="link danger" hx-post="/admin/messages/${m.id}/delete" hx-target="#row-${m.id}" hx-swap="outerHTML"
        hx-confirm="Delete this message?">Delete</button>
    </span>
  </li>`;
}

export interface InboxView {
  csrf: string;
  messages: MessageWithShow[];
  filter: InboxFilter;
  showId?: string;
  shows: Show[];
  counts: Record<InboxFilter, number>;
  page: number;
  pages: number;
  total: number;
}

function inboxUrl(filter: InboxFilter, showId: string | undefined, page: number): string {
  const q = new URLSearchParams();
  if (filter !== 'inbox') q.set('filter', filter);
  if (showId) q.set('show', showId);
  if (page > 1) q.set('page', String(page));
  const s = q.toString();
  return `/admin/inbox${s ? `?${s}` : ''}`;
}

export function inboxPage(v: InboxView): string {
  return layout({
    title: 'Inbox',
    csrf: v.csrf,
    nav: 'inbox',
    body: html`<h1>Messages</h1>
    <div class="toolbar">
      <div class="tabs" role="tablist" aria-label="Filter messages">
        ${INBOX_FILTERS.map(
          (f) => html`<a href="${inboxUrl(f, v.showId, 1)}" class="tab${f === v.filter ? ' active' : ''}" ${f === v.filter ? raw('aria-current="page"') : ''}>${FILTER_LABELS[f]} <span class="count">${v.counts[f]}</span></a>`,
        )}
      </div>
      ${v.shows.length > 1
        ? html`<form method="get" action="/admin/inbox" class="inline">
            ${v.filter !== 'inbox' ? html`<input type="hidden" name="filter" value="${v.filter}">` : ''}
            <label class="sr-only" for="show-filter">Show</label>
            <select id="show-filter" name="show" data-autosubmit>
              <option value="">All shows</option>
              ${v.shows.map((s) => html`<option value="${s.id}" ${s.id === v.showId ? raw('selected') : ''}>${s.name}</option>`)}
            </select>
            <noscript><button class="btn" type="submit">Apply</button></noscript>
          </form>`
        : ''}
    </div>
    ${v.messages.length === 0
      ? html`<p class="empty">${v.shows.length === 0 ? html`No shows yet. <a href="/admin/shows/new">Add your first show</a> to get an embed snippet.` : 'No messages here.'}</p>`
      : html`<ul class="msgs">${v.messages.map(messageRow)}</ul>`}
    ${v.pages > 1
      ? html`<nav class="pager" aria-label="Pages">
          ${v.page > 1 ? html`<a href="${inboxUrl(v.filter, v.showId, v.page - 1)}">&larr; Newer</a>` : html`<span></span>`}
          <span>Page ${v.page} of ${v.pages}</span>
          ${v.page < v.pages ? html`<a href="${inboxUrl(v.filter, v.showId, v.page + 1)}">Older &rarr;</a>` : html`<span></span>`}
        </nav>`
      : ''}`,
  });
}

// ---------------------------------------------------------------- message
export function messagePage(m: MessageWithShow, csrf: string, flash?: string): string {
  return layout({
    title: `Message from ${m.sender_name}`,
    csrf,
    nav: 'inbox',
    body: html`<p><a href="/admin/inbox">&larr; Back to messages</a></p>
    <h1>${m.sender_name}</h1>
    ${flash ? html`<p class="notice" role="status">${flash}</p>` : ''}
    <section class="card">
      ${m.status === 'ready'
        ? html`<audio controls preload="metadata" src="/admin/messages/${m.id}/audio" data-player></audio>
          <p class="player-tools">
            <label>Speed
              <select data-speed>
                <option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option>
                <option value="1.5">1.5×</option><option value="2">2×</option>
              </select>
            </label>
            <a href="/admin/messages/${m.id}/audio?download=1">Download MP3</a>
          </p>`
        : m.status === 'failed'
          ? html`<p class="alert">This message could not be processed: ${m.error ?? 'unknown error'}.</p>`
          : html`<p class="notice">This message is still being processed. Reload in a moment.</p>`}
      <dl class="details">
        <dt>Show</dt><dd>${m.show_name}</dd>
        <dt>Received</dt><dd>${timeTag(m.created_at)}</dd>
        ${m.duration_seconds !== null ? html`<dt>Length</dt><dd>${durationText(m.duration_seconds)}</dd>` : ''}
        <dt>Email</dt><dd>${m.sender_email ? html`<a href="mailto:${m.sender_email}">${m.sender_email}</a>` : html`<span class="muted">Not shared</span>`}</dd>
        ${m.size_bytes !== null ? html`<dt>Size</dt><dd>${(m.size_bytes / 1024).toFixed(0)} KB</dd>` : ''}
      </dl>
      <div class="actions">
        <form method="post" action="/admin/messages/${m.id}/star">${csrfField(csrf)}<button class="btn">${m.starred ? '★ Starred' : '☆ Star'}</button></form>
        <form method="post" action="/admin/messages/${m.id}/archive">${csrfField(csrf)}<button class="btn">${m.archived ? 'Unarchive' : 'Archive'}</button></form>
        <form method="post" action="/admin/messages/${m.id}/delete" data-confirm="Delete this message?">${csrfField(csrf)}<button class="btn danger">Delete</button></form>
      </div>
    </section>
    <section class="card">
      <h2>Private notes</h2>
      <form method="post" action="/admin/messages/${m.id}/notes" class="stack">
        ${csrfField(csrf)}
        <label class="sr-only" for="notes">Notes</label>
        <textarea id="notes" name="notes" rows="4" maxlength="4000">${m.notes ?? ''}</textarea>
        <button class="btn" type="submit">Save notes</button>
      </form>
    </section>`,
  });
}

// ---------------------------------------------------------------- shows
export function embedSnippet(appUrl: string, siteKey: string): string {
  return `<script src="${appUrl}/embed.js" data-site-key="${siteKey}" async></script>`;
}

export function showsPage(shows: Show[], appUrl: string, csrf: string, flash?: string): string {
  return layout({
    title: 'Shows',
    csrf,
    nav: 'shows',
    body: html`<div class="head-row"><h1>Shows</h1><a class="btn primary" href="/admin/shows/new">Add show</a></div>
    ${flash ? html`<p class="notice" role="status">${flash}</p>` : ''}
    ${shows.length === 0 ? html`<p class="empty">No shows yet.</p>` : ''}
    ${shows.map((s) => {
      const origins = showOrigins(s);
      return html`<section class="card">
        <div class="head-row"><h2>${s.name}</h2><a href="/admin/shows/${s.id}">Edit</a></div>
        <p class="muted">Allowed sites: ${origins.length ? origins.join(', ') : 'none yet. The widget cannot be embedded until you add one.'}</p>
        <label class="stack">Embed code
          <textarea readonly rows="2" data-select-on-focus>${embedSnippet(appUrl, s.site_key)}</textarea>
        </label>
        <div class="actions">
          <button type="button" class="btn" data-copy="${embedSnippet(appUrl, s.site_key)}">Copy embed code</button>
          <form method="post" action="/admin/shows/${s.id}/rotate-key" data-confirm="Rotate the site key? Embeds using the old key stop working.">${csrfField(csrf)}<button class="btn" type="submit">Rotate key</button></form>
        </div>
      </section>`;
    })}`,
  });
}

export interface ShowFormValues {
  name: string;
  slug: string;
  allowed_origins: string;
  notify_email: string;
  max_seconds: string;
  ask_email: boolean;
  consent_text: string;
  button_label: string;
  accent_color: string;
  prompt_text: string;
  thanks_text: string;
  retain_original: boolean;
  turnstile_site_key: string;
  has_turnstile_secret: boolean;
}

export function showFormPage(opts: {
  csrf: string;
  show: Show | null;
  values: ShowFormValues;
  errors: string[];
  maxSecondsLimit: number;
}): string {
  const { values: v, show } = opts;
  return layout({
    title: show ? `Edit ${show.name}` : 'Add show',
    csrf: opts.csrf,
    nav: 'shows',
    body: html`<p><a href="/admin/shows">&larr; Back to shows</a></p>
    <h1>${show ? `Edit ${show.name}` : 'Add show'}</h1>
    ${opts.errors.length ? html`<div class="alert" role="alert"><ul>${opts.errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ''}
    <form method="post" action="${show ? `/admin/shows/${show.id}` : '/admin/shows'}" class="card stack">
      ${csrfField(opts.csrf)}
      <label>Show name<input name="name" value="${v.name}" required maxlength="100"></label>
      ${show ? html`<label>URL slug<input name="slug" value="${v.slug}" required maxlength="48" pattern="[a-z0-9]+(-[a-z0-9]+)*"></label>` : ''}
      <label>Sites allowed to embed the widget
        <textarea name="allowed_origins" rows="3" placeholder="https://example.com">${v.allowed_origins}</textarea>
        <small>One address per line, like https://randyunscripted.com. Include www if your site uses it.</small>
      </label>
      <label>Notification email<input type="email" name="notify_email" value="${v.notify_email}" placeholder="Defaults to your admin email"></label>
      <label>Maximum message length (seconds)<input type="number" name="max_seconds" value="${v.max_seconds}" min="5" max="${opts.maxSecondsLimit}" required></label>
      <label>Button label<input name="button_label" value="${v.button_label}" maxlength="60"></label>
      <label>Prompt text<input name="prompt_text" value="${v.prompt_text}" maxlength="300"></label>
      <label>Thank-you message<input name="thanks_text" value="${v.thanks_text}" maxlength="300"></label>
      <label>Consent notice<textarea name="consent_text" rows="2" maxlength="500">${v.consent_text}</textarea>
        <small>Listeners must tick this before sending. Leave it empty to remove the checkbox.</small></label>
      <label>Accent color<input type="color" name="accent_color" value="${v.accent_color}"></label>
      <label class="check"><input type="checkbox" name="ask_email" value="1" ${v.ask_email ? raw('checked') : ''}> Show the optional email field</label>
      <label class="check"><input type="checkbox" name="retain_original" value="1" ${v.retain_original ? raw('checked') : ''}> Keep the original recording next to the MP3</label>
      <fieldset>
        <legend>Turnstile override (optional)</legend>
        <p class="muted">Leave these empty to use the app-wide Turnstile key. If you set your own, it must allow this app's domain.</p>
        <label>Site key<input name="turnstile_site_key" value="${v.turnstile_site_key}" autocomplete="off"></label>
        <label>Secret key<input type="password" name="turnstile_secret_key" autocomplete="off" placeholder="${v.has_turnstile_secret ? 'Saved. Leave blank to keep it.' : ''}"></label>
        ${v.has_turnstile_secret ? html`<label class="check"><input type="checkbox" name="clear_turnstile" value="1"> Remove the override and use the app-wide key</label>` : ''}
      </fieldset>
      <button class="btn primary" type="submit">${show ? 'Save changes' : 'Create show'}</button>
    </form>`,
  });
}
