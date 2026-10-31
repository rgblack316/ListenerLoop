import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { hash } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupFilePath, backupsIdle, latestSlot, loadBackupSettings, nextSlot, normalizeSettings, saveBackupSettings, scheduledBackupDue, startBackup } from '../src/backup.js';
import { formPost, login, makeHarness, type Harness } from './helpers.js';

describe('backup schedule maths', () => {
  const at = (iso: string) => new Date(iso);
  it('finds the latest and next daily slot', () => {
    const s = normalizeSettings({ schedule: 'daily', hour: 3 });
    expect(latestSlot(s, at('2026-10-27T10:00:00Z'))?.toISOString()).toBe('2026-10-27T03:00:00.000Z');
    expect(latestSlot(s, at('2026-10-27T02:00:00Z'))?.toISOString()).toBe('2026-10-26T03:00:00.000Z');
    expect(nextSlot(s, at('2026-10-27T10:00:00Z'))?.toISOString()).toBe('2026-10-28T03:00:00.000Z');
  });
  it('finds weekly slots on the chosen weekday', () => {
    const s = normalizeSettings({ schedule: 'weekly', weekday: 0, hour: 4 }); // Sundays
    expect(latestSlot(s, at('2026-10-27T10:00:00Z'))?.toISOString()).toBe('2026-10-25T04:00:00.000Z');
    expect(nextSlot(s, at('2026-10-27T10:00:00Z'))?.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(latestSlot(s, at('2026-10-25T03:00:00Z'))?.toISOString()).toBe('2026-10-18T04:00:00.000Z');
  });
  it('is off by default and clamps bad values', () => {
    expect(latestSlot(normalizeSettings({}), new Date())).toBeNull();
    expect(normalizeSettings({ schedule: 'daily', hour: 99, keep: 0, weekday: 9 })).toMatchObject({ hour: 3, keep: 14, weekday: 0 });
  });
});

describe('backups', () => {
  let h: Harness;
  let owner: { cookie: string; csrf: string };

  const get = (url: string, s: { cookie: string }) => h.app.inject({ method: 'GET', url, headers: { cookie: s.cookie } });
  const list = (file: string): string[] => spawnSync('tar', ['-tzf', file], { encoding: 'utf8' }).stdout.split('\n').map((l) => l.replace(/^\.\//, '')).filter(Boolean);

  beforeAll(async () => {
    h = await makeHarness();
    owner = await login(h);
    const show = h.ctx.repo.createShow({ name: 'Backup Show', notify_email: 'b@example.com' });
    await h.ctx.storage.put(`shows/${show.id}/2026/m1.mp3`, Buffer.from('fake audio bytes'), 'audio/mpeg');
  });
  afterAll(async () => {
    await backupsIdle();
    await h.close();
  });

  it('backs up the database and local audio into one archive', async () => {
    const r = startBackup(h.ctx, 'manual', 'me@example.com');
    expect('id' in r).toBe(true);
    expect(startBackup(h.ctx, 'manual', null)).toEqual({ error: 'A backup is already running.' });
    await backupsIdle();
    const b = h.ctx.repo.getBackup((r as { id: string }).id)!;
    expect(b).toMatchObject({ status: 'ok', kind: 'manual', includes_audio: 1, started_by: 'me@example.com' });
    const file = backupFilePath(h.ctx, b)!;
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const names = list(file);
    expect(names).toContain('snapshot/app.db');
    expect(names).toContain('CREATED');
    expect(names.some((n) => n.startsWith('audio/shows/') && n.endsWith('m1.mp3'))).toBe(true);

    // the snapshot is a working copy of the database
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
    spawnSync('tar', ['-xzf', file, '-C', out]);
    const copy = new Database(path.join(out, 'snapshot', 'app.db'), { readonly: true });
    expect((copy.prepare('SELECT COUNT(*) AS n FROM shows').get() as { n: number }).n).toBe(1);
    expect((copy.prepare("SELECT role FROM users WHERE role = 'site_admin'").get() as { role: string }).role).toBe('site_admin');
    copy.close();
    fs.rmSync(out, { recursive: true, force: true });
    expect(fs.readdirSync(path.dirname(file)).some((f) => f.endsWith('.part'))).toBe(false);
  });

  it('leaves audio out when asked, and keeps archives on the server, in the bucket, or both', async () => {
    saveBackupSettings(h.ctx.repo, { ...loadBackupSettings(h.ctx.repo), includeAudio: false });
    const r = startBackup(h.ctx, 'manual', null) as { id: string };
    await backupsIdle();
    const b = h.ctx.repo.getBackup(r.id)!;
    expect(b.includes_audio).toBe(0);
    expect(b.storage_key).toBeNull();
    expect(list(backupFilePath(h.ctx, b)!).some((n) => n.startsWith('audio'))).toBe(false);

    // With local storage there is no bucket, so every choice keeps the file on the server.
    saveBackupSettings(h.ctx.repo, { ...loadBackupSettings(h.ctx.repo), destination: 'bucket' });
    const r1 = startBackup(h.ctx, 'manual', null) as { id: string };
    await backupsIdle();
    expect(h.ctx.repo.getBackup(r1.id)).toMatchObject({ has_local: 1, storage_key: null });

    const real = h.ctx.storage;
    const stored = new Map<string, Buffer>();
    Object.defineProperty(real, 'name', { value: 's3', configurable: true });
    const origPut = real.put.bind(real);
    const origExists = real.exists.bind(real);
    const origDelete = real.delete.bind(real);
    const origStream = real.getStream.bind(real);
    real.put = async (key, file) => { if (key.startsWith('backups/')) stored.set(key, fs.readFileSync(file as string)); else await origPut(key, file, 'x'); };
    real.exists = async (key) => stored.has(key) || origExists(key);
    real.delete = async (key) => { if (!stored.delete(key)) await origDelete(key); };
    real.getStream = (async (key: string) => (stored.has(key) ? (await import('node:stream')).Readable.from(stored.get(key)!) : origStream(key))) as typeof real.getStream;
    const run = async (destination: 'server' | 'bucket' | 'both') => {
      saveBackupSettings(h.ctx.repo, { ...loadBackupSettings(h.ctx.repo), destination });
      const r = startBackup(h.ctx, 'manual', null) as { id: string };
      await backupsIdle();
      return h.ctx.repo.getBackup(r.id)!;
    };
    try {
      const both = await run('both');
      expect(both).toMatchObject({ has_local: 1, status: 'ok', includes_audio: 0 }); // audio is in the bucket, not the archive
      expect(both.storage_key).toMatch(/^backups\/listenerloop-.*\.tar\.gz$/);
      expect(stored.has(both.storage_key!)).toBe(true);
      expect(fs.existsSync(backupFilePath(h.ctx, both)!)).toBe(true);

      const server = await run('server');
      expect(server).toMatchObject({ has_local: 1, storage_key: null });

      const bucket = await run('bucket');
      expect(bucket).toMatchObject({ has_local: 0, status: 'ok' });
      expect(backupFilePath(h.ctx, bucket)).toBeNull();
      expect(fs.existsSync(path.join(h.config.dataDir, 'backups', bucket.file!))).toBe(false);
      expect(stored.has(bucket.storage_key!)).toBe(true);
      // a bucket-only backup downloads straight from the bucket
      const dl = await get(`/settings/backups/${bucket.id}/download`, owner);
      expect(dl.statusCode).toBe(200);
      expect(Buffer.compare(dl.rawPayload, stored.get(bucket.storage_key!)!)).toBe(0);
      expect(spawnSync('tar', ['-tzf', '-'], { input: dl.rawPayload, encoding: 'utf8' }).stdout).toContain('snapshot/app.db');
      // deleting removes the bucket copy
      const { removeBackup } = await import('../src/backup.js');
      await removeBackup(h.ctx, bucket);
      expect(stored.has(bucket.storage_key!)).toBe(false);
      await removeBackup(h.ctx, both);
      expect(stored.has(both.storage_key!)).toBe(false);
      expect(fs.existsSync(path.join(h.config.dataDir, 'backups', both.file!))).toBe(false);
    } finally {
      Object.defineProperty(real, 'name', { value: 'local', configurable: true });
      real.put = origPut;
      real.exists = origExists;
      real.delete = origDelete;
      real.getStream = origStream;
    }
  });

  it('keeps only the newest N and removes the files', async () => {
    saveBackupSettings(h.ctx.repo, { ...loadBackupSettings(h.ctx.repo), keep: 2 });
    for (let i = 0; i < 3; i++) {
      startBackup(h.ctx, 'manual', null);
      await backupsIdle();
    }
    const ok = h.ctx.repo.listBackups().filter((b) => b.status === 'ok');
    expect(ok).toHaveLength(2);
    const dir = path.dirname(backupFilePath(h.ctx, ok[0]!)!);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tar.gz'))).toHaveLength(2);
  });

  it('records a failure and removes partial files', async () => {
    const realBackup = h.ctx.repo.db.backup.bind(h.ctx.repo.db);
    h.ctx.repo.db.backup = (() => Promise.reject(new Error('disk full'))) as typeof h.ctx.repo.db.backup;
    try {
      const r = startBackup(h.ctx, 'scheduled', null) as { id: string };
      await backupsIdle();
      expect(h.ctx.repo.getBackup(r.id)).toMatchObject({ status: 'failed', error: 'disk full' });
      expect(h.sent.at(-1)?.subject).toContain('scheduled backup failed');
    } finally {
      h.ctx.repo.db.backup = realBackup;
    }
  });

  it('starts scheduled backups only once per slot and never right after saving', () => {
    const repo = h.ctx.repo;
    repo.db.prepare('DELETE FROM backups').run();
    const t0 = new Date('2026-10-27T10:00:00Z');
    saveBackupSettings(repo, normalizeSettings({ schedule: 'daily', hour: 3 }), t0);
    expect(scheduledBackupDue(repo, new Date('2026-10-27T10:05:00Z'))).toBe(false); // 03:00 already passed before saving
    expect(scheduledBackupDue(repo, new Date('2026-10-28T03:01:00Z'))).toBe(true);
    repo.insertBackup({ id: 'sched1', kind: 'scheduled', started_by: null });
    repo.db.prepare("UPDATE backups SET created_at = '2026-10-28T03:01:00.000Z' WHERE id = 'sched1'").run();
    expect(scheduledBackupDue(repo, new Date('2026-10-28T05:00:00Z'))).toBe(false);
    expect(scheduledBackupDue(repo, new Date('2026-10-29T03:00:30Z'))).toBe(true);
    saveBackupSettings(repo, normalizeSettings({ schedule: 'off' }));
    expect(scheduledBackupDue(repo, new Date('2026-10-30T03:00:30Z'))).toBe(false);
  });

  it('marks backups left running by a restart as failed', () => {
    h.ctx.repo.db.prepare('DELETE FROM backups').run();
    h.ctx.repo.insertBackup({ id: 'stuck', kind: 'manual', started_by: null });
    expect(h.ctx.repo.failInterruptedBackups()).toBe(1);
    expect(h.ctx.repo.getBackup('stuck')?.status).toBe('failed');
  });

  describe('settings page', () => {
    it('shows the Backups panel above Configuration', async () => {
      const body = (await get('/settings', owner)).body;
      const b = body.indexOf('<h2>Backups</h2>');
      expect(b).toBeGreaterThan(0);
      expect(b).toBeLessThan(body.indexOf('<h2>Configuration</h2>'));
    });

    it('runs, saves, downloads and deletes backups for owners', async () => {
      h.ctx.repo.db.prepare('DELETE FROM backups').run();
      const run = await formPost(h, '/settings/backups/run', owner, {});
      expect(run.statusCode).toBe(302);
      expect(run.headers.location).toContain('backup=started');
      await backupsIdle();
      const b = h.ctx.repo.listBackups()[0]!;
      expect(b.status).toBe('ok');
      const dl = await get(`/settings/backups/${b.id}/download`, owner);
      expect(dl.statusCode).toBe(200);
      expect(dl.headers['content-disposition']).toContain(b.file!);
      expect(dl.rawPayload.length).toBe(b.size_bytes);

      const save = await formPost(h, '/settings/backups', owner, { schedule: 'weekly', weekday: '2', hour: '5', keep: '7', include_audio: '1' });
      expect(save.headers.location).toContain('backup=saved');
      expect(loadBackupSettings(h.ctx.repo)).toMatchObject({ schedule: 'weekly', weekday: 2, hour: 5, keep: 7, includeAudio: true });
      const page = await get('/settings?backup=saved', owner);
      expect(page.body).toContain('Backup schedule saved');
      expect(page.body).toContain('Next backup');

      const del = await formPost(h, `/settings/backups/${b.id}/delete`, owner, {});
      expect(del.headers.location).toContain('backup=deleted');
      expect(h.ctx.repo.getBackup(b.id)).toBeUndefined();
      expect(fs.existsSync(path.join(h.config.dataDir, 'backups', b.file!))).toBe(false);
      expect((await get(`/settings/backups/${b.id}/download`, owner)).statusCode).toBe(404);
    });

    it('is closed to everyone but owners', async () => {
      const u = h.ctx.repo.createUser({ email: 'ed@example.com', passwordHash: await hash('a long enough password'), role: 'editor' });
      const ed = await login(h, u.email, 'a long enough password');
      startBackup(h.ctx, 'manual', null);
      await backupsIdle();
      const id = h.ctx.repo.listBackups()[0]!.id;
      expect((await get(`/settings/backups/${id}/download`, ed)).statusCode).toBe(403);
      for (const url of ['/settings/backups/run', '/settings/backups', `/settings/backups/${id}/delete`]) {
        expect((await formPost(h, url, ed, {})).statusCode, url).toBe(403);
      }
      expect((await h.app.inject({ method: 'GET', url: `/settings/backups/${id}/download` })).statusCode).toBe(302);
    });
  });
});
