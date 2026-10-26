import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { esc, html, raw } from '../src/lib/html.js';
import {
  cleanText,
  decryptSecret,
  encryptSecret,
  hashIp,
  isValidEmail,
  parseRange,
  slugify,
  ulid,
} from '../src/lib/util.js';
import { buildNewMessageEmail } from '../src/mail/index.js';
import { JobQueue } from '../src/queue.js';
import { LocalStorage } from '../src/storage/local.js';
import { isTestSecret } from '../src/turnstile.js';

const baseEnv = {
  APP_URL: 'https://listenerloop.app/',
  SESSION_SECRET: 's'.repeat(40),
  TURNSTILE_SITE_KEY: 'site',
  TURNSTILE_SECRET_KEY: 'secret',
};

describe('config', () => {
  it('loads defaults and normalizes APP_URL', () => {
    const c = loadConfig(baseEnv);
    expect(c.appUrl).toBe('https://listenerloop.app');
    expect(c.appHostname).toBe('listenerloop.app');
    expect(c.secureCookies).toBe(true);
    expect(c.maxSecondsDefault).toBe(180);
    expect(c.storageDriver).toBe('local');
    expect(c.mail.provider).toBe('smtp');
  });

  it('reports every problem at once', () => {
    try {
      loadConfig({ STORAGE_DRIVER: 's3', SESSION_SECRET: 'short' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const problems = (err as ConfigError).problems.join('\n');
      for (const name of ['APP_URL', 'SESSION_SECRET', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY']) {
        expect(problems).toContain(name);
      }
    }
  });

  it('rejects bad numbers and booleans', () => {
    expect(() => loadConfig({ ...baseEnv, MAX_UPLOAD_MB: 'lots' })).toThrow(/MAX_UPLOAD_MB/);
    expect(() => loadConfig({ ...baseEnv, KEEP_ORIGINALS: 'maybe' })).toThrow(/KEEP_ORIGINALS/);
  });
});

describe('util', () => {
  it('makes sortable 26 character ids', () => {
    const a = ulid(1_000_000);
    const b = ulid(2_000_000);
    expect(a).toHaveLength(26);
    expect(a < b).toBe(true);
  });

  it('parses ranges', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('bytes=9-2', 100)).toBe('invalid');
    expect(parseRange('items=0-1', 100)).toBe('invalid');
    expect(parseRange('bytes=-', 100)).toBe('invalid');
  });

  it('round-trips encrypted secrets and rejects tampering', () => {
    const enc = encryptSecret('turnstile-secret', 'k'.repeat(40));
    expect(enc.startsWith('v1:')).toBe(true);
    expect(enc).not.toContain('turnstile-secret');
    expect(decryptSecret(enc, 'k'.repeat(40))).toBe('turnstile-secret');
    expect(() => decryptSecret(enc, 'z'.repeat(40))).toThrow();
    const parts = enc.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decryptSecret(parts.join(':'), 'k'.repeat(40))).toThrow();
  });

  it('cleans text', () => {
    expect(cleanText('  Ann\n\tMarie\u0000  ', 100)).toBe('Ann Marie');
    expect(cleanText('x'.repeat(200), 10)).toHaveLength(10);
    expect(cleanText(42, 10)).toBe('');
  });

  it('validates emails', () => {
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('a b@c.com')).toBe(false);
    expect(isValidEmail('<x>@c.com')).toBe(false);
  });

  it('slugifies and hashes', () => {
    expect(slugify('Randy Unscripted!')).toBe('randy-unscripted');
    expect(slugify('!!!')).toBe('show');
    expect(hashIp('1.2.3.4', 'a'.repeat(32))).toHaveLength(32);
    expect(hashIp('1.2.3.4', 'a'.repeat(32))).not.toBe(hashIp('1.2.3.5', 'a'.repeat(32)));
  });

  it('recognizes Cloudflare test secrets only', () => {
    expect(isTestSecret('1x0000000000000000000000000000000AA')).toBe(true);
    expect(isTestSecret('2x0000000000000000000000000000000AA')).toBe(true);
    expect(isTestSecret('0x4AAAAAAAreal-secret')).toBe(false);
  });
});

