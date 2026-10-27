import { esc, html, raw, type Raw } from '../lib/html.js';

export type NavKey = 'home' | 'inbox' | 'shows' | 'settings';

export interface LayoutOptions {
  title: string;
  body: Raw;
  csrf?: string;
  nav?: NavKey;
}

/** Wraps a page body in the admin shell. Pass csrf for signed-in pages so htmx requests carry the token. */
export function layout(opts: LayoutOptions): string {
  const headers = opts.csrf ? JSON.stringify({ 'x-csrf-token': opts.csrf }) : '';
  const nav = opts.csrf
    ? html`<nav class="nav" aria-label="Main">
        <a class="brand" href="/"><img src="/static/brand/ListenerLoop-original-gradient.svg" alt="" width="28" height="28"> ListenerLoop</a>
        <a href="/inbox" ${opts.nav === 'inbox' ? raw('aria-current="page"') : ''}>Inbox</a>
        <a href="/shows" ${opts.nav === 'shows' ? raw('aria-current="page"') : ''}>Shows</a>
        <a href="/settings" ${opts.nav === 'settings' ? raw('aria-current="page"') : ''}>Settings</a>
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
<link rel="stylesheet" href="/static/admin.css">
</head>
<body${headers ? ` hx-headers='${esc(headers)}'` : ''}>
${nav}
<main class="page">
${opts.body}
</main>
<script src="/static/vendor/htmx.min.js"></script>
<script src="/static/admin.js"></script>
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
