import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_URL, hasFfmpeg, makeAudio, makeHarness, multipart, type Harness } from './helpers.js';
import type { Show } from '../src/db/repo.js';

/**
 * A scripted run of abusive and malformed submissions. Every one must be refused, and
 * afterwards nothing may have been stored and no temporary file may be left behind.
 */
const ffmpeg = hasFfmpeg();

describe.skipIf(!ffmpeg)('abuse protection', () => {
  let h: Harness;
  let show: Show;
  const good = ffmpeg ? makeAudio('webm-stream', 1) : Buffer.alloc(0);

  beforeAll(async () => {
    h = await makeHarness({ MAX_UPLOAD_MB: '1' });
    show = h.ctx.repo.createShow({ name: 'Target', max_seconds: 5 });
  });
  afterAll(async () => {
    await h.close();
  });

  const post = (fields: Record<string, string>, file?: { type?: string; filename?: string; data: Buffer }, origin = APP_URL, key = show.site_key) => {
    const body = multipart({ key, name: 'Mallory', consent: 'true', 'cf-turnstile-response': 'tok', ...fields }, file);
    return h.app.inject({ method: 'POST', url: '/api/public/messages', payload: body.payload, headers: { ...body.headers, origin } });
  };

  const refused: [string, () => ReturnType<typeof post>, number, string][] = [
    ['oversized file', () => post({}, { data: Buffer.alloc(1_500_000, 7) }), 413, ''],
    ['text file posing as audio', () => post({}, { filename: 'a.mp3', type: 'audio/mpeg', data: Buffer.from('hello, not audio') }), 415, 'unsupported_audio'],
    ['image posing as audio', () => post({}, { filename: 'a.mp3', type: 'audio/mpeg', data: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex') }), 415, 'unsupported_audio'],
    ['HLS playlist reading local files', () => post({}, { filename: 'a.m3u8', data: Buffer.from('#EXTM3U\n#EXTINF:1,\n/etc/passwd\n#EXT-X-ENDLIST\n') }), 415, 'unsupported_audio'],
    ['ffconcat script', () => post({}, { filename: 'a.txt', data: Buffer.from("ffconcat version 1.0\nfile '/etc/passwd'\n") }), 415, 'unsupported_audio'],
    ['missing Turnstile token', () => post({ 'cf-turnstile-response': '' }, { data: good }), 400, 'turnstile_required'],
    ['bad Turnstile token', () => post({ 'cf-turnstile-response': 'bad-token' }, { data: good }), 403, 'turnstile_failed'],
    ['wrong origin', () => post({}, { data: good }, 'https://evil.example'), 403, 'bad_origin'],
    ['unknown site key', () => post({}, { data: good }, APP_URL, 'pk_does_not_exist'), 404, 'unknown_site_key'],
    ['no name', () => post({ name: '' }, { data: good }), 400, 'name_required'],
    ['blank name', () => post({ name: '   ' }, { data: good }), 400, 'name_required'],
    ['no consent', () => post({ consent: 'false' }, { data: good }), 400, 'consent_required'],
    ['bad email', () => post({ email: 'not-an-email' }, { data: good }), 400, 'invalid_email'],
    ['no audio', () => post({}), 400, 'audio_required'],
    ['audio longer than the show allows', () => post({}, { filename: 'long.m4a', data: makeAudio('m4a', 30) }), 400, 'too_long'],
  ];

  for (const [name, send, status, error] of refused) {
    it(`refuses: ${name}`, async () => {
      const res = await send();
      expect(res.statusCode).toBe(status);
      if (error) expect(res.json().error).toBe(error);
    });
  }

  it('refuses a request that is not a multipart upload', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/api/public/messages', payload: { name: 'x' }, headers: { origin: APP_URL } });
    expect(res.statusCode).toBe(415);
  });

  it('keeps the flood limits: per IP, per show per hour, and per show per day', async () => {
    const perIp = await makeHarness({ RATE_LIMIT_PER_HOUR: '2' });
    const perShow = await makeHarness({ RATE_LIMIT_PER_HOUR: '100', RATE_LIMIT_PER_SHOW_HOUR: '2' });
    const perDay = await makeHarness({ RATE_LIMIT_PER_HOUR: '100', DAILY_CAP_PER_SHOW: '2' });
    try {
      for (const [harness, error] of [[perIp, 'rate_limited'], [perShow, 'show_busy'], [perDay, 'show_busy']] as const) {
        const s = harness.ctx.repo.createShow({ name: 'Flooded' });
        const send = () => {
          const body = multipart({ key: s.site_key, name: 'Bot', consent: 'true', 'cf-turnstile-response': 'tok' }, { data: good });
          return harness.app.inject({ method: 'POST', url: '/api/public/messages', payload: body.payload, headers: { ...body.headers, origin: APP_URL } });
        };
        expect((await send()).statusCode).toBe(202);
        expect((await send()).statusCode).toBe(202);
        const third = await send();
        expect(third.statusCode).toBe(429);
        expect(third.json().error).toBe(error);
        await harness.ctx.queue.idle();
        expect(harness.ctx.repo.countMessages('all')).toBe(2);
      }
    } finally {
      await perIp.close();
      await perShow.close();
      await perDay.close();
    }
  });

  it('left nothing behind: no messages stored and no temporary files', async () => {
    await h.ctx.queue.idle();
    expect(h.ctx.repo.countMessages('all')).toBe(0);
    expect(fs.readdirSync(h.config.tmpDir)).toEqual([]);
    expect(fs.existsSync(h.config.localStoragePath) ? fs.readdirSync(h.config.localStoragePath) : []).toEqual([]);
  });
});
