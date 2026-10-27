import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import type { AppContext } from './context.js';
import { MIGRATIONS } from './db/index.js';
import type { Backup } from './db/repo.js';
import { backupDir, backupFilePath } from './backup.js';
import { ulid } from './lib/util.js';

export const MAX_IMPORT_MB = 1024;

export interface Inspection {
  created: string | null;
  shows: number;
  messages: number;
  users: number;
  hasAudio: boolean;
  hasEnv: boolean;
  uncompressedBytes: number;
}

const run = (cmd: string, args: string[], opts: { input?: boolean } = {}): Promise<{ code: number; out: string; err: string }> =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    p.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? 1, out, err }));
    void opts;
  });

const clean = (name: string): string => name.replace(/^(\.\/)+/, '').replace(/\/+$/, '');

/**
 * Reads the member list of an archive and refuses anything that is not a plain file or folder inside the
 * expected places (snapshot, audio, CREATED, env). This keeps links, devices and ../ paths out before anything is unpacked.
 */
async function checkMembers(file: string): Promise<{ names: string[]; bytes: number }> {
  const [long, short] = await Promise.all([run('tar', ['-tvzf', file]), run('tar', ['-tzf', file])]);
  if (long.code !== 0 || short.code !== 0) throw new Error('This file is not a readable .tar.gz archive.');
  const types = long.out.split('\n').filter(Boolean);
  const names = short.out.split('\n').filter(Boolean);
  if (types.length !== names.length) throw new Error('The archive listing could not be read.');
  let bytes = 0;
  for (let i = 0; i < names.length; i++) {
    const kind = types[i]![0];
    const name = clean(names[i]!);
    if (kind !== '-' && kind !== 'd') throw new Error('The archive contains links or special files, which are not allowed.');
    if (name.startsWith('/') || name.split('/').includes('..')) throw new Error('The archive contains unsafe file paths.');
    const top = name.split('/')[0]!;
    if (name !== '' && name !== '.' && !['snapshot', 'audio', 'CREATED', 'env'].includes(top)) throw new Error(`The archive contains an unexpected item (${top}). It does not look like a ListenerLoop backup.`);
    if (kind === '-') bytes += Number(/^\S+\s+\S+\s+(\d+)\s/.exec(types[i]!)?.[1] ?? 0);
  }
  if (!names.some((n) => clean(n) === 'snapshot/app.db')) throw new Error('This does not look like a ListenerLoop backup (no database inside).');
  return { names: names.map(clean), bytes };
}

/** Unpacks everything, or only members matching the patterns. A pattern that matches nothing is fine when `optional`. */
async function extract(file: string, dest: string, only?: string[], optional = false): Promise<void> {
  fs.mkdirSync(dest, { recursive: true });
  const args = ['-xzf', file, '-C', dest, '--no-same-owner', '--no-same-permissions'];
  if (only) args.push('--wildcards', ...only);
  const r = await run('tar', args);
  if (r.code !== 0 && !optional) throw new Error(`Could not unpack the archive: ${r.err.trim().slice(0, 200)}`);
}

/** Opens the unpacked database read-only and makes sure it is intact and not from a newer version of the app. */
function checkSnapshot(dbFile: string): { shows: number; messages: number; users: number } {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbFile, { readonly: true, fileMustExist: true });
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error('The database inside the backup is damaged.');
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));
    for (const t of ['shows', 'messages', 'schema_migrations']) if (!tables.has(t)) throw new Error('The database inside the backup is missing data this app needs.');
    const newest = (db.prepare('SELECT MAX(id) AS m FROM schema_migrations').get() as { m: number | null }).m ?? 0;
    const ours = Math.max(...MIGRATIONS.map((m) => m.id));
    if (newest > ours) throw new Error('This backup was made by a newer version of ListenerLoop. Update the app first, then restore it.');
    const count = (t: string): number => (tables.has(t) ? (db!.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n : 0);
    return { shows: count('shows'), messages: count('messages'), users: tables.has('users') ? count('users') : count('admin') };
  } catch (err) {
    if (err instanceof Error && /newer version|damaged|missing data/.test(err.message)) throw err;
    throw new Error('The database inside the backup could not be read.');
  } finally {
    db?.close();
  }
}

