import { html, raw, type Raw } from '../lib/html.js';
import type { Invite, Role, Show, User } from '../db/repo.js';
import { csrfField, layout, timeTag } from './layout.js';

export const ROLE_LABELS: Record<Role, string> = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };
const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything: shows, settings, embed codes and users.',
  editor: 'Listen, star, archive, delete, reply, transcribe and download on assigned shows.',
  viewer: 'Listen, read and download on assigned shows. Cannot change anything.',
};

export interface Notice {
  ok: boolean;
  message: string;
  /** A sign-in link the owner can copy; shown once because only its hash is stored. */
  link?: string;
}

const noticeHtml = (n?: Notice): Raw =>
  n
    ? html`<div class="${n.ok ? 'notice' : 'alert'}" role="${n.ok ? 'status' : 'alert'}"><p>${n.message}</p>${n.link ? html`<p><input class="copy-field" type="text" readonly value="${n.link}" aria-label="Link" data-select-on-focus></p><p class="muted">This link is only shown now. It stops working after 7 days or once used.</p>` : ''}</div>`
    : raw('');

const roleOptions = (current?: Role): Raw =>
  html`${(['editor', 'viewer', 'owner'] as Role[]).map((r) => html`<option value="${r}" ${r === current ? raw('selected') : ''}>${ROLE_LABELS[r]}: ${ROLE_HELP[r]}</option>`)}`;

const showChecks = (shows: Show[], picked: Set<string>): Raw =>
  shows.length
    ? html`<fieldset class="checks"><legend>Shows they can open</legend>${shows.map(
        (s) => html`<label class="check"><input type="checkbox" name="shows" value="${s.id}" ${picked.has(s.id) ? raw('checked') : ''}> ${s.name}</label>`,
      )}<small>Owners can always open every show.</small></fieldset>`
    : html`<p class="muted">No shows yet.</p>`;

export interface UsersView {
  csrf: string;
  users: Array<User & { showNames: string[] }>;
  invites: Invite[];
  shows: Show[];
  mailOn: boolean;
  notice?: Notice;
}

export function usersPage(v: UsersView): string {
  return layout({
    title: 'Users',
    csrf: v.csrf,
    role: 'owner',
    nav: 'users',
    body: html`<h1>Users</h1>
    ${noticeHtml(v.notice)}
    <section class="card">
      <ul class="msgs">
        ${v.users.map(
          (u) => html`<li class="msg${u.disabled_at ? '' : ''}">
            <a class="msg-main" href="/users/${u.id}">
              <span class="who">${u.name || u.email} <span class="badge">${ROLE_LABELS[u.role]}</span>${u.disabled_at ? html` <span class="badge bad">disabled</span>` : ''}${u.totp_enabled ? html` <span class="badge">2-step</span>` : ''}</span>
              <span class="meta">${u.name ? html`${u.email} &middot; ` : ''}${u.role === 'owner' ? 'All shows' : u.showNames.length ? u.showNames.join(', ') : 'No shows yet'} &middot; ${u.last_login_at ? html`last sign-in ${timeTag(u.last_login_at)}` : 'never signed in'}</span>
            </a>
          </li>`,
        )}
      </ul>
    </section>
    ${v.invites.length
      ? html`<section class="card"><h2>Pending invitations</h2><ul class="msgs">${v.invites.map(
          (i) => html`<li class="msg">
            <span class="msg-main"><span class="who">${i.email} <span class="badge">${ROLE_LABELS[(i.role ?? 'viewer') as Role]}</span></span><span class="meta">expires ${timeTag(i.expires_at)}</span></span>
            <span class="row-actions">
              <form method="post" action="/users/invites/${i.id}/resend" class="inline">${csrfField(v.csrf)}<button class="link">${v.mailOn ? 'Resend' : 'New link'}</button></form>
              <form method="post" action="/users/invites/${i.id}/revoke" class="inline">${csrfField(v.csrf)}<button class="link danger">Revoke</button></form>
            </span>
          </li>`,
        )}</ul></section>`
      : ''}
    <section class="card">
      <h2>Invite someone</h2>
      <form method="post" action="/users/invite" class="stack">${csrfField(v.csrf)}
        <label>Email<input type="email" name="email" required maxlength="254"></label>
        <label>Role<select name="role">${roleOptions('editor')}</select></label>
        ${showChecks(v.shows, new Set())}
        <button class="btn primary" type="submit">${v.mailOn ? 'Send invitation' : 'Create invitation link'}</button>
        <small>${v.mailOn ? 'They get an email with a link, valid for 7 days, where they choose their own password. If the email cannot be sent, you get the link to share yourself.' : 'Email is not set up, so you will get a link to share yourself. It is valid for 7 days.'}</small>
      </form>
    </section>`,
  });
}

