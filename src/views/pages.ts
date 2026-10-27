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
      <form method="post" action="/login" class="stack">
        <label>Email<input type="email" name="email" autocomplete="username" required autofocus></label>
        <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
        <button type="submit" class="btn primary">Sign in</button>
      </form>
    </section>`,
  });
}

// ---------------------------------------------------------------- inbox
const msgBase = (m: { show_slug: string; id: string }): string => `/shows/${m.show_slug}/messages/${m.id}`;

/** Turn a snippet with \u0001/\u0002 match markers into escaped HTML with <mark> around matches. */
function snippetHtml(snip: string): Raw {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return raw(snip.split('\u0001').map((part, i) => {
    if (i === 0) return esc(part);
    const [hit, rest = ''] = part.split('\u0002');
    return `<mark>${esc(hit ?? '')}</mark>${esc(rest)}`;
  }).join(''));
}

export function messageRow(m: MessageWithShow, snippet?: string): Raw {
  const unread = m.status === 'ready' && !m.read_at;
  return html`<li id="row-${m.id}" class="msg${unread ? ' unread' : ''}">
    <input type="checkbox" class="pick" form="bulk" name="ids" value="${m.id}" aria-label="Select message from ${m.sender_name}" ${m.status === 'ready' ? '' : raw('disabled')}>
    <button class="star${m.starred ? ' on' : ''}" hx-post="${msgBase(m)}/star" hx-target="#row-${m.id}" hx-swap="outerHTML"
      aria-label="${m.starred ? 'Remove star' : 'Star message'}" aria-pressed="${m.starred ? 'true' : 'false'}">${m.starred ? '★' : '☆'}</button>
    <a class="msg-main" href="${msgBase(m)}">
      <span class="who">${m.sender_name}${unread ? html` <span class="badge new">new</span>` : ''}${m.status === 'failed' ? html` <span class="badge bad">failed</span>` : ''}${m.status === 'processing' ? html` <span class="badge">processing</span>` : ''}${m.status === 'ready' && m.email_error ? html` <span class="badge bad">email failed</span>` : ''}</span>
      ${m.status === 'failed' ? html`<span class="meta fail">${m.error ?? 'Processing failed.'}</span>` : ''}
      <span class="meta">${m.show_name}${m.duration_seconds !== null ? ` · ${durationText(m.duration_seconds)}` : ''} · ${timeTag(m.created_at)}</span>
      ${snippet ? html`<span class="snippet">${snippetHtml(snippet)}</span>` : ''}
    </a>
    <span class="row-actions">
      ${m.status === 'failed' && m.original_key ? html`<button class="link" hx-post="${msgBase(m)}/retry" hx-target="#row-${m.id}" hx-swap="outerHTML">Retry</button>` : ''}
      <button class="link" hx-post="${msgBase(m)}/archive" hx-target="#row-${m.id}" hx-swap="outerHTML">${m.archived ? 'Unarchive' : 'Archive'}</button>
      <button class="link danger" hx-post="${msgBase(m)}/delete" hx-target="#row-${m.id}" hx-swap="outerHTML"
        hx-confirm="Delete this message?">Delete</button>
    </span>
  </li>`;
}

export interface InboxView {
  csrf: string;
  messages: MessageWithShow[];
  /** Transcript excerpts with match markers, keyed by message id (search only). */
  snippets: Map<string, string>;
  /** The active search text, or '' when not searching. */
  search: string;
  filter: InboxFilter;
  /** Set for a single show's inbox; omitted for the combined view. */
  show?: Show;
  hasShows: boolean;
  counts: Record<InboxFilter, number>;
  page: number;
  pages: number;
  total: number;
}

const inboxBase = (show?: Show): string => (show ? `/shows/${show.slug}` : '/inbox');

function inboxUrl(show: Show | undefined, filter: InboxFilter, page: number, search = ''): string {
  const q = new URLSearchParams();
  if (search) q.set('q', search);
  else if (filter !== 'inbox') q.set('filter', filter);
  if (page > 1) q.set('page', String(page));
  const s = q.toString();
  return `${inboxBase(show)}${s ? `?${s}` : ''}`;
}

export function inboxPage(v: InboxView): string {
  return layout({
    title: v.show ? v.show.name : 'All messages',
    csrf: v.csrf,
    nav: v.show ? 'shows' : 'inbox',
    body: html`${v.show ? html`<p><a href="/">&larr; All shows</a></p>` : ''}
    <div class="head-row">
      <h1>${v.show ? v.show.name : 'All messages'}</h1>
      ${v.show ? html`<a href="/shows/${v.show.slug}/settings">Settings and embed code</a>` : ''}
    </div>
    <div class="toolbar">
      ${v.search
        ? html`<p class="search-status">${v.total} ${v.total === 1 ? 'result' : 'results'} for &ldquo;${v.search}&rdquo; &middot; <a href="${inboxUrl(v.show, 'inbox', 1)}">Clear search</a></p>`
        : html`<div class="tabs" role="tablist" aria-label="Filter messages">
        ${INBOX_FILTERS.map(
          (f) => html`<a href="${inboxUrl(v.show, f, 1)}" class="tab${f === v.filter ? ' active' : ''}" ${f === v.filter ? raw('aria-current="page"') : ''}>${FILTER_LABELS[f]} <span class="count">${v.counts[f]}</span></a>`,
        )}
      </div>`}
      <form class="search" method="get" action="${inboxBase(v.show)}" role="search">
        <input type="search" name="q" value="${v.search}" placeholder="Search name, email, notes, transcript" aria-label="Search messages" maxlength="200">
        <button type="submit">Search</button>
      </form>
    </div>
    ${v.messages.length > 0
      ? html`<form id="bulk" class="bulk" method="post" action="${inboxBase(v.show)}/download">
          ${csrfField(v.csrf)}
          <label class="check"><input type="checkbox" data-pick-all> Select all on this page</label>
          <button class="btn" data-bulk-button>Download selected (.zip)</button>
        </form>`
      : ''}
    ${v.messages.length === 0
      ? html`<p class="empty">${!v.hasShows ? html`No shows yet. <a href="/shows/new">Add your first show</a> to get an embed snippet.` : v.search ? 'No messages match that search.' : 'No messages here.'}</p>`
      : html`<ul class="msgs">${v.messages.map((m) => messageRow(m, v.snippets.get(m.id)))}</ul>`}
    ${v.pages > 1
      ? html`<nav class="pager" aria-label="Pages">
          ${v.page > 1 ? html`<a href="${inboxUrl(v.show, v.filter, v.page - 1, v.search)}">&larr; Newer</a>` : html`<span></span>`}
          <span>Page ${v.page} of ${v.pages}</span>
          ${v.page < v.pages ? html`<a href="${inboxUrl(v.show, v.filter, v.page + 1, v.search)}">Older &rarr;</a>` : html`<span></span>`}
        </nav>`
      : ''}`,
  });
}

export interface ShowSummary {
  show: Show;
  unread: number;
  total: number;
}

/** Landing page: the shows this user can open, with unread counts. */
export function homePage(shows: ShowSummary[], unreadAll: number, csrf: string): string {
  return layout({
    title: 'Shows',
    csrf,
    nav: 'home',
    body: html`<div class="head-row"><h1>Your shows</h1><a href="/inbox">All messages${unreadAll ? html` <span class="badge new">${unreadAll} new</span>` : ''}</a></div>
    <ul class="msgs">
      ${shows.map(
        ({ show, unread, total }) => html`<li class="msg${unread ? ' unread' : ''}">
          <a class="msg-main" href="/shows/${show.slug}">
            <span class="who">${show.name}${unread ? html` <span class="badge new">${unread} new</span>` : ''}</span>
            <span class="meta">${total} ${total === 1 ? 'message' : 'messages'}</span>
          </a>
        </li>`,
      )}
    </ul>`,
  });
}

// ---------------------------------------------------------------- message
/** Peak heights for the player waveform, as a data attribute the admin script draws. Empty when none. */
function waveformHtml(stored: string | null): Raw | string {
  let peaks: number[] = [];
  try {
    const parsed: unknown = JSON.parse(stored ?? '[]');
    if (Array.isArray(parsed)) peaks = parsed.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)).map((n) => Math.min(100, Math.max(0, Math.round(n)))).slice(0, 400);
  } catch {
    /* no waveform */
  }
  if (peaks.length < 2) return '';
  return html`<div class="wave" data-wave="${peaks.join(',')}" role="img" aria-label="Waveform of the message. Click to jump to a point."></div>`;
}

export function messagePage(m: MessageWithShow, csrf: string, flash?: string, transcriptionOn = false): string {
  return layout({
    title: `Message from ${m.sender_name}`,
    csrf,
    nav: 'shows',
    body: html`<p><a href="/shows/${m.show_slug}">&larr; Back to ${m.show_name}</a></p>
    <h1>${m.sender_name}</h1>
    ${flash ? html`<p class="notice" role="status">${flash}</p>` : ''}
    <section class="card">
      ${m.status === 'ready'
        ? html`${waveformHtml(m.waveform)}<audio controls preload="metadata" src="${msgBase(m)}/audio" data-player></audio>
          <p class="player-tools">
            <label>Speed
              <select data-speed>
                <option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option>
                <option value="1.5">1.5×</option><option value="2">2×</option>
              </select>
            </label>
            <a href="${msgBase(m)}/audio?download=1">Download MP3</a>
          </p>`
        : m.status === 'failed'
          ? html`<div class="alert"><p>This message could not be processed: ${m.error ?? 'unknown error'}</p>
              ${m.original_key
                ? html`<p>The original recording was saved. If the cause was a setting (for example a length limit), change it on the show's settings page, then retry.</p>
                  <form method="post" action="${msgBase(m)}/retry">${csrfField(csrf)}<button class="btn">Retry processing</button></form>`
                : html`<p>The original recording was not saved, so it cannot be retried.</p>`}
            </div>`
          : html`<p class="notice">This message is still being processed. Reload in a moment.</p>`}
      ${m.status === 'ready' && m.email_error
        ? html`<div class="alert"><p>The email alert for this message could not be sent: ${m.email_error}</p>
            <form method="post" action="${msgBase(m)}/resend-alert">${csrfField(csrf)}<button class="btn">Send the alert again</button></form></div>`
        : ''}
      <dl class="details">
        <dt>Show</dt><dd>${m.show_name}</dd>
        <dt>Received</dt><dd>${timeTag(m.created_at)}</dd>
        ${m.duration_seconds !== null ? html`<dt>Length</dt><dd>${durationText(m.duration_seconds)}</dd>` : ''}
        <dt>Email</dt><dd>${m.sender_email ? html`<a href="mailto:${m.sender_email}">${m.sender_email}</a>` : html`<span class="muted">Not shared</span>`}</dd>
        ${m.size_bytes !== null ? html`<dt>Size</dt><dd>${(m.size_bytes / 1024).toFixed(0)} KB</dd>` : ''}
      </dl>
      <div class="actions">
        <form method="post" action="${msgBase(m)}/star">${csrfField(csrf)}<button class="btn">${m.starred ? '★ Starred' : '☆ Star'}</button></form>
        <form method="post" action="${msgBase(m)}/archive">${csrfField(csrf)}<button class="btn">${m.archived ? 'Unarchive' : 'Archive'}</button></form>
        <form method="post" action="${msgBase(m)}/delete" data-confirm="Delete this message?">${csrfField(csrf)}<button class="btn danger">Delete</button></form>
      </div>
    </section>
    ${m.status === 'ready' && (transcriptionOn || m.transcript_status)
      ? html`<section class="card">
      <h2>Transcript</h2>
      ${m.transcript_status === 'done'
        ? html`${m.transcript ? html`<p class="transcript">${m.transcript}</p>` : html`<p class="muted">No speech was detected.</p>`}
          <p class="player-tools"><a href="${msgBase(m)}/transcript.txt">Download .txt</a>${m.transcript_seconds !== null ? html` <span class="muted">&middot; transcribed in ${durationText(m.transcript_seconds)}</span>` : ''}</p>`
        : m.transcript_status === 'pending'
          ? html`<p class="notice">Transcribing&hellip; this can take a few minutes. Reload to check.</p>`
          : m.transcript_status === 'failed'
            ? html`<div class="alert"><p>The transcript could not be made: ${m.transcript_error ?? 'unknown error'}</p></div>`
            : html`<p class="muted">Not transcribed.</p>`}
      ${transcriptionOn && m.transcript_status !== 'pending'
        ? html`<form method="post" action="${msgBase(m)}/transcribe">${csrfField(csrf)}<button class="btn">${m.transcript_status === 'done' ? 'Transcribe again' : m.transcript_status === 'failed' ? 'Try again' : 'Transcribe this message'}</button></form>`
        : ''}
    </section>`
      : ''}
    <section class="card">
      <h2>Private notes</h2>
      <form method="post" action="${msgBase(m)}/notes" class="stack">
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
    body: html`<div class="head-row"><h1>Shows</h1><a class="btn primary" href="/shows/new">Add show</a></div>
    ${flash ? html`<p class="notice" role="status">${flash}</p>` : ''}
    ${shows.length === 0 ? html`<p class="empty">No shows yet.</p>` : ''}
    ${shows.map((s) => {
      const origins = showOrigins(s);
      return html`<section class="card">
        <div class="head-row"><h2>${s.name}</h2><span><a href="/shows/${s.slug}">Inbox</a> · <a href="/shows/${s.slug}/settings">Settings</a></span></div>
        <p class="muted">Allowed sites: ${origins.length ? origins.join(', ') : 'none yet. The widget cannot be embedded until you add one.'}</p>
        <label class="stack">Embed code
          <textarea readonly rows="2" data-select-on-focus>${embedSnippet(appUrl, s.site_key)}</textarea>
        </label>
        <p class="muted">Hosted page for links in newsletters and social bios: <a href="${appUrl}/s/${s.slug}">${appUrl}/s/${s.slug}</a></p>
        <div class="actions">
          <button type="button" class="btn" data-copy="${embedSnippet(appUrl, s.site_key)}">Copy embed code</button>
          <button type="button" class="btn" data-copy="${appUrl}/s/${s.slug}">Copy hosted page link</button>
          <form method="post" action="/shows/${s.slug}/rotate-key" data-confirm="Rotate the site key? Embeds using the old key stop working.">${csrfField(csrf)}<button class="btn" type="submit">Rotate key</button></form>
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
  transcribe: boolean;
  normalize_loudness: boolean;
  noise_reduction: 'off' | 'light' | 'strong';
}