/** Checks an archive without changing anything and reports what is inside. */
export async function inspectArchive(ctx: AppContext, file: string): Promise<Inspection> {
  const { names, bytes } = await checkMembers(file);
  const work = path.join(ctx.config.tmpDir, `inspect-${ulid()}`);
  try {
    await extract(file, work, ['*snapshot/app.db']);
    await extract(file, work, ['*CREATED'], true);
    const counts = checkSnapshot(path.join(work, 'snapshot', 'app.db'));
    const created = fs.existsSync(path.join(work, 'CREATED')) ? fs.readFileSync(path.join(work, 'CREATED'), 'utf8').trim() || null : null;
    return { created, ...counts, hasAudio: names.some((n) => n === 'audio' || n.startsWith('audio/')), hasEnv: names.includes('env'), uncompressedBytes: bytes };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export const pendingDir = (dataDir: string): string => path.join(dataDir, 'restore-pending');

/** Unpacks a checked archive next to the live data, ready to be swapped in when the app restarts. */
export async function stageRestore(ctx: AppContext, file: string, by: string): Promise<Inspection> {
  const info = await inspectArchive(ctx, file);
  const { dataDir } = ctx.config;
  fs.mkdirSync(dataDir, { recursive: true });
  const free = fs.statfsSync(dataDir);
  if (free.bavail * free.bsize < info.uncompressedBytes + 200 * 1024 * 1024) throw new Error('There is not enough free disk space to unpack this backup.');
  const dir = pendingDir(dataDir);
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    await extract(file, dir, ['*snapshot', '*audio', '*CREATED'], true);
    if (!fs.existsSync(path.join(dir, 'snapshot', 'app.db'))) throw new Error('The database was not found after unpacking.');
    fs.writeFileSync(path.join(dir, 'PLAN.json'), JSON.stringify({ at: new Date().toISOString(), by, created: info.created, hasAudio: info.hasAudio }));
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return info;
}

// ---------------------------------------------------------------- restart and swap
let restartHook: () => void = () => {
  process.kill(process.pid, 'SIGTERM');
};
/** Tests replace this so the test process is not stopped. */
export const setRestartHook = (fn: () => void): void => {
  restartHook = fn;
};
/** Asks the app to stop; Docker (restart: unless-stopped) starts it again, and the staged restore is applied on the way up. */
export const requestRestart = (): void => restartHook();

export interface RestoreResult {
  at: string;
  ok: boolean;
  error?: string;
  safeDir?: string;
  created?: string | null;
  by?: string;
}

function move(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    fs.cpSync(src, dst, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

/**
 * Runs at start-up, before the database is opened. If a restore was staged, the current database (and local audio) are
 * set aside in a "pre-restore" folder and the staged copies take their place. Nothing is deleted, so it can be undone by hand.
 */
export function applyPendingRestore(opts: { dataDir: string; databasePath: string; audioPath: string; localStorage: boolean }): RestoreResult | null {
  const dir = pendingDir(opts.dataDir);
  const planFile = path.join(dir, 'PLAN.json');
  if (!fs.existsSync(planFile)) {
    fs.rmSync(dir, { recursive: true, force: true }); // a half-staged restore never started
    return null;
  }
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8')) as { created?: string | null; by?: string };
  const at = new Date().toISOString();
  const safeDir = path.join(opts.dataDir, `pre-restore-${at.replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')}`);
  const moved: Array<[string, string]> = [];
  try {
    fs.mkdirSync(safeDir, { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) {
      const cur = `${opts.databasePath}${suffix}`;
      if (fs.existsSync(cur)) {
        const to = path.join(safeDir, `${path.basename(opts.databasePath)}${suffix}`);
        move(cur, to);
        moved.push([to, cur]);
      }
    }
    move(path.join(dir, 'snapshot', 'app.db'), opts.databasePath);
    const stagedAudio = path.join(dir, 'audio');
    if (opts.localStorage && fs.existsSync(stagedAudio)) {
      if (fs.existsSync(opts.audioPath)) {
        const to = path.join(safeDir, 'audio');
        move(opts.audioPath, to);
        moved.push([to, opts.audioPath]);
      }
      move(stagedAudio, opts.audioPath);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(path.join(safeDir, 'README.txt'), `Set aside when a backup made ${plan.created ?? 'at an unknown time'} was restored on ${at}.\nTo undo, stop the app and move these files back.\nDelete this folder when you no longer need it.\n`);
    return { at, ok: true, safeDir, created: plan.created ?? null, by: plan.by };
  } catch (err) {
    // Put back whatever was moved so the app still starts with its old data.
    for (const [from, to] of moved.reverse()) {
      try {
        fs.rmSync(to, { recursive: true, force: true });
        move(from, to);
      } catch {
        /* best effort */
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return { at, ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 300), created: plan.created ?? null, by: plan.by };
  }
}

/** Removes "pre-restore" folders older than 30 days. */
export function prunePreRestore(dataDir: string, days = 30): number {
  let n = 0;
  for (const name of fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : []) {
    if (!name.startsWith('pre-restore-')) continue;
    const full = path.join(dataDir, name);
    if (Date.now() - fs.statSync(full).mtimeMs > days * 86_400_000) {
      fs.rmSync(full, { recursive: true, force: true });
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- the list of archives
/** Makes the backups list match the files on disk: forgets files that are gone, lists archives that were placed in the folder. */
export async function reconcileBackups(ctx: AppContext, opts: { addNew?: boolean } = {}): Promise<{ added: number; removed: number }> {
  const { repo } = ctx;
  const dir = backupDir(ctx);
  let removed = 0;
  let added = 0;
  for (const b of repo.listBackups(500)) {
    if (b.status !== 'ok' || !b.has_local) continue;
    const f = backupFilePath(ctx, b);
    if (f && !fs.existsSync(f)) {
      if (b.storage_key) repo.updateBackup(b.id, { has_local: 0 });
      else repo.deleteBackup(b.id);
      removed++;
    }
  }
  if (opts.addNew !== false && fs.existsSync(dir)) {
    const known = new Set(repo.listBackups(500).map((b) => b.file));
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.tar.gz') || known.has(name)) continue;
      const full = path.join(dir, name);
      try {
        const info = await inspectArchive(ctx, full);
        const id = ulid();
        repo.insertBackup({ id, kind: 'manual', started_by: 'found in folder' });
        repo.updateBackup(id, { status: 'ok', file: name, size_bytes: fs.statSync(full).size, includes_audio: info.hasAudio ? 1 : 0, finished_at: new Date().toISOString() });
        added++;
      } catch (err) {
        ctx.log.warn({ err, file: name }, 'ignoring a file in the backups folder that is not a usable backup');
      }
    }
  }
  return { added, removed };
}

/** A readable local copy of a backup: the file on the server, or a temporary download from the bucket. */
export async function localCopy(ctx: AppContext, b: Backup): Promise<{ path: string; cleanup: () => void }> {
  const f = backupFilePath(ctx, b);
  if (f && fs.existsSync(f)) return { path: f, cleanup: () => undefined };
  if (!b.storage_key || !(await ctx.storage.exists(b.storage_key))) throw new Error('The backup file could not be found.');
  fs.mkdirSync(ctx.config.tmpDir, { recursive: true });
  const tmp = path.join(ctx.config.tmpDir, `restore-${ulid()}.tar.gz`);
  await pipeline(await ctx.storage.getStream(b.storage_key), fs.createWriteStream(tmp));
  return { path: tmp, cleanup: () => fs.rmSync(tmp, { force: true }) };
}
