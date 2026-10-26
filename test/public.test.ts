import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_URL, hasFfmpeg, makeAudio, makeHarness, multipart, probeDuration, type Harness } from './helpers.js';
import type { Show } from '../src/db/repo.js';

const ffmpeg = hasFfmpeg();
const SITE = 'https://randyunscripted.com';

describe.skipIf(!ffmpeg)('public API and processing pipeline', () => {
  let h: Harness;
  let show: Show;
  let webm: Buffer;
  let m4a: Buffer;

  beforeAll(async () => {
    h = await makeHarness();
    show = h.ctx.repo.createShow({ name: 'Randy Unscripted', allowed_origins: JSON.stringify([SITE]), notify_email: 'randy@example.com', max_seconds: 5 });
    webm = makeAudio('webm-stream', 2);
    m4a = makeAudio('m4a', 2);
  });
  afterAll(async () => {
    await h.close();
  });

  const submit = async (
    fields: Record<string, string> = {},
    file: { filename?: string; type?: string; data: Buffer } | null = { data: webm },
    headers: Record<string, string> = {},
  ) => {
    const body = multipart(
      { key: show.site_key, name: 'Pat Listener', consent: 'true', 'cf-turnstile-response': 'ok-token', ...fields },
      file ?? undefined,
    );
    return h.app.inject({
      method: 'POST',
      url: '/api/public/messages',
      payload: body.payload,
      headers: { ...body.headers, origin: APP_URL, ...headers },
    });
  };

  const tmpFiles = () => fs.readdirSync(h.config.tmpDir);

  it('serves the embed loader as cacheable JavaScript', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/embed.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.headers['cache-control']).toContain('max-age');
    expect(res.body).toContain('data-site-key');
  });

  it('serves the widget only inside the show\'s allowed sites', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/widget?key=${show.site_key}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toContain(`frame-ancestors ${SITE}`);
    expect(res.headers['content-security-policy']).toContain('https://challenges.cloudflare.com');
    expect(res.body).toContain('id="btn-record"');

    const none = h.ctx.repo.createShow({ name: 'No origins yet' });
    const locked = await h.app.inject({ method: 'GET', url: `/widget?key=${none.site_key}` });
    expect(locked.headers['content-security-policy']).toContain("frame-ancestors 'none'");

    const unknown = await h.app.inject({ method: 'GET', url: '/widget?key=pk_nope' });
    expect(unknown.statusCode).toBe(404);
  });

  it('shares show settings with CORS only for allowed sites', async () => {
    const ok = await h.app.inject({ method: 'GET', url: `/api/public/config?key=${show.site_key}`, headers: { origin: SITE } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe(SITE);
    const body = ok.json();
    expect(body.show.name).toBe('Randy Unscripted');
    expect(body.show.askEmail).toBe(true);
    expect(body.turnstileSiteKey).toBe('1x00000000000000000000AA');
    expect(JSON.stringify(body)).not.toContain(show.site_key);

    const other = await h.app.inject({ method: 'GET', url: `/api/public/config?key=${show.site_key}`, headers: { origin: 'https://evil.example' } });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();

    const missing = await h.app.inject({ method: 'GET', url: '/api/public/config?key=pk_nope' });
    expect(missing.statusCode).toBe(404);
  });

  it('turns a headerless browser WebM recording into a stored MP3 and emails the show', async () => {
    const res = await submit({ email: 'pat@example.com' });
    expect(res.statusCode).toBe(202);
    const { id, status } = res.json();
    expect(status).toBe('processing');
    await h.ctx.queue.idle();

    const m = h.ctx.repo.getMessage(id)!;
    expect(m.status).toBe('ready');
    expect(m.sender_name).toBe('Pat Listener');
    expect(m.sender_email).toBe('pat@example.com');
    expect(m.consent_given).toBe(1);
    expect(m.ip_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(m.mp3_key).toMatch(new RegExp(`^shows/${show.id}/\\d{4}/${id}\\.mp3$`));
    expect(m.original_key).toBeNull();
    expect(m.duration_seconds).toBeGreaterThan(1.5);
    expect(m.duration_seconds).toBeLessThan(2.6);

    const file = path.join(h.config.localStoragePath, m.mp3_key!);
    const info = probeDuration(file);
    expect(info.codec).toBe('mp3');
    expect(info.channels).toBe(1);
    expect(fs.readFileSync(file).length).toBe(m.size_bytes);

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.to).toBe('randy@example.com');
    expect(h.sent[0]!.subject).toContain('Pat Listener');
    expect(h.sent[0]!.text).toContain(`/admin/messages/${id}`);
    expect(tmpFiles()).toEqual([]);
  });

  it('accepts Safari-style MP4/AAC recordings', async () => {
    const res = await submit({}, { filename: 'recording.m4a', type: 'audio/mp4', data: m4a });
    expect(res.statusCode).toBe(202);
    await h.ctx.queue.idle();
    const m = h.ctx.repo.getMessage(res.json().id)!;
    expect(m.status).toBe('ready');
    expect(m.sender_email).toBeNull();
    expect(probeDuration(path.join(h.config.localStoragePath, m.mp3_key!)).codec).toBe('mp3');
  });

  it('requires a name', async () => {
    const before = h.ctx.repo.countMessages('all');
    for (const name of ['', '   ', '\n\t']) {
      const res = await submit({ name });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('name_required');
    }
    const noField = multipart({ key: show.site_key, consent: 'true', 'cf-turnstile-response': 'ok-token' }, { data: webm });
    const res = await h.app.inject({ method: 'POST', url: '/api/public/messages', payload: noField.payload, headers: { ...noField.headers, origin: APP_URL } });
    expect(res.json().error).toBe('name_required');
    expect(h.ctx.repo.countMessages('all')).toBe(before);
    expect(tmpFiles()).toEqual([]);
  });

  it('treats email as optional but validates it when given', async () => {
    expect((await submit({ email: '' })).statusCode).toBe(202);
    const bad = await submit({ email: 'not-an-email' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_email');
    await h.ctx.queue.idle();
  });

  it('rejects bad submissions without leaving files behind', async () => {
    expect((await submit({ key: 'pk_nope' })).statusCode).toBe(404);
    expect((await submit({ consent: 'false' })).json().error).toBe('consent_required');
    expect((await submit({}, null)).json().error).toBe('audio_required');
    expect((await submit({}, { data: Buffer.alloc(0) })).json().error).toBe('audio_required');
    expect((await submit({ 'cf-turnstile-response': '' })).json().error).toBe('turnstile_required');
    const failed = await submit({ 'cf-turnstile-response': 'bad-token' });
    expect(failed.statusCode).toBe(403);
    expect(failed.json().error).toBe('turnstile_failed');
    const foreign = await submit({}, { data: webm }, { origin: 'https://evil.example' });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error).toBe('bad_origin');
    const notMultipart = await h.app.inject({ method: 'POST', url: '/api/public/messages', payload: { a: 1 }, headers: { origin: APP_URL } });
    expect(notMultipart.statusCode).toBe(415);
    expect(tmpFiles()).toEqual([]);
  });

  it('strips control characters from names and ignores email when the show hides it', async () => {
    const quiet = h.ctx.repo.createShow({ name: 'Quiet', ask_email: 0 });
    const body = multipart(
      { key: quiet.site_key, name: 'Sam\r\nBcc: x@evil.example', email: 'sam@example.com', consent: 'true', 'cf-turnstile-response': 'ok' },
      { data: webm },
    );
    const res = await h.app.inject({ method: 'POST', url: '/api/public/messages', payload: body.payload, headers: { ...body.headers, origin: APP_URL } });
    expect(res.statusCode).toBe(202);
    await h.ctx.queue.idle();
    const m = h.ctx.repo.getMessage(res.json().id)!;
    expect(m.sender_name).toBe('Sam Bcc: x@evil.example');
    expect(m.sender_email).toBeNull();
  });

  it('marks non-audio uploads failed and keeps the original for inspection', async () => {
    const res = await submit({}, { filename: 'notes.webm', type: 'audio/webm', data: Buffer.from('this is definitely not audio') });
    expect(res.statusCode).toBe(202);
    await h.ctx.queue.idle();
    const m = h.ctx.repo.getMessage(res.json().id)!;
    expect(m.status).toBe('failed');
    expect(m.error).toBeTruthy();
    expect(m.mp3_key).toBeNull();
    expect(m.original_key).toBeTruthy();
    expect(fs.existsSync(path.join(h.config.localStoragePath, m.original_key!))).toBe(true);
    expect(tmpFiles()).toEqual([]);
  });

  it('refuses playlist files that could make ffmpeg read other files or URLs', async () => {
    const playlist = Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1,\n/etc/passwd\n#EXTINF:1,\nhttp://127.0.0.1:9/x\n#EXT-X-ENDLIST\n');
    const res = await submit({}, { filename: 'a.m3u8', type: 'audio/webm', data: playlist });
    await h.ctx.queue.idle();
    const m = h.ctx.repo.getMessage(res.json().id)!;
    expect(m.status).toBe('failed');
    expect(m.mp3_key).toBeNull();
  });

  it('rejects recordings longer than the show allows', async () => {
    const long = makeAudio('long-webm', 12);
    const res = await submit({}, { data: long });
    expect(res.statusCode).toBe(202);
    await h.ctx.queue.idle();
    const m = h.ctx.repo.getMessage(res.json().id)!;
    expect(m.status).toBe('failed');
    expect(m.error).toContain('longer');
    expect(m.mp3_key).toBeNull();
  });

  it('keeps the original when the show asks for it', async () => {
    const keeper = h.ctx.repo.createShow({ name: 'Keeper', retain_original: 1 });
    const body = multipart({ key: keeper.site_key, name: 'Kim', consent: 'true', 'cf-turnstile-response': 'ok' }, { data: webm });
    const res = await h.app.inject({ method: 'POST', url: '/api/public/messages', payload: body.payload, headers: { ...body.headers, origin: APP_URL } });
    await h.ctx.queue.idle();
    const m = h.ctx.repo.getMessage(res.json().id)!;
    expect(m.status).toBe('ready');
    expect(m.original_key).toMatch(/\.orig$/);
    expect(fs.existsSync(path.join(h.config.localStoragePath, m.original_key!))).toBe(true);
  });

  it('enforces the per-IP hourly limit', async () => {
    const limited = await makeHarness({ RATE_LIMIT_PER_HOUR: '2' });
    try {
      const s = limited.ctx.repo.createShow({ name: 'Limited' });
      const send = () => {
        const body = multipart({ key: s.site_key, name: 'Lee', consent: 'true', 'cf-turnstile-response': 'ok' }, { data: webm });
        return limited.app.inject({ method: 'POST', url: '/api/public/messages', payload: body.payload, headers: { ...body.headers, origin: APP_URL } });
      };
      expect((await send()).statusCode).toBe(202);
      expect((await send()).statusCode).toBe(202);
      const third = await send();
      expect(third.statusCode).toBe(429);
      expect(third.json().error).toBe('rate_limited');
    } finally {
      await limited.close();
    }
  });

  it('rejects oversized uploads', async () => {
    const small = await makeHarness({ MAX_UPLOAD_MB: '1' });
    try {
      const s = small.ctx.repo.createShow({ name: 'Small' });
      const body = multipart({ key: s.site_key, name: 'Lee', consent: 'true', 'cf-turnstile-response': 'ok' }, { data: Buffer.alloc(1_500_000, 1) });
      const res = await small.app.inject({ method: 'POST', url: '/api/public/messages', payload: body.payload, headers: { ...body.headers, origin: APP_URL } });
      expect(res.statusCode).toBe(413);
      expect(small.ctx.repo.countMessages('all')).toBe(0);
      expect(fs.readdirSync(small.config.tmpDir)).toEqual([]);
    } finally {
      await small.close();
    }
  });
});

describe('Turnstile hostname check', () => {
  it('requires the challenge to be solved on the app domain for real keys', async () => {
    let hostname = 'listenerloop.test';
    const h = await makeHarness({ TURNSTILE_SECRET_KEY: '0x4AAAAAAAreal-secret' }, async () => ({ success: true, hostname, errorCodes: [] }));
    try {
      const s = h.ctx.repo.createShow({ name: 'Host check' });
      const send = () => {
        const body = multipart({ key: s.site_key, name: 'Lee', consent: 'true', 'cf-turnstile-response': 'tok' }, { data: Buffer.from('x') });
        return h.app.inject({ method: 'POST', url: '/api/public/messages', payload: body.payload, headers: { ...body.headers, origin: APP_URL } });
      };
      expect((await send()).statusCode).toBe(202);
      hostname = 'randyunscripted.com';
      const wrong = await send();
      expect(wrong.statusCode).toBe(403);
      expect(wrong.json().error).toBe('turnstile_failed');
      await h.ctx.queue.idle();
    } finally {
      await h.close();
    }
  });
});