export interface UserView {
  csrf: string;
  user: User;
  shows: Show[];
  picked: Set<string>;
  self: boolean;
  lastOwner: boolean;
  notice?: Notice;
}

export function userPage(v: UserView): string {
  const u = v.user;
  return layout({
    title: u.name || u.email,
    csrf: v.csrf,
    role: 'owner',
    nav: 'users',
    body: html`<p><a href="/users">&larr; All users</a></p>
    <h1>${u.name || u.email}</h1>
    ${noticeHtml(v.notice)}
    <section class="card">
      <dl class="details">
        <dt>Email</dt><dd>${u.email}</dd>
        <dt>Status</dt><dd>${u.disabled_at ? 'Disabled' : 'Active'}</dd>
        <dt>Two-step sign-in</dt><dd>${u.totp_enabled ? 'On' : 'Off'}</dd>
        <dt>Joined</dt><dd>${timeTag(u.created_at)}</dd>
      </dl>
      <form method="post" action="/users/${u.id}" class="stack">${csrfField(v.csrf)}
        <label>Name<input name="name" value="${u.name}" maxlength="80"></label>
        <label>Role<select name="role" ${v.lastOwner ? raw('disabled') : ''}>${(['owner', 'editor', 'viewer'] as Role[]).map((r) => html`<option value="${r}" ${r === u.role ? raw('selected') : ''}>${ROLE_LABELS[r]}: ${ROLE_HELP[r]}</option>`)}</select></label>
        ${v.lastOwner ? html`<small>This is the only active owner, so the role cannot be changed.</small>` : ''}
        ${showChecks(v.shows, v.picked)}
        <button class="btn primary" type="submit">Save</button>
      </form>
    </section>
    <section class="card">
      <h2>Access</h2>
      <div class="actions">
        <form method="post" action="/users/${u.id}/reset-link">${csrfField(v.csrf)}<button class="btn">Make a password reset link</button></form>
        ${u.totp_enabled ? html`<form method="post" action="/users/${u.id}/reset-totp" data-confirm="Turn off two-step sign-in for this user?">${csrfField(v.csrf)}<button class="btn">Turn off two-step sign-in</button></form>` : ''}
        ${v.self || v.lastOwner
          ? ''
          : html`<form method="post" action="/users/${u.id}/${u.disabled_at ? 'enable' : 'disable'}">${csrfField(v.csrf)}<button class="btn">${u.disabled_at ? 'Enable' : 'Disable'} sign-in</button></form>
            <form method="post" action="/users/${u.id}/delete" data-confirm="Remove this user for good?">${csrfField(v.csrf)}<button class="btn danger">Remove user</button></form>`}
      </div>
      <p class="muted">A reset link lets them choose a new password. Disabling signs them out immediately.</p>
    </section>`,
  });
}

// ---------------------------------------------------------------- public: accept an invite / reset a password
export function acceptPage(kind: 'invite' | 'reset', token: string, email: string, error?: string): string {
  const invite = kind === 'invite';
  return layout({
    title: invite ? 'Join ListenerLoop' : 'Choose a new password',
    body: html`<section class="card narrow">
      <h1>${invite ? 'Join ListenerLoop' : 'Choose a new password'}</h1>
      <p class="muted">${email}</p>
      ${error ? html`<p class="alert" role="alert">${error}</p>` : ''}
      <form method="post" action="/${invite ? 'invite' : 'reset'}/${token}" class="stack">
        ${invite ? html`<label>Your name<input name="name" maxlength="80" autocomplete="name"></label>` : ''}
        <label>Password (at least 12 characters)<input type="password" name="password" autocomplete="new-password" minlength="12" required autofocus></label>
        <label>Repeat the password<input type="password" name="confirm" autocomplete="new-password" minlength="12" required></label>
        <button class="btn primary" type="submit">${invite ? 'Create my account' : 'Save password'}</button>
      </form>
    </section>`,
  });
}

