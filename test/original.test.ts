import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash } from '@node-rs/argon2';
import type { Show } from '../src/db/repo.js';
import { login, makeHarness, type Harness } from './helpers.js';

describe('original vs processed audio', () => {
  let h: Harness;
  let owner: { cookie: string; csrf: string };
  let a: Show;
  let b: Show;
  const url = (s: Show, id: string, tail = ''): string => `/shows/${s.slug}/messages/${id}${tail}`;
  const get = (u: string, s: { cookie: string }, headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url: u, headers: { cookie: s.cookie, ...headers } });
  const add = async (id: string, s: Show, name: string, original: { mime: string | null; body?: string } | null): Promise<void> => {
    h.ctx.repo.insertMessage({ id, show_id: s.id, sender_name: name, sender_email: null, consent_given: 1, original_mime: original?.mime ?? null, ip_hash: null, user_agent: null });
    await h.ctx.storage.put(`${id}.mp3`, Buffer.from('processed-mp3-bytes'), 'audio/mpeg');
    const fields: Record<string, unknown> = { status: 'ready', mp3_key: `${id}.mp3`, duration_seconds: 12.5 };
    if (original?.body) {
      await h.ctx.storage.put(`${id}.orig`, Buffer.from(original.body), 'application/octet-stream');
      fields.original_key = `${id}.orig`;
    }
    h.ctx.repo.updateMessage(id, fields);
  };

  beforeAll(async () => {
    h = await makeHarness();
    owner = await login(h);
    a = h.ctx.repo.createShow({ name: 'Orig A', notify_email: 'a@example.com' });
    b = h.ctx.repo.createShow({ name: 'Orig B', notify_email: 'b@example.com' });
    await add('kept', a, 'Kay Kept', { mime: 'audio/webm;codecs=opus', body: 'original-webm-bytes' });
    await add('plain', a, 'Pat Plain', null);
    await add('odd', a, 'Odd Type', { mime: 'text/html', body: '<script>alert(1)</script>' });
    await add('other', b, 'Other Show', { mime: 'audio/mp4', body: 'mp4-bytes' });
  });
  afterAll(async () => h.close());

  it('offers a version dropdown only when the original was kept', async () => {
    const kept = (await get(url(a, 'kept'), owner)).body;
    expect(kept).toContain('data-version');
    expect(kept).toContain('Original recording');
    expect(kept).toContain(`${url(a, 'kept', '/audio')}?version=original`);
    const plain = (await get(url(a, 'plain'), owner)).body;
    expect(plain).not.toContain('data-version');
    expect(plain).toContain('original recording was not kept');
    expect(plain).toContain('Keep the original recording');
  });

  it('serves the original with its own type, range support and a sensible download name', async () => {
    const orig = await get(url(a, 'kept', '/audio?version=original'), owner);
    expect(orig.statusCode).toBe(200);
    expect(orig.headers['content-type']).toBe('audio/webm');
    expect(orig.body).toBe('original-webm-bytes');
    expect(orig.headers['x-content-type-options']).toBe('nosniff');
    const part = await get(url(a, 'kept', '/audio?version=original'), owner, { range: 'bytes=0-7' });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('original');
    const dl = await get(url(a, 'kept', '/audio?version=original&download=1'), owner);
    expect(dl.headers['content-disposition']).toMatch(/orig-a-kay-kept-\d{4}-\d{2}-\d{2}-original\.webm/);
    // the default is still the MP3
    const proc = await get(url(a, 'kept', '/audio'), owner);
    expect(proc.headers['content-type']).toBe('audio/mpeg');
    expect(proc.body).toBe('processed-mp3-bytes');
  });

  it('never serves an unknown stored type as something a browser would run', async () => {
    const odd = await get(url(a, 'odd', '/audio?version=original'), owner);
    expect(odd.headers['content-type']).toBe('application/octet-stream');
    expect(odd.headers['x-content-type-options']).toBe('nosniff');
    expect((await get(url(a, 'odd', '/audio?version=original&download=1'), owner)).headers['content-disposition']).toContain('.bin');
  });

  it('404s when there is no original, and keeps the same show-access rules', async () => {
    expect((await get(url(a, 'plain', '/audio?version=original'), owner)).statusCode).toBe(404);
    expect((await get(url(a, 'other', '/audio?version=original'), owner)).statusCode).toBe(404); // wrong show in the address
    expect((await h.app.inject({ method: 'GET', url: url(a, 'kept', '/audio?version=original') })).statusCode).toBe(302);

    const u = h.ctx.repo.createUser({ email: 'v@example.com', passwordHash: await hash('a long enough password'), role: 'viewer', showIds: [b.id] });
    const v = await login(h, u.email, 'a long enough password');
    expect((await get(url(a, 'kept', '/audio?version=original'), v)).statusCode).toBe(404); // not their show
    expect((await get(url(b, 'other', '/audio?version=original'), v)).statusCode).toBe(200); // viewers may listen
    expect((await get(url(b, 'other', '/audio?version=original'), v)).headers['content-type']).toBe('audio/mp4');
  });

  it('lets people download the original of a message that failed processing', async () => {
    h.ctx.repo.updateMessage('kept', { status: 'failed', error: 'ffmpeg exploded', mp3_key: null });
    const page = (await get(url(a, 'kept'), owner)).body;
    expect(page).toContain('Download the original');
    expect((await get(url(a, 'kept', '/audio?version=original'), owner)).statusCode).toBe(200);
    expect((await get(url(a, 'kept', '/audio'), owner)).statusCode).toBe(404);
  });
});
