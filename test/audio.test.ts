import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computePeaks } from '../src/media/waveform.js';
import { backfillWaveforms } from '../src/process.js';
import { APP_URL, hasFfmpeg, login, makeHarness, multipart, type Harness } from './helpers.js';

const ffmpeg = hasFfmpeg();
const tmp = (name: string): string => path.join(os.tmpdir(), `ll-audio-${process.pid}-${Math.random().toString(16).slice(2)}-${name}`);

/** A quiet 440 Hz tone (about -35 dB) followed by `silenceSeconds` of silence, as a streamed WebM like a browser makes. */
function quietWebm(seconds = 3, silenceSeconds = 0): Buffer {
  const filter = `sine=frequency=440:duration=${seconds},volume=-35dB${silenceSeconds ? `,apad=pad_dur=${silenceSeconds}` : ''}`;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', filter, '-c:a', 'libopus', '-f', 'webm', 'pipe:1'], { maxBuffer: 20 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(String(r.stderr));
  return r.stdout;
}

function meanVolumeDb(file: string): number {
  const r = spawnSync('ffmpeg', ['-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /mean_volume: (-?[\d.]+) dB/.exec(r.stderr);
  if (!m) throw new Error(r.stderr);
  return Number(m[1]);
}

describe.skipIf(!ffmpeg)('waveform peaks', () => {
  it('follows the loudness over time and stays within bounds', async () => {
    const f = tmp('tone.webm');
    fs.writeFileSync(f, quietWebm(2, 2));
    const peaks = await computePeaks(f);
    fs.rmSync(f, { force: true });
    expect(peaks.length).toBe(120);
    expect(Math.max(...peaks)).toBe(100);
    expect(Math.min(...peaks)).toBeGreaterThanOrEqual(3);
    const first = peaks.slice(5, 50);
    const last = peaks.slice(75, 115);
    expect(Math.min(...first)).toBeGreaterThan(60);
    expect(Math.max(...last)).toBeLessThan(20);
  });

  it('returns nothing for a file with no audio', async () => {
    const f = tmp('empty.txt');
    fs.writeFileSync(f, 'not audio');
    await expect(computePeaks(f)).rejects.toThrow();
    fs.rmSync(f, { force: true });
  });
});

describe.skipIf(!ffmpeg)('loudness, waveform storage and backfill', () => {
  let h: Harness;
  let cookie: string;
  beforeAll(async () => {
    h = await makeHarness();
    ({ cookie } = await login(h));
  });
  afterAll(async () => {
    await h.close();
  });

  const send = async (key: string): Promise<string> => {
    const body = multipart({ key, name: 'Quinn', consent: 'true', 'cf-turnstile-response': 'ok' }, { data: quietWebm() });
    const res = await h.app.inject({ method: 'POST', url: '/api/public/messages', payload: body.payload, headers: { ...body.headers, origin: APP_URL } });
    expect(res.statusCode).toBe(202);
    await h.ctx.queue.idle();
    return res.json().id as string;
  };

  it('evens out quiet messages only when the show asks, and stores a waveform', async () => {
    const plain = h.ctx.repo.createShow({ name: 'Plain' });
    const loud = h.ctx.repo.createShow({ name: 'Loud', normalize_loudness: 1 });
    const a = h.ctx.repo.getMessage(await send(plain.site_key))!;
    const b = h.ctx.repo.getMessage(await send(loud.site_key))!;
    expect(a.status).toBe('ready');
    expect(b.status).toBe('ready');
    const quiet = meanVolumeDb(path.join(h.config.localStoragePath, a.mp3_key!));
    const even = meanVolumeDb(path.join(h.config.localStoragePath, b.mp3_key!));
    expect(even).toBeGreaterThan(quiet + 10);
    expect(JSON.parse(a.waveform!).length).toBeGreaterThan(10);
    const page = await h.app.inject({ method: 'GET', url: `/shows/${plain.slug}/messages/${a.id}`, headers: { cookie } });
    expect(page.body).toContain('data-wave="');
  });

  it('draws waveforms for older messages at startup', async () => {
    const s = h.ctx.repo.createShow({ name: 'Old' });
    const id = await send(s.site_key);
    h.ctx.repo.updateMessage(id, { waveform: null });
    expect(backfillWaveforms(h.ctx)).toBe(1);
    await h.ctx.queue.idle();
    expect(JSON.parse(h.ctx.repo.getMessage(id)!.waveform!).length).toBeGreaterThan(10);
    // and nothing is left to do afterwards
    expect(backfillWaveforms(h.ctx)).toBe(0);
  });

  it('marks a message whose audio is missing so it is not retried forever', async () => {
    const s = h.ctx.repo.createShow({ name: 'Gone' });
    const id = await send(s.site_key);
    const m = h.ctx.repo.getMessage(id)!;
    fs.rmSync(path.join(h.config.localStoragePath, m.mp3_key!));
    h.ctx.repo.updateMessage(id, { waveform: null });
    backfillWaveforms(h.ctx);
    await h.ctx.queue.idle();
    expect(h.ctx.repo.getMessage(id)!.waveform).toBe('[]');
    expect(backfillWaveforms(h.ctx)).toBe(0);
  });
});
