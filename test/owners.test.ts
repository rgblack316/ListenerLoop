import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import { MIGRATIONS, migrate } from '../src/db/index.js';
import type { Show } from '../src/db/repo.js';
import { APP_URL, formPost, login, makeHarness, type Harness } from './helpers.js';

const PW = 'a long enough password';

describe('owners (people who run their own shows)', () => {
  let h: Harness;
  let site: { cookie: string; csrf: string };
  let own: { cookie: string; csrf: string };
  let a: Show;
  let b: Show;
  const get = (url: string, s: { cookie: string }) => h.app.inject({ method: 'GET', url, headers: { cookie: s.cookie } });
  const base = { notify_email: 'x@example.com', max_seconds: '120', accent_color: '#112233' };

  beforeAll(async () => {
    h = await makeHarness();
    site = await login(h);
    a = h.ctx.repo.createShow({ name: 'Owned Show', notify_email: 'a@example.com' });
    b = h.ctx.repo.createShow({ name: 'Other Show', notify_email: 'b@example.com' });
    h.ctx.repo.createUser({ email: 'owner@example.com', passwordHash: await hash(PW), role: 'owner', showIds: [a.id] });
    h.ctx.repo.createUser({ email: 'ed@example.com', passwordHash: await hash(PW), role: 'editor', showIds: [a.id] });
    h.ctx.repo.createUser({ email: 'mixed@example.com', passwordHash: await hash(PW), role: 'viewer', showIds: [a.id, b.id] });
    own = await login(h, 'owner@example.com', PW);
  });
  afterAll(async () => h.close());

  it('upgrades the old owner role to site admin', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const m of MIGRATIONS.filter((x) => x.id < 15)) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.id, m.name, 'x');
    }
    db.prepare("INSERT INTO users (id, email, password_hash, role, created_at) VALUES ('u1', 'old@example.com', 'h', 'owner', 'x'), ('u2', 'ed@example.com', 'h', 'editor', 'x')").run();
    db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('t', 'u1', 'x', 'y')").run();
    migrate(db);
    expect((db.prepare('SELECT role FROM users ORDER BY id').all() as { role: string }[]).map((r) => r.role)).toEqual(['site_admin', 'editor']);
    expect((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(1);
    db.prepare("INSERT INTO users (id, email, password_hash, role, created_at) VALUES ('u3', 'new@example.com', 'h', 'owner', 'x')").run();
    db.close();
  });

  it('shows owners the Shows and Users menus but not Settings', async () => {
    const body = (await get('/inbox', own)).body;
    expect(body).toContain('href="/shows"');
    expect(body).toContain('href="/users"');
    expect(body).not.toContain('href="/settings"');
  });

  it('keeps server settings, backups and restore for site admins', async () => {
    expect((await get('/settings', own)).statusCode).toBe(403);
    expect((await formPost(h, '/settings/backups/run', own, {})).statusCode).toBe(403);
  });

  it('lets an owner edit settings and webhooks only on their own shows', async () => {
    expect((await get(`/shows/${a.slug}/settings`, own)).statusCode).toBe(200);
    expect((await get(`/shows/${b.slug}/settings`, own)).statusCode).toBe(404);
    expect((await get(`/shows/${a.slug}/webhooks`, own)).statusCode).toBe(200);
    expect((await get(`/shows/${b.slug}/webhooks`, own)).statusCode).toBe(404);
    const save = await formPost(h, `/shows/${a.slug}/settings`, own, { ...base, name: 'Owned Show', slug: a.slug, button_label: 'Call us' });
    expect(save.statusCode).toBe(302);
    expect(h.ctx.repo.getShow(a.id)!.button_label).toBe('Call us');
    const other = await formPost(h, `/shows/${b.slug}/settings`, own, { ...base, name: 'Hijack', slug: b.slug });
    expect(other.statusCode).toBe(404);
    expect(h.ctx.repo.getShow(b.id)!.name).toBe('Other Show');
  });

  it('gives a new show to the owner who made it', async () => {
    const res = await formPost(h, '/shows', own, { ...base, name: 'Brand New' });
    expect(res.statusCode).toBe(302);
    const made = h.ctx.repo.listShows().find((s) => s.name === 'Brand New')!;
    expect(h.ctx.repo.userShowIds(h.ctx.repo.getUserByEmail('owner@example.com')!.id)).toContain(made.id);
    expect((await get(`/shows/${made.slug}`, own)).statusCode).toBe(200);
  });

  it('deletes an owned show only after the name is typed, with its messages', async () => {
    const s = h.ctx.repo.createShow({ name: 'Doomed', notify_email: 'd@example.com' });
    h.ctx.repo.setUserShows(h.ctx.repo.getUserByEmail('owner@example.com')!.id, [a.id, s.id]);
    h.ctx.repo.insertMessage({ id: 'doomed1', show_id: s.id, sender_name: 'Z', sender_email: null, consent_given: 1, original_mime: null, ip_hash: null, user_agent: null });
    await h.ctx.storage.put('doomed1.mp3', Buffer.from('x'), 'audio/mpeg');
    h.ctx.repo.updateMessage('doomed1', { status: 'ready', mp3_key: 'doomed1.mp3' });
    const wrong = await formPost(h, `/shows/${s.slug}/delete`, own, { confirm: 'nope' });
    expect(wrong.statusCode).toBe(400);
    expect(h.ctx.repo.getShow(s.id)).toBeDefined();
    const notMine = await formPost(h, `/shows/${b.slug}/delete`, own, { confirm: 'Other Show' });
    expect(notMine.statusCode).toBe(404);
    const ok = await formPost(h, `/shows/${s.slug}/delete`, own, { confirm: 'Doomed' });
    expect(ok.statusCode).toBe(302);
    expect(h.ctx.repo.getShow(s.id)).toBeUndefined();
    expect(h.ctx.repo.getMessage('doomed1')).toBeUndefined();
    expect(await h.ctx.storage.exists('doomed1.mp3')).toBe(false);
  });

  it('lists only the people an owner can manage', async () => {
    const body = (await get('/users', own)).body;
    expect(body).toContain('ed@example.com');
    expect(body).not.toContain('mixed@example.com'); // also has a show the owner does not run
    expect(body).not.toContain('admin@example.com');
    expect(body).not.toContain('value="site_admin"');
    expect(body).not.toContain('Site admin:');
    const ed = h.ctx.repo.getUserByEmail('ed@example.com')!;
    const mixed = h.ctx.repo.getUserByEmail('mixed@example.com')!;
    expect((await get(`/users/${ed.id}`, own)).statusCode).toBe(200);
    expect((await get(`/users/${mixed.id}`, own)).statusCode).toBe(404);
    expect((await formPost(h, `/users/${mixed.id}/disable`, own, {})).statusCode).toBe(404);
    expect((await formPost(h, `/users/${h.ctx.repo.firstSiteAdmin()!.id}/delete`, own, {})).statusCode).toBe(404);
  });

  it('lets an owner invite editors and viewers for their shows, and nothing higher', async () => {
    const invite = (fields: Record<string, string>, shows: string[]) =>
      h.app.inject({
        method: 'POST',
        url: '/users/invite',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: APP_URL, cookie: own.cookie },
        payload: new URLSearchParams([['_csrf', own.csrf], ...Object.entries(fields), ...shows.map((s) => ['shows', s] as [string, string])]).toString(),
      });
    expect((await invite({ email: 'up@example.com', role: 'site_admin' }, [a.id])).statusCode).toBe(400);
    expect((await invite({ email: 'up2@example.com', role: 'owner' }, [a.id])).statusCode).toBe(400);
    expect((await invite({ email: 'none@example.com', role: 'editor' }, [])).statusCode).toBe(400);
    const sneaky = await invite({ email: 'sneak@example.com', role: 'editor' }, [b.id]);
    expect(sneaky.statusCode).toBe(400); // b is not theirs, so it is dropped and nothing is left
    const ok = await invite({ email: 'fresh@example.com', role: 'viewer' }, [a.id, b.id]);
    expect(ok.statusCode).toBe(200);
    const inv = h.ctx.repo.pendingInvites().find((i) => i.email === 'fresh@example.com')!;
    expect(JSON.parse(inv.show_ids)).toEqual([a.id]);
    expect(inv.role).toBe('viewer');
    // a site admin does not see it as someone else's; another owner cannot revoke it
    const other = h.ctx.repo.createUser({ email: 'owner2@example.com', passwordHash: await hash(PW), role: 'owner', showIds: [a.id] });
    expect(other.role).toBe('owner');
    const o2 = await login(h, 'owner2@example.com', PW);
    expect((await formPost(h, `/users/invites/${inv.id}/revoke`, o2, {})).statusCode).toBe(404);
    expect((await formPost(h, `/users/invites/${inv.id}/revoke`, own, {})).statusCode).toBe(200);
  });

  it('only lets a site admin create owners', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/users/invite',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: APP_URL, cookie: site.cookie },
      payload: new URLSearchParams([['_csrf', site.csrf], ['email', 'newowner@example.com'], ['role', 'owner'], ['shows', a.id]]).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(h.ctx.repo.pendingInvites().find((i) => i.email === 'newowner@example.com')!.role).toBe('owner');
    expect((await get('/users', site)).body).toContain('Owner');
  });
});