export function showFormPage(opts: {
  csrf: string;
  show: Show | null;
  values: ShowFormValues;
  errors: string[];
  maxSecondsLimit: number;
  /** Whether the server has transcription switched on (TRANSCRIPTION=whisper). */
  transcriptionOn: boolean;
}): string {
  const { values: v, show } = opts;
  return layout({
    title: show ? `Edit ${show.name}` : 'Add show',
    csrf: opts.csrf,
    nav: 'shows',
    body: html`<p><a href="/shows">&larr; Back to shows</a></p>
    <h1>${show ? `Edit ${show.name}` : 'Add show'}</h1>
    ${opts.errors.length ? html`<div class="alert" role="alert"><ul>${opts.errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ''}
    <div class="show-layout">
    <form method="post" action="${show ? `/shows/${show.slug}/settings` : '/shows'}" class="card stack" data-preview>
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
      <label>Background noise reduction
        <select name="noise_reduction">
          <option value="off" ${v.noise_reduction === 'off' ? raw('selected') : ''}>Off</option>
          <option value="light" ${v.noise_reduction === 'light' ? raw('selected') : ''}>Light: removes rumble and steady hiss</option>
          <option value="strong" ${v.noise_reduction === 'strong' ? raw('selected') : ''}>Stronger: removes more, including changing noise</option>
        </select>
        <small>Applies to new messages only, and cannot be undone on a saved message unless you keep the original recording. Stronger can make voices sound slightly processed.</small>
      </label>
      <label class="check"><input type="checkbox" name="normalize_loudness" value="1" ${v.normalize_loudness ? raw('checked') : ''}> Even out the volume of new messages</label>
      <small class="muted">Quiet and loud callers end up at a similar level. Applies to new messages only. Very noisy recordings can sound noisier.</small>
      <label class="check"><input type="checkbox" name="transcribe" value="1" ${v.transcribe ? raw('checked') : ''}> Transcribe new messages</label>
      ${opts.transcriptionOn ? '' : html`<small class="muted">Transcription is off on this server. Set TRANSCRIPTION=whisper in .env and run update.sh --restart to use it.</small>`}
      <button class="btn primary" type="submit">${show ? 'Save changes' : 'Create show'}</button>
    </form>
    <aside class="preview" aria-label="Preview">
      <h2>Preview</h2>
      <iframe id="preview-frame" src="/static/preview.html" title="Widget preview" loading="lazy"></iframe>
      <p class="muted">Updates as you type. The recorder itself works on your site.</p>
    </aside>
    </div>`,
  });
}

// ---------------------------------------------------------------- settings
export interface SettingsView {
  csrf: string;
  adminEmail: string;
  appUrl: string;
  version: string;
  mail: { provider: string; configured: boolean; from: string };
  storage: { driver: string; location: string };
  turnstile: { siteKey: string };
  limits: { rateLimitPerHour: number; rateLimitPerShowHour: number; dailyCapPerShow: number; maxUploadMb: number; maxSecondsDefault: number; retentionDays: number; keepOriginals: boolean; mp3BitrateKbps: number };
  /** Outcome of the button that was just pressed. */
  result?: { section: 'email' | 'storage' | 'password'; ok: boolean; message: string; steps?: string[] };
}

export function settingsPage(v: SettingsView): string {
  const outcome = (section: 'email' | 'storage' | 'password'): Raw => {
    const r = v.result;
    if (!r || r.section !== section) return raw('');
    return html`<div class="${r.ok ? 'notice' : 'alert'}" role="${r.ok ? 'status' : 'alert'}"><p>${r.message}</p>${r.steps ? html`<ul>${r.steps.map((s) => html`<li>${s}</li>`)}</ul>` : ''}</div>`;
  };
  const yes = (b: boolean): string => (b ? 'Yes' : 'No');
  return layout({
    title: 'Settings',
    csrf: v.csrf,
    nav: 'settings',
    body: html`<h1>Settings</h1>

    <section class="card">
      <h2>Email alerts</h2>
      ${outcome('email')}
      <dl class="details">
        <dt>Provider</dt><dd>${v.mail.provider}${v.mail.configured ? '' : html` <span class="muted">(not configured: alerts are off)</span>`}</dd>
        <dt>Sent from</dt><dd>${v.mail.from || html`<span class="muted">Not set</span>`}</dd>
        <dt>Admin email</dt><dd>${v.adminEmail}</dd>
      </dl>
      <form method="post" action="/settings/test-email">${csrfField(v.csrf)}
        <button class="btn" type="submit" ${v.mail.configured ? '' : raw('disabled')}>Send a test email to ${v.adminEmail}</button>
      </form>
    </section>

    <section class="card">
      <h2>Storage</h2>
      ${outcome('storage')}
      <dl class="details">
        <dt>Driver</dt><dd>${v.storage.driver}</dd>
        <dt>Location</dt><dd>${v.storage.location}</dd>
      </dl>
      <form method="post" action="/settings/test-storage">${csrfField(v.csrf)}
        <button class="btn" type="submit">Test storage</button>
      </form>
      <p class="muted">Writes, reads and deletes a tiny test file to confirm the credentials and permissions work.</p>
    </section>

    <section class="card">
      <h2>Change password</h2>
      ${outcome('password')}
      <form method="post" action="/settings/password" class="stack">${csrfField(v.csrf)}
        <label>Current password<input type="password" name="current" autocomplete="current-password" required></label>
        <label>New password (at least 12 characters)<input type="password" name="next" autocomplete="new-password" minlength="12" required></label>
        <label>Repeat the new password<input type="password" name="confirm" autocomplete="new-password" minlength="12" required></label>
        <button class="btn" type="submit">Change password</button>
        <small>Other signed-in sessions are signed out.</small>
      </form>
    </section>

    <section class="card">
      <h2>Configuration</h2>
      <p class="muted">These come from the server's <code>.env</code> file. After editing it, run <code>sudo ./scripts/update.sh --restart</code>.</p>
      <dl class="details">
        <dt>App address</dt><dd>${v.appUrl}</dd>
        <dt>Version</dt><dd>${v.version}</dd>
        <dt>Turnstile site key</dt><dd>${v.turnstile.siteKey}</dd>
        <dt>Per-IP limit</dt><dd>${v.limits.rateLimitPerHour} per hour</dd>
        <dt>Per-show limit</dt><dd>${v.limits.rateLimitPerShowHour} per hour, ${v.limits.dailyCapPerShow} per day</dd>
        <dt>Largest upload</dt><dd>${v.limits.maxUploadMb} MB</dd>
        <dt>Default message length</dt><dd>${durationText(v.limits.maxSecondsDefault)}</dd>
        <dt>MP3 quality</dt><dd>${v.limits.mp3BitrateKbps} kbps mono</dd>
        <dt>Keep originals</dt><dd>${yes(v.limits.keepOriginals)}</dd>
        <dt>Auto-delete after</dt><dd>${v.limits.retentionDays > 0 ? `${v.limits.retentionDays} days (starred messages are kept)` : 'Never'}</dd>
      </dl>
    </section>`,
  });
}
