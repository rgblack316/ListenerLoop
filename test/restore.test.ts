import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { hash } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupFilePath, backupsIdle, startBackup } from '../src/backup.js';
import { migrate, openDb } from '../src/db/index.js';
import { Repo } from '../src/db/repo.js';
import { applyPendingRestore, inspectArchive, pendingDir, prunePreRestore, reconcileBackups, setRestartHook } from '../src/restore.js';
import { ADMIN_PASSWORD, formPost, login, makeHarness, multipart, type Harness } from './helpers.js';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
const tarOf = (dir: string, extra: string[] = []): string => {
  const out = path.join(tmp(), 'x.tar.gz');
  const r = spawnSync('tar', ['-czf', out, '-C', dir, ...extra, '.']);
  if (r.status !== 0) throw new Error(String(r.stderr));
  return out;
};

describe('restore', () => {
  let h: Harness;
  let owner: { cookie: string; csrf: string };
  let restarts = 0;

  const get = (url: string, s: { cookie: string }) => h.app.inject({ method: 'GET', url, headers: { cookie: s.cookie } });
  const backup = async (): Promise<string> => {
    const r = startBackup(h.ctx, 'manual', null) as { id: string };
    await backupsIdle();
    return r.id;
  };
  const restore = (id: string, extra: Record<string, string> = {}) =>
    formPost(h, `/settings/backups/${id}/restore`, owner, { password: ADMIN_PASSWORD, confirm: 'RESTORE', ...extra });

  beforeAll(async () => {
    setRestartHook(() => void restarts++);
    h = await makeHarness({}, undefined, { fileDb: true });
    owner = await login(h);
  });
  afterAll(async () => {
    await backupsIdle();
    await h.close();
  });

  it('restores the database and audio after a restart, setting the old data aside', async () => {
    const show = h.ctx.repo.createShow({ name: 'Before', notify_email: 'a@example.com' });
    await h.ctx.storage.put(`shows/${show.id}/2026/old.mp3`, Buffer.from('old audio'), 'audio/mpeg');
    const id = await backup();

    // life goes on after the backup
    h.ctx.repo.createShow({ name: 'After', notify_email: 'b@example.com' });
    await h.ctx.storage.put(`shows/${show.id}/2026/new.mp3`, Buffer.from('new audio'), 'audio/mpeg');

    const confirm = await get(`/settings/backups/${id}/restore`, owner);
    expect(confirm.statusCode).toBe(200);
    expect(confirm.body).toContain('Restore this backup?');
    expect(confirm.body).toContain('1 show,');

    const before = restarts;
    const res = await restore(id);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Restoring');
    await new Promise((r) => setTimeout(r, 900));
    expect(restarts).toBe(before + 1);
    expect(fs.existsSync(path.join(pendingDir(h.config.dataDir), 'PLAN.json'))).toBe(true);
    // nothing has been swapped yet: the live data is untouched until the restart
    expect(h.ctx.repo.listShows()).toHaveLength(2);

    // restart: close the database, apply, reopen
    h.ctx.repo.db.close();
    const result = applyPendingRestore({ dataDir: h.config.dataDir, databasePath: h.config.databasePath, audioPath: h.config.localStoragePath, localStorage: true });
    expect(result).toMatchObject({ ok: true });
    const db = openDb(h.config.databasePath);
    migrate(db);
    const repo = new Repo(db);
    expect(repo.listShows().map((s) => s.name)).toEqual(['Before']);
    expect(fs.existsSync(path.join(h.config.localStoragePath, `shows/${show.id}/2026/old.mp3`))).toBe(true);
    expect(fs.existsSync(path.join(h.config.localStoragePath, `shows/${show.id}/2026/new.mp3`))).toBe(false);

    // the replaced data is kept, not deleted
    const safe = result!.safeDir!;
    expect(fs.existsSync(path.join(safe, 'app.db'))).toBe(true);
    expect(fs.existsSync(path.join(safe, `audio/shows/${show.id}/2026/new.mp3`))).toBe(true);
    expect(fs.existsSync(pendingDir(h.config.dataDir))).toBe(false);
    expect(applyPendingRestore({ dataDir: h.config.dataDir, databasePath: h.config.databasePath, audioPath: h.config.localStoragePath, localStorage: true })).toBeNull();

    // old pre-restore folders are cleaned up after 30 days
    expect(prunePreRestore(h.config.dataDir)).toBe(0);
    fs.utimesSync(safe, new Date(Date.now() - 40 * 86_400_000), new Date(Date.now() - 40 * 86_400_000));
    expect(prunePreRestore(h.config.dataDir)).toBe(1);
    db.close();
    // give the harness a working database again for the remaining tests
    (h.ctx.repo as unknown as { db: unknown }).db = openDb(h.config.databasePath);
  });

  it('refuses without the password or the typed word, and for non-owners', async () => {
    migrate(h.ctx.repo.db);
    owner = await login(h);
    const id = await backup();
    expect((await restore(id, { password: 'wrong password!' })).statusCode).toBe(401);
    expect((await restore(id, { confirm: 'restore' })).statusCode).toBe(400);
    expect(fs.existsSync(pendingDir(h.config.dataDir))).toBe(false);
    const u = h.ctx.repo.createUser({ email: 'ed@example.com', passwordHash: await hash('a long enough password'), role: 'editor' });
    const ed = await login(h, u.email, 'a long enough password');
    expect((await get(`/settings/backups/${id}/restore`, ed)).statusCode).toBe(403);
    expect((await formPost(h, `/settings/backups/${id}/restore`, ed, { password: 'a long enough password', confirm: 'RESTORE' })).statusCode).toBe(403);
    expect((await formPost(h, '/settings/backups/scan', ed, {})).statusCode).toBe(403);
  });

  describe('archive checks', () => {
    const base = (): string => {
      const dir = tmp();
      fs.mkdirSync(path.join(dir, 'snapshot'));
      h.ctx.repo.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      fs.copyFileSync(h.config.databasePath, path.join(dir, 'snapshot', 'app.db'));
      fs.writeFileSync(path.join(dir, 'CREATED'), '2026-01-01T00:00:00Z\n');
      return dir;
    };

    it('accepts a good archive and reports what is in it', async () => {
      const info = await inspectArchive(h.ctx, tarOf(base()));
      expect(info).toMatchObject({ created: '2026-01-01T00:00:00Z', hasAudio: false, hasEnv: false });
      expect(info.users).toBeGreaterThan(0);
    });

    it('rejects links, unsafe paths, strangers and junk', async () => {
      const link = base();
      fs.symlinkSync('/etc', path.join(link, 'audio'));
      await expect(inspectArchive(h.ctx, tarOf(link))).rejects.toThrow(/links/);

      const extra = base();
      fs.writeFileSync(path.join(extra, 'evil.sh'), 'x');
      await expect(inspectArchive(h.ctx, tarOf(extra))).rejects.toThrow(/unexpected/);

      const dots = base();
      const out = path.join(tmp(), 'dots.tar.gz');
      spawnSync('tar', ['-czf', out, '-C', dots, '--transform', 's,^\\./snapshot,../snapshot,', '.']);
      await expect(inspectArchive(h.ctx, out)).rejects.toThrow(/unsafe|unexpected|not a readable/);

      const none = tmp();
      fs.writeFileSync(path.join(none, 'CREATED'), 'x');
      await expect(inspectArchive(h.ctx, tarOf(none))).rejects.toThrow(/no database/);

      const junk = path.join(tmp(), 'junk.tar.gz');
      fs.writeFileSync(junk, 'not an archive');
      await expect(inspectArchive(h.ctx, junk)).rejects.toThrow(/not a readable/);
    });

    it('rejects a damaged database and one from a newer app', async () => {
      const bad = base();
      fs.writeFileSync(path.join(bad, 'snapshot', 'app.db'), Buffer.from('SQLite format 3\0' + 'x'.repeat(500)));
      await expect(inspectArchive(h.ctx, tarOf(bad))).rejects.toThrow(/database/);

      const newer = base();
      const db = new Database(path.join(newer, 'snapshot', 'app.db'));
      db.pragma('journal_mode = DELETE');
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (9999, ?, ?)').run('future', 'x');
      db.close();
      await expect(inspectArchive(h.ctx, tarOf(newer))).rejects.toThrow(/newer version/);
    });

    it('upgrades an old backup (single admin) when it is applied', async () => {
      const dir = tmp();
      fs.mkdirSync(path.join(dir, 'snapshot'));
      const old = new Database(path.join(dir, 'snapshot', 'app.db'));
      const { MIGRATIONS } = await import('../src/db/index.js');
      old.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
      for (const m of MIGRATIONS.filter((x) => x.id < 10)) {
        old.exec(m.sql);
        old.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.id, m.name, 'x');
      }
      old.prepare("INSERT INTO admin (id, email, password_hash, created_at) VALUES (1, 'legacy@example.com', 'h', '2024-01-01')").run();
      old.close();
      const archive = tarOf(dir);
      expect((await inspectArchive(h.ctx, archive)).users).toBe(1);

      // stage it by hand and apply
      const data = tmp();
      fs.mkdirSync(path.join(data, 'restore-pending'));
      spawnSync('tar', ['-xzf', archive, '-C', path.join(data, 'restore-pending')]);
      fs.writeFileSync(path.join(data, 'restore-pending', 'PLAN.json'), '{}');
      const dbPath = path.join(data, 'app.db');
      fs.writeFileSync(dbPath, 'current');
      expect(applyPendingRestore({ dataDir: data, databasePath: dbPath, audioPath: path.join(data, 'audio'), localStorage: true })?.ok).toBe(true);
      const upgraded = openDb(dbPath);
      migrate(upgraded);
      expect(new Repo(upgraded).firstOwner()?.email).toBe('legacy@example.com');
      upgraded.close();
    });

    it('puts everything back if the swap fails part-way', () => {
      const data = tmp();
      fs.mkdirSync(path.join(data, 'restore-pending', 'snapshot'), { recursive: true });
      fs.writeFileSync(path.join(data, 'restore-pending', 'PLAN.json'), '{}');
      // no snapshot/app.db: moving it fails after the live database was set aside
      const dbPath = path.join(data, 'app.db');
      fs.writeFileSync(dbPath, 'precious');
      const r = applyPendingRestore({ dataDir: data, databasePath: dbPath, audioPath: path.join(data, 'audio'), localStorage: true });
      expect(r?.ok).toBe(false);
      expect(fs.readFileSync(dbPath, 'utf8')).toBe('precious');
      expect(fs.existsSync(path.join(data, 'restore-pending'))).toBe(false);
    });
  });

  describe('import and folder scan', () => {
    it('uploads a backup file into the list, and rejects bad uploads without keeping them', async () => {
      const id = await backup();
      const file = fs.readFileSync(backupFilePath(h.ctx, h.ctx.repo.getBackup(id)!)!);
      const send = (fields: Record<string, string>, data: Buffer, cookie = owner.cookie) => {
        const m = multipart(fields, { filename: 'b.tar.gz', type: 'application/gzip', data });
        return h.app.inject({ method: 'POST', url: '/settings/backups/import', payload: m.payload, headers: { ...m.headers, cookie, origin: 'https://listenerloop.test' } });
      };
      const before = h.ctx.repo.listBackups().length;
      const ok = await send({ _csrf: owner.csrf }, file);
      expect(ok.statusCode).toBe(302);
      expect(ok.headers.location).toContain('backup=imported');
      const added = h.ctx.repo.listBackups()[0]!;
      expect(h.ctx.repo.listBackups().length).toBe(before + 1);
      expect(added.started_by).toContain('(imported)');
      expect(added.file).toMatch(/^imported-/);

      const junk = await send({ _csrf: owner.csrf }, Buffer.from('nope'));
      expect(junk.statusCode).toBe(400);
      expect(junk.body).toContain('was not added');
      const noToken = await send({}, file);
      expect(noToken.statusCode).toBe(403);
      const badToken = await send({ _csrf: 'wrong' }, file);
      expect(badToken.statusCode).toBe(403);
      expect(h.ctx.repo.listBackups().length).toBe(before + 1);
      const left = fs.readdirSync(path.dirname(backupFilePath(h.ctx, added)!));
      expect(left.some((f) => f.endsWith('.part'))).toBe(false);
    });

    it('finds archives placed in the folder and forgets files that are gone', async () => {
      const dir = path.join(h.config.dataDir, 'backups');
      const src = backupFilePath(h.ctx, h.ctx.repo.listBackups().find((b) => b.has_local)!)!;
      fs.copyFileSync(src, path.join(dir, 'dropped-in.tar.gz'));
      fs.writeFileSync(path.join(dir, 'junk.tar.gz'), 'not a backup');
      const r = await reconcileBackups(h.ctx);
      expect(r.added).toBeGreaterThanOrEqual(1);
      expect(h.ctx.repo.listBackups().some((b) => b.file === 'dropped-in.tar.gz')).toBe(true);
      expect(h.ctx.repo.listBackups().some((b) => b.file === 'junk.tar.gz')).toBe(false);

      fs.rmSync(path.join(dir, 'dropped-in.tar.gz'));
      expect((await reconcileBackups(h.ctx)).removed).toBe(1);
      expect(h.ctx.repo.listBackups().some((b) => b.file === 'dropped-in.tar.gz')).toBe(false);
    });
  });
});
