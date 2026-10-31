import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { esc, html, raw, type Raw } from '../lib/html.js';

/**
 * A short fingerprint of the admin CSS and script, added to their addresses so a browser always loads the
 * new files after an update instead of reusing a cached older copy.
 */
const ASSET_VERSION = ((): string => {
  try {
    const hash = createHash('sha1');
    for (const f of ['admin.css', 'admin.js']) hash.update(fs.readFileSync(fileURLToPath(new URL(`../../public/${f}`, import.meta.url))));
    return hash.digest('hex').slice(0, 10);
  } catch {
    return String(Date.now());
  }
})();

export type NavKey = 'home' | 'inbox' | 'shows' | 'settings' | 'users' | 'account';

export interface LayoutOptions {
  title: string;
  body: Raw;
  csrf?: string;
  /** The signed-in user's role; decides which menu items appear. */
  role?: 'site_admin' | 'owner' | 'editor' | 'viewer';
  nav?: NavKey;
}

/** Wraps a page body in the admin shell. Pass csrf for signed-in pages so htmx requests carry the token. */
export function layout(opts: LayoutOptions): string {
  const headers = opts.csrf ? JSON.stringify({ 'x-csrf-token': opts.csrf }) : '';
  const nav = opts.csrf
    ? html`<nav class="nav" aria-label="Main">
        <a class="brand" href="/"><img src="/static/brand/ListenerLoop-original-white.svg" alt="" width="30" height="30"> ListenerLoop</a>
        <a href="/inbox" ${opts.nav === 'inbox' ? raw('aria-current="page"') : ''}>Inbox</a>
        ${opts.role === 'site_admin' || opts.role === 'owner' ? html`<a href="/shows" ${opts.nav === 'shows' ? raw('aria-current="page"') : ''}>Shows</a>
        <a href="/users" ${opts.nav === 'users' ? raw('aria-current="page"') : ''}>Users</a>` : ''}
        ${opts.role === 'site_admin' ? html`<a href="/settings" ${opts.nav === 'settings' ? raw('aria-current="page"') : ''}>Settings</a>` : ''}
        <a href="/account" ${opts.nav === 'account' ? raw('aria-current="page"') : ''}>Account</a>
        <form method="post" action="/logout" class="inline">
          <input type="hidden" name="_csrf" value="${opts.csrf}">
          <button type="submit" class="link">Sign out</button>
        </form>
      </nav>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="htmx-config" content='{"allowEval":false,"includeIndicatorStyles":false,"selfRequestsOnly":true}'>
<title>${esc(opts.title)} · ListenerLoop</title>
<link rel="icon" type="image/svg+xml" href="/static/brand/ListenerLoop-original-gradient.svg">
<link rel="stylesheet" href="/static/admin.css?v=${ASSET_VERSION}">
</head>
<body class="${opts.csrf ? 'shell' : 'auth'}"${headers ? ` hx-headers='${esc(headers)}'` : ''}>
${nav}
<main class="page">
${opts.csrf ? '' : '<p class="auth-brand"><img src="/static/brand/ListenerLoop-original-white.svg" alt="" width="40" height="40"> ListenerLoop</p>'}
${opts.body}
</main>
<script src="/static/vendor/htmx.min.js"></script>
<script src="/static/admin.js?v=${ASSET_VERSION}"></script>
</body>
</html>`;
}

export function csrfField(csrf: string): Raw {
  return html`<input type="hidden" name="_csrf" value="${csrf}">`;
}

export function timeTag(iso: string | null): Raw {
  if (!iso) return raw('');
  return html`<time datetime="${iso}" data-local>${iso.replace('T', ' ').slice(0, 16)} UTC</time>`;
}

export function durationText(seconds: number | null): string {
  if (seconds === null) return '';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
