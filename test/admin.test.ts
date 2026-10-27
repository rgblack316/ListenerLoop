import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  APP_URL,
  cookieFrom,
  formPost,
  hasFfmpeg,
  login,
  makeAudio,
  makeHarness,
  multipart,
  type Harness,
} from './helpers.js';
import type { Show } from '../src/db/repo.js';
import { purgeDeleted, purgeExpired } from '../src/process.js';

const ffmpeg = hasFfmpeg();

describe('admin: access control', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('sends signed-out visitors to the login page', async () => {
    for (const url of ['/', '/inbox', '/shows', '/shows/new', '/shows/x', '/shows/x/settings', '/shows/x/messages/y', '/shows/x/messages/y/audio']) {
      const res = await h.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(302);
      expect(res.headers.location).toBe('/login');
    }
    const post = await h.app.inject({ method: 'POST', url: '/shows', payload: 'name=x', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: APP_URL } });
    expect(post.statusCode).toBe(302);
  });

  it('locks down the login page', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/login' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).not.toMatch(/<script>|onclick=|onsubmit=|style=/);
  });

  it('rejects wrong credentials the same way for a wrong email or password', async () => {
    const wrongPassword = await formPost(h, '/login', { cookie: '' }, { email: ADMIN_EMAIL, password: 'nope nope nope nope' });
    const wrongEmail = await formPost(h, '/login', { cookie: '' }, { email: 'someone@else.test', password: ADMIN_PASSWORD });
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongEmail.statusCode).toBe(401);
    expect(wrongPassword.body).toContain('do not match');
    expect(wrongEmail.body).toContain('do not match');
    expect(wrongEmail.headers['set-cookie']).toBeUndefined();
  });

  it('blocks logins that come from another origin', async () => {
    const res = await formPost(h, '/login', { cookie: '' }, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, { origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
  });

  it('signs in with strict, HttpOnly, Secure cookies and signs out again', async () => {
    const res = await formPost(h, '/login', { cookie: '' }, { email: ADMIN_EMAIL.toUpperCase(), password: ADMIN_PASSWORD });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
    const cookie = cookieFrom(res);
    const inbox = await h.app.inject({ method: 'GET', url: '/inbox', headers: { cookie } });
    expect(inbox.statusCode).toBe(200);

    const session = await login(h);
    const out = await formPost(h, '/logout', session, {});
    expect(out.statusCode).toBe(302);
    const after = await h.app.inject({ method: 'GET', url: '/inbox', headers: { cookie: session.cookie } });
    expect(after.statusCode).toBe(302);
  });

  it('throttles repeated failed logins', async () => {
    const throttled = await makeHarness();
    try {
      let last = 0;
      for (let i = 0; i < 10; i++) {
        last = (await formPost(throttled, '/login', { cookie: '' }, { email: ADMIN_EMAIL, password: `wrong password ${i}` })).statusCode;
      }
      expect(last).toBe(429);
      const right = await formPost(throttled, '/login', { cookie: '' }, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
      expect(right.statusCode).toBe(429);
    } finally {
      await throttled.close();
    }
  });

  it('expires sessions', async () => {
    const session = await login(h);
    h.ctx.repo.db.prepare('UPDATE sessions SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
    const res = await h.app.inject({ method: 'GET', url: '/inbox', headers: { cookie: session.cookie } });
    expect(res.statusCode).toBe(302);
  });

  it('answers the health check', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('admin: shows', () => {
  let h: Harness;
  let session: { cookie: string; csrf: string };
  beforeAll(async () => {
    h = await makeHarness();
    session = await login(h);
  });
  afterAll(async () => {
    await h.close();
  });

  it('requires a CSRF token and same-origin for changes', async () => {
    const fields = { name: 'No token' };
    expect((await formPost(h, '/shows', { cookie: session.cookie }, fields)).statusCode).toBe(403);
    expect((await formPost(h, '/shows', { ...session, csrf: 'x'.repeat(32) }, fields)).statusCode).toBe(403);
    expect((await formPost(h, '/shows', session, fields, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect(h.ctx.repo.listShows()).toHaveLength(0);
  });

  it('requires an email address for the show', async () => {
    const res = await formPost(h, '/shows', session, { name: 'Needs Email', max_seconds: '60', accent_color: '#112233' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('email address is required');
    expect(h.ctx.repo.listShows()).toHaveLength(0);
  });

  it('validates the form and explains each problem', async () => {
    const res = await formPost(h, '/shows', session, {
      name: '',
      allowed_origins: 'not a url, ftp://x.test',
      notify_email: 'nope',
      max_seconds: '2',
      accent_color: 'red',
    });
    expect(res.statusCode).toBe(400);
    for (const text of ['Show name is required', 'not valid addresses', 'show email address does not look right', 'between 5 and 600', 'hex color']) {
      expect(res.body).toContain(text);
    }
    expect(h.ctx.repo.listShows()).toHaveLength(0);
  });

  let show: Show;
  it('creates a show with normalized origins and shows its embed code', async () => {
    const res = await formPost(h, '/shows', session, {
      name: 'Randy Unscripted',
      allowed_origins: 'randyunscripted.com\nhttps://www.randyunscripted.com/about\nhttps://randyunscripted.com',
      notify_email: 'randy@example.com',
      max_seconds: '180',
      accent_color: '#112233',
      button_label: 'Leave a voicemail',
      consent_text: 'OK to play on air?',
      ask_email: '1',
    });
    expect(res.statusCode).toBe(302);
    show = h.ctx.repo.listShows()[0]!;
    expect(show.slug).toBe('randy-unscripted');
    expect(JSON.parse(show.allowed_origins)).toEqual(['https://randyunscripted.com', 'https://www.randyunscripted.com']);
    expect(show.site_key).toMatch(/^pk_[\w-]{22}$/);

    const page = await h.app.inject({ method: 'GET', url: '/shows?flash=created', headers: { cookie: session.cookie } });
    expect(page.body).toContain(`data-site-key=&quot;${show.site_key}&quot;`);
    expect(page.body).toContain(`${APP_URL}/embed.js`);
  });

  it('edits a show and shows its preview', async () => {
    const edit = await formPost(h, `/shows/${show.slug}/settings`, session, {
      name: 'Randy Unscripted',
      slug: 'randy',
      allowed_origins: 'https://randyunscripted.com',
      max_seconds: '120',
      accent_color: '#112233',
      notify_email: 'randy@randyunscripted.test',
      ask_email: '1',
    });
    expect(edit.statusCode).toBe(302);
    const saved = h.ctx.repo.getShow(show.id)!;
    show = saved;
    expect(saved.slug).toBe('randy');
    expect(saved.max_seconds).toBe(120);

    const form = await h.app.inject({ method: 'GET', url: `/shows/${show.slug}/settings`, headers: { cookie: session.cookie } });
    expect(form.body).toContain('data-preview');
    expect(form.body).toContain('src="/static/preview.html"');
    expect(form.headers['content-security-policy']).toContain("frame-src 'self'");
    expect((await h.app.inject({ method: 'GET', url: '/static/preview.html' })).statusCode).toBe(200);
    expect(form.body).not.toContain('turnstile_site_key');
    expect(form.body).not.toContain('Turnstile override');

    // Every show's widget uses the one app-wide Turnstile key.
    const cfg = await h.app.inject({ method: 'GET', url: `/api/public/config?key=${saved.site_key}` });
    expect(cfg.json().turnstileSiteKey).toBe(h.config.turnstile.siteKey);
  });

  it('refuses duplicate slugs', async () => {

    h.ctx.repo.createShow({ name: 'Other Show' });
    const dup = await formPost(h, `/shows/${show.slug}/settings`, session, { name: 'Randy', slug: 'other-show', max_seconds: '120', accent_color: '#112233' });
    expect(dup.statusCode).toBe(400);
    expect(dup.body).toContain('already used');
  });

  it('rotates the site key', async () => {
    const before = h.ctx.repo.getShow(show.id)!.site_key;
    const res = await formPost(h, `/shows/${show.slug}/rotate-key`, session, {});
    expect(res.statusCode).toBe(302);
    const after = h.ctx.repo.getShow(show.id)!.site_key;
    expect(after).not.toBe(before);
    expect((await h.app.inject({ method: 'GET', url: `/widget?key=${before}` })).statusCode).toBe(404);
  });

  it('escapes show names in pages', async () => {
    h.ctx.repo.createShow({ name: '<img src=x onerror=alert(1)>' });
    const res = await h.app.inject({ method: 'GET', url: '/shows', headers: { cookie: session.cookie } });
    expect(res.body).not.toContain('<img src=x');
    expect(res.body).toContain('&lt;img src=x');
  });
});

describe.skipIf(!ffmpeg)('admin: inbox, playback and actions', () => {
  let h: Harness;
  let session: { cookie: string; csrf: string };
  let show: Show;
  let other: Show;
  const ids: string[] = [];
  const msgUrl = (i: number) => `/shows/${[show, show, other][i]!.slug}/messages/${ids[i]}`;

  beforeAll(async () => {
    h = await makeHarness();
    show = h.ctx.repo.createShow({ name: 'Randy Unscripted', allowed_origins: JSON.stringify(['https://randyunscripted.com']) });
    other = h.ctx.repo.createShow({ name: 'Other Show' });
    const second = other;
    const audio = makeAudio('webm-stream', 3);
    for (const [s, name] of [[show, 'Alice'], [show, 'Bob <script>'], [second, 'Carol']] as const) {
      const body = multipart({ key: s.site_key, name, email: 'x@example.com', consent: 'true', 'cf-turnstile-response': 'ok' }, { data: audio });
      const res = await h.app.inject({ method: 'POST', url: '/api/public/messages', payload: body.payload, headers: { ...body.headers, origin: APP_URL } });
      ids.push(res.json().id);
      await h.ctx.queue.idle();
    }
    session = await login(h);
  });
  afterAll(async () => {
    await h.close();
  });

  const get = (url: string, headers: Record<string, string> = {}) =>
    h.app.inject({ method: 'GET', url, headers: { cookie: session.cookie, ...headers } });

  it('lists who left each message before anyone plays it', async () => {
    const res = await get('/inbox');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Alice');
    expect(res.body).toContain('Carol');
    expect(res.body).toContain('Randy Unscripted');
    expect(res.body).toContain('badge new');
    expect(res.body).toContain('Bob &lt;script&gt;');
    expect(res.body).not.toContain('Bob <script>');
  });

  it('filters by show and by status', async () => {
    const byShow = await get(`/shows/${show.slug}`);
    expect(byShow.body).toContain('Alice');
    expect(byShow.body).not.toContain('Carol');
    const failed = await get('/inbox?filter=failed');
    expect(failed.body).toContain('No messages here');
    const junk = await get('/inbox?filter=bogus&page=-4');
    expect(junk.statusCode).toBe(200);
  });

  it('marks a message read when opened', async () => {
    expect(h.ctx.repo.getMessage(ids[0]!)!.read_at).toBeNull();
    const res = await get(`${msgUrl(0)}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Alice');
    expect(res.body).toContain('<audio controls');
    expect(res.body).toContain('x@example.com');
    expect(h.ctx.repo.getMessage(ids[0]!)!.read_at).toBeTruthy();
    const news = await get('/inbox?filter=new');
    expect(news.body).not.toContain('Alice');
    expect(news.body).toContain('Carol');
  });

  it('keeps each show\'s inbox separate and refuses cross-show access', async () => {
    const mine = await get(`/shows/${show.slug}`);
    expect(mine.statusCode).toBe(200);
    expect(mine.body).toContain('Alice');
    expect(mine.body).not.toContain('Carol');
    const theirs = await get(`/shows/${other.slug}`);
    expect(theirs.body).toContain('Carol');
    expect(theirs.body).not.toContain('Alice');
    // A message opened under the wrong show's URL is treated as missing, for the page, audio and actions.
    const wrong = `/shows/${other.slug}/messages/${ids[0]}`;
    expect((await get(wrong)).statusCode).toBe(404);
    expect((await get(`${wrong}/audio`)).statusCode).toBe(404);
    expect((await formPost(h, `${wrong}/delete`, session, {})).statusCode).toBe(404);
    expect((await get(`/shows/no-such-show`)).statusCode).toBe(404);
    expect((await get(msgUrl(0))).statusCode).toBe(200);
  });

  it('lists shows with unread counts on the home page', async () => {
    const home = await get('/');
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('Your shows');
    expect(home.body).toContain(`/shows/${other.slug}`);
    expect(home.body).toContain('/inbox');
  });

  it('plays audio with range support so seeking works', async () => {
    const m = h.ctx.repo.getMessage(ids[0]!)!;
    const size = fs.statSync(path.join(h.config.localStoragePath, m.mp3_key!)).size;

    const full = await get(`${msgUrl(0)}/audio`);
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('audio/mpeg');
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(Number(full.headers['content-length'])).toBe(size);
    expect(full.rawPayload.length).toBe(size);

    const part = await get(`${msgUrl(0)}/audio`, { range: 'bytes=10-19' });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 10-19/${size}`);
    expect(part.rawPayload.length).toBe(10);
    expect(part.rawPayload.equals(full.rawPayload.subarray(10, 20))).toBe(true);

    const tail = await get(`${msgUrl(0)}/audio`, { range: 'bytes=-100' });
    expect(tail.statusCode).toBe(206);
    expect(tail.rawPayload.length).toBe(100);

    const bad = await get(`${msgUrl(0)}/audio`, { range: `bytes=${size + 5}-` });
    expect(bad.statusCode).toBe(416);
    expect(bad.headers['content-range']).toBe(`bytes */${size}`);

    const download = await get(`${msgUrl(0)}/audio?download=1`);
    expect(download.headers['content-disposition']).toMatch(/^attachment; filename="randy-unscripted-alice-\d{4}-\d{2}-\d{2}\.mp3"$/);
  });

  it('never serves audio to signed-out visitors', async () => {
    const res = await h.app.inject({ method: 'GET', url: `${msgUrl(0)}/audio` });
    expect(res.statusCode).toBe(302);
    expect(res.rawPayload.length).toBeLessThan(200);
  });

  it('stars with htmx and rejects the same request without a token', async () => {
    const denied = await h.app.inject({ method: 'POST', url: `${msgUrl(1)}/star`, headers: { cookie: session.cookie, origin: APP_URL, 'hx-request': 'true' } });
    expect(denied.statusCode).toBe(403);

    const ok = await h.app.inject({
      method: 'POST',
      url: `${msgUrl(1)}/star`,
      headers: { cookie: session.cookie, origin: APP_URL, 'hx-request': 'true', 'x-csrf-token': session.csrf },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain(`id="row-${ids[1]}"`);
    expect(ok.body).toContain('star on');
    expect(h.ctx.repo.getMessage(ids[1]!)!.starred).toBe(1);

    const starred = await get('/inbox?filter=starred');
    expect(starred.body).toContain('Bob');
    expect(starred.body).not.toContain('Alice');
  });

  it('archives, restores and deletes', async () => {
    const archive = await formPost(h, `${msgUrl(2)}/archive`, session, {}, { 'hx-request': 'true' });
    expect(archive.statusCode).toBe(200);
    expect(archive.body).toBe('');
    expect((await get('/inbox')).body).not.toContain('Carol');
    expect((await get('/inbox?filter=archived')).body).toContain('Carol');

    const restore = await formPost(h, `${msgUrl(2)}/archive`, session, {});
    expect(restore.statusCode).toBe(302);
    expect((await get('/inbox')).body).toContain('Carol');

    const carolKey = h.ctx.repo.getMessage(ids[2]!)!.mp3_key!;
    expect(await h.ctx.storage.exists(carolKey)).toBe(true);
    const del = await formPost(h, `${msgUrl(2)}/delete`, session, {}, { 'hx-request': 'true' });
    expect(del.statusCode).toBe(200);
    // Deleting removes the audio from storage and erases the record, including the sender's details.
    expect(await h.ctx.storage.exists(carolKey)).toBe(false);
    expect(h.ctx.repo.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE id = ?').get(ids[2]!)).toEqual({ n: 0 });
    expect((await get('/inbox?filter=all')).body).not.toContain('Carol');
    expect((await get(`${msgUrl(2)}`)).statusCode).toBe(404);
    expect((await get(`${msgUrl(2)}/audio`)).statusCode).toBe(404);
  });

  it('saves private notes', async () => {
    const res = await formPost(h, `${msgUrl(0)}/notes`, session, { notes: 'Great question for episode 12' });
    expect(res.statusCode).toBe(302);
    const page = await get(`${msgUrl(0)}`);
    expect(page.body).toContain('Great question for episode 12');
  });

  it('sweeps up messages that were only hidden before, and retries after a storage failure', async () => {
    const m = h.ctx.repo.getMessage(ids[1]!)!;
    h.ctx.repo.updateMessage(m.id, { deleted_at: new Date().toISOString() });
    const real = h.ctx.storage.delete.bind(h.ctx.storage);
    h.ctx.storage.delete = async () => { throw new Error('storage offline'); };
    expect(await purgeDeleted(h.ctx)).toBe(0);
    expect(await h.ctx.storage.exists(m.mp3_key!)).toBe(true);
    expect(h.ctx.repo.listDeleted()).toHaveLength(1);
    h.ctx.storage.delete = real;
    expect(await purgeDeleted(h.ctx)).toBe(1);
    expect(await h.ctx.storage.exists(m.mp3_key!)).toBe(false);
    expect(h.ctx.repo.listDeleted()).toHaveLength(0);
  });

  async function submit(key: string, name: string, data: Buffer): Promise<string> {
    const body = multipart({ key, name, consent: 'true', 'cf-turnstile-response': 'ok' }, { data });
    const res = await h.app.inject({ method: 'POST', url: '/api/public/messages', payload: body.payload, headers: { ...body.headers, origin: APP_URL } });
    await h.ctx.queue.idle();
    return res.json().id as string;
  }

  it('retries a failed message from the original recording once the cause is fixed', async () => {
    const limited = h.ctx.repo.createShow({ name: 'Limit Show', max_seconds: 5 });
    const id = await submit(limited.site_key, 'Erin', makeAudio('webm-stream', 12));
    const failed = h.ctx.repo.getMessage(id)!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('longer than this show allows');
    expect(failed.original_key).toBeTruthy();
    const url = `/shows/${limited.slug}/messages/${id}`;

    const page = await get(url);
    expect(page.body).toContain('Retry processing');
    expect((await get(`/shows/${limited.slug}`)).body).toContain('longer than this show allows');

    // Raising the limit and retrying converts the saved original.
    h.ctx.repo.updateShow(limited.id, { max_seconds: 30 });
    const res = await formPost(h, `${url}/retry`, session, {});
    expect(res.statusCode).toBe(302);
    await h.ctx.queue.idle();
    const done = h.ctx.repo.getMessage(id)!;
    expect(done.status).toBe('ready');
    expect(done.error).toBeNull();
    expect(done.mp3_key).toBeTruthy();
    expect(done.original_key).toBeNull();
    // The saved original is removed from storage once the retry succeeds.
    expect(await h.ctx.storage.exists(failed.original_key!)).toBe(false);
    expect((await get(`${url}/audio`)).statusCode).toBe(200);
  });

  it('refuses to retry what cannot be retried and requires a token', async () => {
    const id = ids[0]!;
    // A ready message just goes back to its page.
    expect((await formPost(h, `${msgUrl(0)}/retry`, session, {})).statusCode).toBe(302);
    expect(h.ctx.repo.getMessage(id)!.status).toBe('ready');
    // A failed message with no saved original has nothing to retry from.
    const strict = h.ctx.repo.createShow({ name: 'Strict Show', max_seconds: 5 });
    const lost = await submit(strict.site_key, 'Frank', makeAudio('long-webm', 12));
    expect(h.ctx.repo.getMessage(lost)!.status).toBe('failed');
    h.ctx.repo.updateMessage(lost, { original_key: null });
    const res = await formPost(h, `/shows/${strict.slug}/messages/${lost}/retry`, session, {});
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('cannot be retried');
    expect(h.ctx.repo.getMessage(lost)!.status).toBe('failed');
    const denied = await h.app.inject({ method: 'POST', url: `/shows/${strict.slug}/messages/${lost}/retry`, headers: { cookie: session.cookie, origin: APP_URL } });
    expect(denied.statusCode).toBe(403);
  });

  it('shows when the email alert failed and lets the admin send it again', async () => {
    h.mail.fail = true;
    const id = await submit(show.site_key, 'Grace', makeAudio('webm-stream', 2));
    h.mail.fail = false;
    const m = h.ctx.repo.getMessage(id)!;
    expect(m.status).toBe('ready');
    expect(m.email_error).toContain('domain not verified');
    const url = `/shows/${show.slug}/messages/${id}`;
    expect((await get(`/shows/${show.slug}`)).body).toContain('email failed');
    const page = await get(url);
    expect(page.body).toContain('could not be sent');
    expect(page.body).toContain('domain not verified');

    const before = h.sent.length;
    const res = await formPost(h, `${url}/resend-alert`, session, {});
    expect(res.statusCode).toBe(302);
    expect(h.sent.length).toBe(before + 1);
    expect(h.ctx.repo.getMessage(id)!.email_error).toBeNull();
    expect((await get(url)).body).not.toContain('could not be sent');
  });

  it('deletes messages past the retention period, but keeps starred and recent ones', async () => {
    const r = await makeHarness({ RETENTION_DAYS: '30' });
    try {
      const s = r.ctx.repo.createShow({ name: 'Old Show' });
      const audio = makeAudio('webm-stream', 1);
      const make = async (name: string) => {
        const body = multipart({ key: s.site_key, name, consent: 'true', 'cf-turnstile-response': 'ok' }, { data: audio });
        const res = await r.app.inject({ method: 'POST', url: '/api/public/messages', payload: body.payload, headers: { ...body.headers, origin: APP_URL } });
        await r.ctx.queue.idle();
        return res.json().id as string;
      };
      const [oldId, oldStarred, recent] = [await make('Old'), await make('OldStar'), await make('Recent')];
      const longAgo = new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString();
      r.ctx.repo.db.prepare('UPDATE messages SET created_at = ? WHERE id IN (?, ?)').run(longAgo, oldId, oldStarred);
      r.ctx.repo.updateMessage(oldStarred, { starred: 1 });
      const oldKey = r.ctx.repo.getMessage(oldId)!.mp3_key!;
      expect(await purgeExpired(r.ctx)).toBe(1);
      expect(r.ctx.repo.getMessage(oldId)).toBeUndefined();
      expect(await r.ctx.storage.exists(oldKey)).toBe(false);
      expect(r.ctx.repo.getMessage(oldStarred)).toBeDefined();
      expect(r.ctx.repo.getMessage(recent)).toBeDefined();
    } finally {
      await r.close();
    }
    const never = await makeHarness();
    try {
      expect(await purgeExpired(never.ctx)).toBe(0);
    } finally {
      await never.close();
    }
  });

  it('shows a failed message with its reason', async () => {
    const short = h.ctx.repo.createShow({ name: 'Short Show', max_seconds: 5 });
    const id = await submit(short.site_key, 'Dave', makeAudio('long-webm', 12));
    const page = await get(`/shows/${short.slug}/messages/${id}`);
    expect(page.body).toContain('could not be processed');
    expect((await get('/inbox?filter=failed')).body).toContain('Dave');
    expect((await get(`/shows/${short.slug}/messages/${id}/audio`)).statusCode).toBe(404);
  });
});

describe('admin: settings page', () => {
  let h: Harness;
  let session: { cookie: string; csrf: string };
  beforeAll(async () => {
    h = await makeHarness();
    session = await login(h);
  });
  afterAll(async () => {
    await h.close();
  });
  const get = (url: string) => h.app.inject({ method: 'GET', url, headers: { cookie: session.cookie } });

  it('shows the configuration without revealing any secret', async () => {
    const res = await get('/settings');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Settings');
    expect(res.body).toContain('Per-IP limit');
    expect(res.body).toContain(h.config.turnstile.siteKey);
    for (const secret of [h.config.turnstile.secretKey, h.config.sessionSecret]) expect(res.body).not.toContain(secret);
    expect((await h.app.inject({ method: 'GET', url: '/settings' })).statusCode).toBe(302);
  });

  it('sends a test email to the admin, and reports a failure with its reason', async () => {
    const ok = await formPost(h, '/settings/test-email', session, {});
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('Test email sent');
    expect(h.sent.at(-1)!.to).toBe(ADMIN_EMAIL);
    h.mail.fail = true;
    const bad = await formPost(h, '/settings/test-email', session, {});
    h.mail.fail = false;
    expect(bad.body).toContain('could not be sent');
    expect(bad.body).toContain('domain not verified');
    expect((await h.app.inject({ method: 'POST', url: '/settings/test-email', headers: { cookie: session.cookie, origin: APP_URL } })).statusCode).toBe(403);
  });

  it('checks that storage can write, read and delete', async () => {
    const ok = await formPost(h, '/settings/test-storage', session, {});
    expect(ok.body).toContain('Storage works');
    expect(ok.body).toContain('Deleted it');
    expect(fs.existsSync(path.join(h.config.localStoragePath, 'healthcheck')) ? fs.readdirSync(path.join(h.config.localStoragePath, 'healthcheck')) : []).toEqual([]);
    const real = h.ctx.storage.put.bind(h.ctx.storage);
    h.ctx.storage.put = async () => { throw new Error('AccessDenied'); };
    const bad = await formPost(h, '/settings/test-storage', session, {});
    h.ctx.storage.put = real;
    expect(bad.body).toContain('Storage check failed');
    expect(bad.body).toContain('AccessDenied');
  });

  it('changes the password, signs out other sessions and rejects bad attempts', async () => {
    const other = await login(h);
    const wrong = await formPost(h, '/account/password', session, { current: 'not the password', next: 'a brand new password', confirm: 'a brand new password' });
    expect(wrong.statusCode).toBe(401);
    const short = await formPost(h, '/account/password', session, { current: ADMIN_PASSWORD, next: 'short', confirm: 'short' });
    expect(short.statusCode).toBe(400);
    const mismatch = await formPost(h, '/account/password', session, { current: ADMIN_PASSWORD, next: 'a brand new password', confirm: 'a different one!!' });
    expect(mismatch.body).toContain('did not match');
    const same = await formPost(h, '/account/password', session, { current: ADMIN_PASSWORD, next: ADMIN_PASSWORD, confirm: ADMIN_PASSWORD });
    expect(same.body).toContain('different');

    const ok = await formPost(h, '/account/password', session, { current: ADMIN_PASSWORD, next: 'a brand new password', confirm: 'a brand new password' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('Password changed');
    expect((await get('/inbox')).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/inbox', headers: { cookie: other.cookie } })).statusCode).toBe(302);

    const oldLogin = await formPost(h, '/login', { cookie: '' }, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await formPost(h, '/login', { cookie: '' }, { email: ADMIN_EMAIL, password: 'a brand new password' });
    expect(newLogin.statusCode).toBe(302);
  });
});
