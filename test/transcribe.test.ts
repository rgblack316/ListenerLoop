import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanTranscript } from '../src/transcribe.js';
import { APP_URL, formPost, hasFfmpeg, login, makeAudio, makeHarness, multipart, type Harness } from './helpers.js';

const ffmpeg = hasFfmpeg();

describe('cleanTranscript', () => {
  it('drops silence tags and tidies whitespace', () => {
    expect(cleanTranscript(' [BLANK_AUDIO]\n')).toBe('');
    expect(cleanTranscript('Hello   there [ Silence ] friend.\n(music)')).toBe('Hello there friend.');
  });
});

describe.skipIf(!ffmpeg)('transcription', () => {
  let h: Harness;
  let fakeDir: string;
  let cookie = '';
  let csrf = '';

  beforeAll(async () => {
    // Stand-in for whisper-cli: prints text, or fails when a "fail" file sits next to it.
    fakeDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fake-whisper-'));
    const bin = path.join(fakeDir, 'whisper-cli');
    fs.writeFileSync(bin, '#!/bin/sh\n[ -e "$(dirname "$0")/fail" ] && { echo "model exploded" >&2; exit 3; }\nprintf " Hello from the gardening show. [BLANK_AUDIO]\\n"\n', { mode: 0o755 });
    h = await makeHarness({ TRANSCRIPTION: 'whisper', WHISPER_BIN: bin, WHISPER_MODEL: 'tiny.en' });
    fs.mkdirSync(h.config.whisperModelDir, { recursive: true });
    fs.writeFileSync(path.join(h.config.whisperModelDir, 'ggml-tiny.en.bin'), 'not a real model');
    ({ cookie, csrf } = await login(h));
  });
  afterAll(async () => {
    await h.ctx.transcribeQueue.idle();
    await h.close();
    fs.rmSync(fakeDir, { recursive: true, force: true });
  });

  const send = async (key: string) => {
    const body = multipart({ key, name: 'Tess', consent: 'true', 'cf-turnstile-response': 'ok' }, { data: makeAudio('webm-stream') });
    const res = await h.app.inject({ method: 'POST', url: '/api/public/messages', payload: body.payload, headers: { ...body.headers, origin: APP_URL } });
    expect(res.statusCode).toBe(202);
    await h.ctx.queue.idle();
    await h.ctx.transcribeQueue.idle();
    return h.ctx.repo.getMessage(res.json().id)!;
  };

  it('does nothing for a show that has not turned it on', async () => {
    const off = h.ctx.repo.createShow({ name: 'Off' });
    const m = await send(off.site_key);
    expect(m.status).toBe('ready');
    expect(m.transcript_status).toBeNull();
    expect(m.transcript).toBeNull();
  });

  it('transcribes new messages for an opted-in show, and the text is searchable', async () => {
    const on = h.ctx.repo.createShow({ name: 'On', transcribe: 1 });
    const m = await send(on.site_key);
    expect(m.transcript_status).toBe('done');
    expect(m.transcript).toBe('Hello from the gardening show.');
    expect(m.transcript_seconds).toBeGreaterThanOrEqual(0);
    const found = await h.app.inject({ method: 'GET', url: `/shows/${on.slug}?q=gardening`, headers: { cookie } });
    expect(found.body).toContain('<mark>gardening</mark>');
    const page = await h.app.inject({ method: 'GET', url: `/shows/${on.slug}/messages/${m.id}`, headers: { cookie } });
    expect(page.body).toContain('Hello from the gardening show.');
    const txt = await h.app.inject({ method: 'GET', url: `/shows/${on.slug}/messages/${m.id}/transcript.txt`, headers: { cookie } });
    expect(txt.statusCode).toBe(200);
    expect(txt.headers['content-disposition']).toContain('attachment');
    expect(txt.body).toContain('Hello from the gardening show.');
  });

  it('records a failure, and "Try again" recovers once the cause is fixed', async () => {
    const on = h.ctx.repo.createShow({ name: 'Flaky', transcribe: 1 });
    fs.writeFileSync(path.join(fakeDir, 'fail'), '');
    const m = await send(on.site_key);
    expect(m.status).toBe('ready'); // a transcript problem never affects the message itself
    expect(m.transcript_status).toBe('failed');
    expect(m.transcript_error).toContain('model exploded');
    fs.rmSync(path.join(fakeDir, 'fail'));
    const url = `/shows/${on.slug}/messages/${m.id}/transcribe`;
    const res = await formPost(h, url, { cookie, csrf }, {});
    expect(res.statusCode).toBe(302);
    await h.ctx.transcribeQueue.idle();
    expect(h.ctx.repo.getMessage(m.id)!.transcript_status).toBe('done');
  });

  it('only transcribes a message from its own show URL', async () => {
    const a = h.ctx.repo.createShow({ name: 'Aaa', transcribe: 1 });
    const b = h.ctx.repo.createShow({ name: 'Bbb' });
    const m = await send(a.site_key);
    const res = await h.app.inject({ method: 'GET', url: `/shows/${b.slug}/messages/${m.id}/transcript.txt`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });

  it('saves the per-show setting', async () => {
    const s = h.ctx.repo.createShow({ name: 'Toggle' });
    const form = await h.app.inject({ method: 'GET', url: `/shows/${s.slug}/settings`, headers: { cookie } });
    expect(form.body).toContain('name="transcribe"');
    const res = await formPost(h, `/shows/${s.slug}/settings`, { cookie, csrf }, { name: 'Toggle', slug: s.slug, max_seconds: '60', accent_color: '#21649e', transcribe: '1', allowed_origins: APP_URL, notify_email: 'h@example.com' });
    expect(res.statusCode).toBe(302);
    expect(h.ctx.repo.getShow(s.id)!.transcribe).toBe(1);
  });
});

describe('transcription switched off on the server', () => {
  it('reports it on the message page and refuses to queue', async () => {
    const h = await makeHarness();
    try {
      const { cookie, csrf } = await login(h);
      const s = h.ctx.repo.createShow({ name: 'Quiet', transcribe: 1 });
      h.ctx.repo.insertMessage({ id: 'x1', show_id: s.id, sender_name: 'Q', sender_email: null, consent_given: 1, original_mime: null, ip_hash: null, user_agent: null });
      h.ctx.repo.updateMessage('x1', { status: 'ready', mp3_key: 'k.mp3' });
      const res = await formPost(h, `/shows/${s.slug}/messages/x1/transcribe`, { cookie, csrf }, {});
      expect(res.headers.location).toContain('flash=notranscribe');
      expect(h.ctx.repo.getMessage('x1')!.transcript_status).toBeNull();
    } finally {
      await h.close();
    }
  });
});
