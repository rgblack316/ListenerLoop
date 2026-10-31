import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import type { Show } from '../src/db/repo.js';
import { hotp, base32Decode } from '../src/totp.js';
import { ADMIN_EMAIL, APP_URL, formPost, login, makeHarness, type Harness } from './helpers.js';

const PW = 'a long enough password';
const linkIn = (text: string, kind: 'invite' | 'reset'): string => {
  const m = new RegExp(`${APP_URL.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}/${kind}/([A-Za-z0-9_-]+)`).exec(text);
  if (!m) throw new Error(`no ${kind} link in: ${text.slice(0, 200)}`);
  return `/${kind}/${m[1]}`;
};

describe('multi-user admin', () => {
  let h: Harness;
  let owner: { cookie: string; csrf: string };
  let a: Show;
  let b: Show;
  const msgs: Record<string, string> = {};

  const addMsg = (id: string, show: Show, name: string): string => {
    h.ctx.repo.insertMessage({ id, show_id: show.id, sender_name: name, sender_email: null, consent_given: 1, original_mime: null, ip_hash: null, user_agent: null });
    h.ctx.repo.updateMessage(id, { status: 'ready' });
    return id;
  };
  const get = (url: string, s: { cookie: string }) => h.app.inject({ method: 'GET', url, headers: { cookie: s.cookie } });

  /** Invites by email, accepts the emailed link and returns the new session. */
  const join = async (email: string, role: string, shows: Show[]): Promise<{ cookie: string; csrf: string }> => {
    const before = h.sent.length;
    const res = await h.app.inject({
      method: 'POST',
      url: '/users/invite',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: APP_URL, cookie: owner.cookie },
      payload: new URLSearchParams([['_csrf', owner.csrf], ['email', email], ['role', role], ...shows.map((s) => ['shows', s.id] as [string, string])]).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(h.sent.length).toBe(before + 1);
    const link = linkIn(h.sent.at(-1)!.text, 'invite');
    const accept = await formPost(h, link, { cookie: '' }, { name: 'New Person', password: PW, confirm: PW });
    expect(accept.statusCode).toBe(302);
    const cookie = String(accept.headers['set-cookie']).split(';')[0]!;
    const inbox = await get('/inbox', { cookie });
    return { cookie, csrf: /name="_csrf" value="([^"]+)"/.exec(inbox.body)![1]! };
  };

  beforeAll(async () => {
    h = await makeHarness();
    owner = await login(h);
    a = h.ctx.repo.createShow({ name: 'Show A', notify_email: 'a@example.com' });
    b = h.ctx.repo.createShow({ name: 'Show B', notify_email: 'b@example.com' });
    msgs.a = addMsg('ma', a, 'Alice A');
    msgs.b = addMsg('mb', b, 'Bob B');
  });
  afterAll(async () => h.close());

  it('migrated the single admin to an owner and keeps CLI semantics', () => {
    const o = h.ctx.repo.firstSiteAdmin();
    expect(o?.email).toBe(ADMIN_EMAIL);
    expect(o?.role).toBe('site_admin');
    expect(h.ctx.repo.hasSiteAdmin()).toBe(true);
  });

  it('an editor only sees and changes the shows they were given', async () => {
    const ed = await join('ed@example.com', 'editor', [a]);
    const inbox = await get('/inbox', ed);
    expect(inbox.body).toContain('Alice A');
    expect(inbox.body).not.toContain('Bob B');
    expect((await get(`/shows/${b.slug}`, ed)).statusCode).toBe(404);
    expect((await get(`/shows/${b.slug}/messages/${msgs.b}`, ed)).statusCode).toBe(404);
    expect((await formPost(h, `/shows/${b.slug}/messages/${msgs.b}/star`, ed, {})).statusCode).toBe(404);
    expect((await formPost(h, `/shows/${a.slug}/messages/${msgs.a}/star`, ed, {})).statusCode).toBe(302);
    expect(h.ctx.repo.getMessage(msgs.a!)!.starred).toBe(1);
    // owner-only areas
    for (const url of ['/users', '/settings', '/shows', '/shows/new', `/shows/${a.slug}/settings`]) {
      expect((await get(url, ed)).statusCode, url).toBe(403);
    }
    expect((await formPost(h, `/shows/${a.slug}/rotate-key`, ed, {})).statusCode).toBe(403);
    expect((await formPost(h, '/users/invite', ed, { email: 'x@example.com', role: 'site_admin' })).statusCode).toBe(403);
    const nav = (await get('/inbox', ed)).body;
    expect(nav).not.toContain('href="/users"');
    expect(nav).not.toContain('href="/settings"');
  });

  it('a viewer can read but not change anything', async () => {
    const v = await join('view@example.com', 'viewer', [a]);
    const page = await get(`/shows/${a.slug}/messages/${msgs.a}`, v);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Alice A');
    expect(page.body).not.toContain('/star"');
    expect(page.body).not.toContain('/delete"');
    expect(page.body).not.toContain('Save notes');
    for (const action of ['star', 'archive', 'delete', 'notes', 'transcribe', 'retry', 'resend-alert', 'reply']) {
      const res = await formPost(h, `/shows/${a.slug}/messages/${msgs.a}/${action}`, v, { notes: 'x', subject: 's', body: 'b' });
      expect(res.statusCode, action).toBe(403);
    }
    expect(h.ctx.repo.getMessage(msgs.a!)!.deleted_at).toBeNull();
    // still allowed: listening/download routes pass access control (no audio in this fixture, so 404 not 403)
    expect((await get(`/shows/${a.slug}/messages/${msgs.a}/audio`, v)).statusCode).not.toBe(403);
    expect((await get(`/shows/${b.slug}/messages/${msgs.b}/audio`, v)).statusCode).toBe(404);
  });

  it('a member with no shows gets a clear empty state', async () => {
    const n = await join('none@example.com', 'viewer', []);
    const home = await get('/', n);
    expect(home.statusCode).toBe(200);
    const inbox = await get('/inbox', n);
    expect(inbox.body).toContain('not been given access');
    expect(inbox.body).not.toContain('Alice A');
  });

  it('shows the invite link when email fails or is off, and rejects reuse', async () => {
    h.mail.fail = true;
    const res = await formPost(h, '/users/invite', owner, { email: 'late@example.com', role: 'viewer' });
    h.mail.fail = false;
    expect(res.body).toContain('could not be sent');
    const link = linkIn(res.body, 'invite');
    expect((await get(link, { cookie: '' })).statusCode).toBe(200);
    expect((await formPost(h, link, { cookie: '' }, { password: 'short', confirm: 'short' })).statusCode).toBe(400);
    expect((await formPost(h, link, { cookie: '' }, { password: PW, confirm: PW })).statusCode).toBe(302);
    expect((await get(link, { cookie: '' })).statusCode).toBe(410);
    expect((await get('/invite/nonsense', { cookie: '' })).statusCode).toBe(410);
  });

  it('expired invites stop working and duplicate emails are refused', async () => {
    const dup = await formPost(h, '/users/invite', owner, { email: 'ED@example.com', role: 'viewer' });
    expect(dup.statusCode).toBe(400);
    await formPost(h, '/users/invite', owner, { email: 'old@example.com', role: 'viewer' });
    const link = linkIn(h.sent.at(-1)!.text, 'invite');
    h.ctx.repo.db.prepare("UPDATE invites SET expires_at = '2020-01-01T00:00:00.000Z' WHERE email = 'old@example.com'").run();
    expect((await get(link, { cookie: '' })).statusCode).toBe(410);
  });

  it('protects the last owner', async () => {
    const me = h.ctx.repo.firstSiteAdmin()!;
    const demote = await formPost(h, `/users/${me.id}`, owner, { role: 'viewer', name: '' });
    expect(demote.statusCode).toBe(400);
    expect((await formPost(h, `/users/${me.id}/disable`, owner, {})).statusCode).toBe(400);
    expect((await formPost(h, `/users/${me.id}/delete`, owner, {})).statusCode).toBe(400);
    expect(h.ctx.repo.getUser(me.id)!.role).toBe('site_admin');
  });

  it('disabling a user signs them out at once; enabling lets them back in', async () => {
    const s = await join('temp@example.com', 'editor', [a]);
    const u = h.ctx.repo.getUserByEmail('temp@example.com')!;
    expect((await get('/inbox', s)).statusCode).toBe(200);
    await formPost(h, `/users/${u.id}/disable`, owner, {});
    expect((await get('/inbox', s)).statusCode).toBe(302);
    expect((await formPost(h, '/login', { cookie: '' }, { email: 'temp@example.com', password: PW })).statusCode).toBe(401);
    await formPost(h, `/users/${u.id}/enable`, owner, {});
    expect((await formPost(h, '/login', { cookie: '' }, { email: 'temp@example.com', password: PW })).statusCode).toBe(302);
    await formPost(h, `/users/${u.id}/delete`, owner, {});
    expect(h.ctx.repo.getUser(u.id)).toBeUndefined();
  });

  it('role and show changes apply to the next request', async () => {
    const s = await join('shift@example.com', 'viewer', [a]);
    const u = h.ctx.repo.getUserByEmail('shift@example.com')!;
    expect((await formPost(h, `/shows/${a.slug}/messages/${msgs.a}/star`, s, {})).statusCode).toBe(403);
    await formPost(h, `/users/${u.id}`, owner, { role: 'editor', name: 'Shift', shows: b.id });
    expect((await get(`/shows/${a.slug}`, s)).statusCode).toBe(404);
    expect((await get(`/shows/${b.slug}`, s)).statusCode).toBe(200);
    expect((await formPost(h, `/shows/${b.slug}/messages/${msgs.b}/star`, s, {})).statusCode).toBe(302);
  });

  it('an owner-made reset link sets a new password and signs the user out everywhere', async () => {
    const s = await join('reset@example.com', 'viewer', [a]);
    const u = h.ctx.repo.getUserByEmail('reset@example.com')!;
    const res = await formPost(h, `/users/${u.id}/reset-link`, owner, {});
    expect(res.statusCode).toBe(200);
    const link = linkIn(h.sent.at(-1)!.text, 'reset');
    expect((await formPost(h, link, { cookie: '' }, { password: 'brand new password!', confirm: 'brand new password!' })).statusCode).toBe(302);
    expect((await get('/inbox', s)).statusCode).toBe(302);
    expect((await formPost(h, '/login', { cookie: '' }, { email: 'reset@example.com', password: PW })).statusCode).toBe(401);
    expect((await formPost(h, '/login', { cookie: '' }, { email: 'reset@example.com', password: 'brand new password!' })).statusCode).toBe(302);
    expect((await get(link, { cookie: '' })).statusCode).toBe(410);
  });

  it('lets anyone change their own password from the account page', async () => {
    const s = await join('pw@example.com', 'viewer', []);
    expect((await get('/account', s)).statusCode).toBe(200);
    const bad = await formPost(h, '/account/password', s, { current: 'nope', next: 'another long password', confirm: 'another long password' });
    expect(bad.statusCode).toBe(401);
    const ok = await formPost(h, '/account/password', s, { current: PW, next: 'another long password', confirm: 'another long password' });
    expect(ok.body).toContain('Password changed');
  });

  describe('two-step sign-in', () => {
    it('enrols, requires the code at sign-in, accepts a recovery code once, and an owner can reset it', async () => {
      const s = await join('totp@example.com', 'editor', [a]);
      const u = () => h.ctx.repo.getUserByEmail('totp@example.com')!;
      const start = await formPost(h, '/account/totp/start', s, {});
      expect(start.body).toContain('data:image/png;base64');
      const secret = u().totp_secret!;
      const code = (offset = 0) => hotp(secret, Math.floor(Date.now() / 30000) + offset);

      const wrong = await formPost(h, '/account/totp/confirm', s, { code: '000000' });
      expect(wrong.statusCode).toBe(400);
      expect(u().totp_enabled).toBe(0);
      const done = await formPost(h, '/account/totp/confirm', s, { code: code() });
      expect(done.body).toContain('recovery codes');
      const codes = [...done.body.matchAll(/\b([a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4})\b/g)].map((m) => m[1]!);
      expect(codes.length).toBe(10);
      expect(u().totp_enabled).toBe(1);
      expect(base32Decode(secret).length).toBe(20);

      // password alone no longer signs in
      const step1 = await formPost(h, '/login', { cookie: '' }, { email: 'totp@example.com', password: PW });
      expect(step1.statusCode).toBe(200);
      expect(step1.headers['set-cookie']).toBeUndefined();
      const ticket = /name="ticket" value="([^"]+)"/.exec(step1.body)![1]!;
      expect((await formPost(h, '/login/verify', { cookie: '' }, { ticket, code: '123456' })).statusCode).toBe(401);
      expect((await formPost(h, '/login/verify', { cookie: '' }, { ticket: 'forged.123.abc', code: code(1) })).statusCode).toBe(401);
      // the code used while enrolling cannot be replayed; the next step's code works
      expect((await formPost(h, '/login/verify', { cookie: '' }, { ticket, code: code() })).statusCode).toBe(401);
      expect((await formPost(h, '/login/verify', { cookie: '' }, { ticket, code: code(1) })).statusCode).toBe(302);

      // recovery code works once
      const t2 = /name="ticket" value="([^"]+)"/.exec((await formPost(h, '/login', { cookie: '' }, { email: 'totp@example.com', password: PW })).body)![1]!;
      expect((await formPost(h, '/login/verify', { cookie: '' }, { ticket: t2, code: codes[0]! })).statusCode).toBe(302);
      expect((await formPost(h, '/login/verify', { cookie: '' }, { ticket: t2, code: codes[0]! })).statusCode).toBe(401);

      // owner turns it off for a locked-out user
      await formPost(h, `/users/${u().id}/reset-totp`, owner, {});
      expect(u().totp_enabled).toBe(0);
      expect((await formPost(h, '/login', { cookie: '' }, { email: 'totp@example.com', password: PW })).statusCode).toBe(302);
    });

    it('turning it off needs the password', async () => {
      const s = await join('totp2@example.com', 'viewer', []);
      await formPost(h, '/account/totp/start', s, {});
      const secret = h.ctx.repo.getUserByEmail('totp2@example.com')!.totp_secret!;
      await formPost(h, '/account/totp/confirm', s, { code: hotp(secret, Math.floor(Date.now() / 30000)) });
      expect((await formPost(h, '/account/totp/disable', s, { password: 'wrong' })).statusCode).toBe(401);
      expect(h.ctx.repo.getUserByEmail('totp2@example.com')!.totp_enabled).toBe(1);
      expect((await formPost(h, '/account/totp/disable', s, { password: PW })).statusCode).toBe(200);
      expect(h.ctx.repo.getUserByEmail('totp2@example.com')!.totp_enabled).toBe(0);
    });
  });

  it('upgrades a database that still has the single admin row', async () => {
    const { openDb, MIGRATIONS } = await import('../src/db/index.js');
    const db = openDb(':memory:');
    db.exec('DROP TABLE schema_migrations');
    // Rebuild the pre-migration-10 world: run up to 9, add an admin and a session, then migrate.
    const raw = (await import('better-sqlite3')).default(':memory:');
    raw.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const m of MIGRATIONS.filter((x) => x.id < 10)) {
      raw.exec(m.sql);
      raw.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.id, m.name, 'x');
    }
    raw.prepare("INSERT INTO admin (id, email, password_hash, created_at) VALUES (1, 'old@x.com', ?, '2024-01-01')").run(await hash(PW));
    raw.prepare("INSERT INTO sessions VALUES ('t', 1, 'a', 'b')").run();
    const { migrate } = await import('../src/db/index.js');
    migrate(raw);
    const users = raw.prepare('SELECT email, role FROM users').all();
    expect(users).toEqual([{ email: 'old@x.com', role: 'site_admin' }]);
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'admin'").all()).toEqual([]);
    raw.close();
    db.close();
  });
});