describe('html', () => {
  it('escapes values and keeps raw markup', () => {
    expect(esc('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
    expect(html`<p>${'<script>'}</p>`.toString()).toBe('<p>&lt;script&gt;</p>');
    expect(html`<p>${raw('<b>ok</b>')}</p>`.toString()).toBe('<p><b>ok</b></p>');
    expect(html`<ul>${['a', '<b>'].map((x) => html`<li>${x}</li>`)}</ul>`.toString()).toBe('<ul><li>a</li><li>&lt;b&gt;</li></ul>');
    expect(html`${null}${false}${undefined}`.toString()).toBe('');
  });
});

describe('local storage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'll-storage-'));
  const storage = new LocalStorage(root);

  it('stores, reads ranges, reports size and deletes', async () => {
    await storage.put('shows/s1/2026/m1.mp3', Buffer.from('0123456789'), 'audio/mpeg');
    expect(await storage.exists('shows/s1/2026/m1.mp3')).toBe(true);
    expect(await storage.size('shows/s1/2026/m1.mp3')).toBe(10);
    const chunks: Buffer[] = [];
    for await (const c of await storage.getStream('shows/s1/2026/m1.mp3', { start: 2, end: 5 })) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('2345');
    await storage.delete('shows/s1/2026/m1.mp3');
    expect(await storage.exists('shows/s1/2026/m1.mp3')).toBe(false);
    expect(await storage.size('missing')).toBeNull();
  });

  it('copies a file from disk', async () => {
    const src = path.join(root, 'src.bin');
    fs.writeFileSync(src, 'hello');
    await storage.put('a/b.bin', src, 'application/octet-stream');
    expect(await storage.size('a/b.bin')).toBe(5);
  });

  it('refuses keys that escape the root', async () => {
    await expect(storage.put('../evil', Buffer.from('x'), 'x')).rejects.toThrow('Invalid storage key');
    await expect(storage.put('/abs', Buffer.from('x'), 'x')).rejects.toThrow('Invalid storage key');
    await expect(storage.size('a/../../evil')).rejects.toThrow('Invalid storage key');
  });
});

describe('queue', () => {
  it('runs jobs in order, one at a time, and reports idle', async () => {
    const order: number[] = [];
    let active = 0;
    let maxActive = 0;
    const q = new JobQueue(1);
    for (let i = 0; i < 4; i++) {
      q.add(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        order.push(i);
        active--;
      });
    }
    await q.idle();
    expect(order).toEqual([0, 1, 2, 3]);
    expect(maxActive).toBe(1);
  });

  it('keeps going after a failing job', async () => {
    const errors: unknown[] = [];
    const q = new JobQueue(1, (e) => errors.push(e));
    let ran = false;
    q.add(async () => {
      throw new Error('boom');
    });
    q.add(async () => {
      ran = true;
    });
    await q.idle();
    expect(errors).toHaveLength(1);
    expect(ran).toBe(true);
  });
});

describe('email', () => {
  it('names the sender and links to the admin, without attaching audio', () => {
    const m = buildNewMessageEmail({
      to: 'me@example.com',
      showName: 'Randy Unscripted',
      senderName: 'Pat',
      senderEmail: null,
      durationSeconds: 75,
      adminUrl: 'https://listenerloop.app/shows/randy/messages/abc',
    });
    expect(m.subject).toBe('New voicemail from Pat (Randy Unscripted)');
    expect(m.text).toContain('Length: 1:15');
    expect(m.text).toContain('Email: not shared');
    expect(m.text).toContain('https://listenerloop.app/shows/randy/messages/abc');
  });
});
