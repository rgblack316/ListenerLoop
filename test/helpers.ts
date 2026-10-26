import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hash } from '@node-rs/argon2';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { openDb } from '../src/db/index.js';
import type { Mailer, MailMessage } from '../src/mail/index.js';
import { LocalStorage } from '../src/storage/local.js';
import type { TurnstileVerifier } from '../src/turnstile.js';

export const APP_URL = 'https://listenerloop.test';
export const ADMIN_EMAIL = 'admin@example.com';
export const ADMIN_PASSWORD = 'correct horse battery staple';

export interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  config: Config;
  dir: string;
  sent: MailMessage[];
  close(): Promise<void>;
}

export async function makeHarness(
  env: Record<string, string> = {},
  verify?: TurnstileVerifier,
): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listenerloop-test-'));
  const config = loadConfig({
    APP_URL,
    SESSION_SECRET: 't'.repeat(48),
    DATA_DIR: dir,
    TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
    TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
    MAIL_PROVIDER: 'none',
    RATE_LIMIT_PER_HOUR: '100',
    ...env,
  });
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    provider: 'smtp',
    async send(m) {
      sent.push(m);
    },
  };
  const defaultVerify: TurnstileVerifier = async ({ token }) =>
    token === 'bad-token'
      ? { success: false, errorCodes: ['invalid-input-response'] }
      : { success: true, hostname: new URL(APP_URL).hostname, errorCodes: [] };
  const { app, ctx } = await buildApp({
    config,
    db: openDb(':memory:'),
    storage: new LocalStorage(config.localStoragePath),
    mailer,
    verifyTurnstile: verify ?? defaultVerify,
    logger: false,
  });
  ctx.repo.upsertAdmin(ADMIN_EMAIL, await hash(ADMIN_PASSWORD));
  return {
    app,
    ctx,
    config,
    dir,
    sent,
    async close() {
      await ctx.queue.idle();
      await app.close();
      ctx.repo.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function multipart(
  fields: Record<string, string>,
  file?: { filename?: string; type?: string; data: Buffer },
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----listenerloop${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${file.filename ?? 'recording.webm'}"\r\nContent-Type: ${file.type ?? 'audio/webm'}\r\n\r\n`,
      ),
      file.data,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

export function hasFfmpeg(): boolean {
  return spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
}

/**
 * Makes test audio. Like a browser's MediaRecorder, the WebM is written to a pipe,
 * so the file has no duration in its header.
 */
export function makeAudio(kind: 'webm-stream' | 'm4a' | 'long-webm', seconds = 2): Buffer {
  const src = ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`];
  let args: string[];
  if (kind === 'm4a') {
    const out = path.join(os.tmpdir(), `ll-fixture-${process.pid}-${Math.random().toString(16).slice(2)}.m4a`);
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...src, '-c:a', 'aac', out]);
    if (r.status !== 0) throw new Error(`fixture failed: ${r.stderr}`);
    const data = fs.readFileSync(out);
    fs.rmSync(out, { force: true });
    return data;
  }
  args = ['-v', 'error', ...src, '-c:a', 'libopus', '-f', 'webm', 'pipe:1'];
  const r = spawnSync('ffmpeg', args, { maxBuffer: 20 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`fixture failed: ${r.stderr}`);
  return r.stdout;
}

export function probeDuration(file: string): { duration: number; channels: number; codec: string } {
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  const json = JSON.parse(r.stdout.toString()) as {
    format: { duration: string };
    streams: { codec_name: string; channels: number }[];
  };
  return { duration: Number(json.format.duration), channels: json.streams[0]!.channels, codec: json.streams[0]!.codec_name };
}

export function cookieFrom(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return (first ?? '').split(';')[0] ?? '';
}

export function csrfFromHtml(body: string): string {
  const m = /x-csrf-token&quot;:&quot;([^&]+)&quot;/.exec(body);
  if (!m) throw new Error('No CSRF token found in page');
  return m[1]!;
}

export async function login(h: Harness): Promise<{ cookie: string; csrf: string }> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/admin/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: APP_URL },
    payload: new URLSearchParams({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }).toString(),
  });
  if (res.statusCode !== 302) throw new Error(`login failed with ${res.statusCode}`);
  const cookie = cookieFrom(res);
  const inbox = await h.app.inject({ method: 'GET', url: '/admin/inbox', headers: { cookie } });
  return { cookie, csrf: csrfFromHtml(inbox.body) };
}

export function formPost(
  h: Harness,
  url: string,
  session: { cookie: string; csrf?: string },
  fields: Record<string, string>,
  extra: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return h.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: APP_URL, cookie: session.cookie, ...extra },
    payload: new URLSearchParams({ ...(session.csrf ? { _csrf: session.csrf } : {}), ...fields }).toString(),
  });
}