export const linkProblemPage = (): string =>
  layout({
    title: 'Link expired',
    body: html`<section class="card narrow"><h1>This link no longer works</h1><p>It may have expired or already been used. Ask an owner for a new one.</p><p><a href="/login">Go to sign in</a></p></section>`,
  });

// ---------------------------------------------------------------- account
export interface AccountView {
  csrf: string;
  role: Role;
  user: User;
  recoveryLeft: number;
  /** While enrolling: the QR code (data: URL) and the typed-in secret. */
  enroll?: { qr: string; secret: string };
  /** Shown once, right after turning two-step on or regenerating. */
  codes?: string[];
  notice?: { section: 'name' | 'password' | 'totp'; ok: boolean; message: string };
}

export function accountPage(v: AccountView): string {
  const note = (section: 'name' | 'password' | 'totp'): Raw =>
    v.notice && v.notice.section === section
      ? html`<div class="${v.notice.ok ? 'notice' : 'alert'}" role="${v.notice.ok ? 'status' : 'alert'}"><p>${v.notice.message}</p></div>`
      : raw('');
  const u = v.user;
  return layout({
    title: 'Your account',
    csrf: v.csrf,
    role: v.role,
    nav: 'account',
    body: html`<h1>Your account</h1>
    <section class="card">
      <h2>Profile</h2>
      ${note('name')}
      <dl class="details"><dt>Email</dt><dd>${u.email}</dd><dt>Role</dt><dd>${ROLE_LABELS[v.role]}</dd></dl>
      <form method="post" action="/account/name" class="stack">${csrfField(v.csrf)}
        <label>Name<input name="name" value="${u.name}" maxlength="80"></label>
        <button class="btn" type="submit">Save name</button>
      </form>
    </section>
    <section class="card">
      <h2>Change password</h2>
      ${note('password')}
      <form method="post" action="/account/password" class="stack">${csrfField(v.csrf)}
        <label>Current password<input type="password" name="current" autocomplete="current-password" required></label>
        <label>New password (at least 12 characters)<input type="password" name="next" autocomplete="new-password" minlength="12" required></label>
        <label>Repeat the new password<input type="password" name="confirm" autocomplete="new-password" minlength="12" required></label>
        <button class="btn" type="submit">Change password</button>
        <small>Your other signed-in sessions are signed out.</small>
      </form>
    </section>
    <section class="card">
      <h2>Two-step sign-in</h2>
      ${note('totp')}
      ${v.codes
        ? html`<div class="notice"><p><strong>Save these recovery codes.</strong> Each works once if you lose your phone. They are not shown again.</p>
            <pre class="codes">${v.codes.join('\n')}</pre></div>`
        : ''}
      ${u.totp_enabled
        ? html`<p>On. ${v.recoveryLeft} recovery ${v.recoveryLeft === 1 ? 'code' : 'codes'} left.</p>
          <form method="post" action="/account/totp/recovery" class="stack">${csrfField(v.csrf)}
            <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
            <div class="actions"><button class="btn" type="submit">Make new recovery codes</button>
            <button class="btn danger" type="submit" formaction="/account/totp/disable">Turn off</button></div>
          </form>`
        : v.enroll
          ? html`<p>Scan this with an authenticator app (1Password, Authy, Google Authenticator), then enter the 6-digit code it shows.</p>
            <p><img src="${v.enroll.qr}" alt="QR code for the authenticator app" width="200" height="200"></p>
            <p class="muted">Or type this key in: <code>${v.enroll.secret}</code></p>
            <form method="post" action="/account/totp/confirm" class="stack">${csrfField(v.csrf)}
              <label>Code<input name="code" inputmode="numeric" autocomplete="one-time-code" required></label>
              <button class="btn primary" type="submit">Turn on</button>
            </form>`
          : html`<p class="muted">Off. Add a second step with an authenticator app for extra protection.</p>
            <form method="post" action="/account/totp/start">${csrfField(v.csrf)}<button class="btn" type="submit">Set up</button></form>`}
    </section>`,
  });
}
