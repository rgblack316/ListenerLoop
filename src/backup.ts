import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from './context.js';
import type { Backup, Repo } from './db/repo.js';
import { ulid } from './lib/util.js';

export interface BackupSettings {
  schedule: 'off' | 'daily' | 'weekly';
  /** 0 = Sunday. Only used for weekly. */
  weekday: number;
  /** Hour of the day in UTC. */
  hour: number;
  keep: number;
  includeAudio: boolean;
  copyToStorage: boolean;
}

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = { schedule: 'off', weekday: 0, hour: 3, keep: 14, includeAudio: true, copyToStorage: true };

export function loadBackupSettings(repo: Repo): BackupSettings {
  try {
    const raw = repo.getSetting('backup');
    return raw ? normalizeSettings(JSON.parse(raw) as Partial<BackupSettings>) : { ...DEFAULT_BACKUP_SETTINGS };
  } catch {
    return { ...DEFAULT_BACKUP_SETTINGS };
  }
}

const int = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

export function normalizeSettings(s: Partial<BackupSettings>): BackupSettings {
  const d = DEFAULT_BACKUP_SETTINGS;
  return {
    schedule: s.schedule === 'daily' || s.schedule === 'weekly' ? s.schedule : 'off',
    weekday: int(s.weekday, 0, 6, d.weekday),
    hour: int(s.hour, 0, 23, d.hour),
    keep: int(s.keep, 1, 100, d.keep),
    includeAudio: s.includeAudio !== false,
    copyToStorage: s.copyToStorage !== false,
  };
}

export function saveBackupSettings(repo: Repo, s: BackupSettings, now = new Date()): void {
  repo.setSetting('backup', JSON.stringify(s));
  // Scheduled runs only count from now on, so turning the schedule on never fires a backup straight away.
  repo.setSetting('backup_armed_at', now.toISOString());
}

/** The most recent scheduled time at or before `now`, or null when the schedule is off. */
export function latestSlot(s: BackupSettings, now: Date): Date | null {
  if (s.schedule === 'off') return null;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), s.hour));
  if (s.schedule === 'daily') {
    if (d > now) d.setUTCDate(d.getUTCDate() - 1);
    return d;
  }
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - s.weekday + 7) % 7));
  if (d > now) d.setUTCDate(d.getUTCDate() - 7);
  return d;
}

/** The next scheduled time after `now`. */
export function nextSlot(s: BackupSettings, now: Date): Date | null {
  const last = latestSlot(s, now);
  if (!last) return null;
  const next = new Date(last);
  next.setUTCDate(next.getUTCDate() + (s.schedule === 'daily' ? 1 : 7));
  return next;
}

/** Whether a scheduled backup should start now: a slot has passed since the schedule was saved and since the last scheduled run. */
export function scheduledBackupDue(repo: Repo, now = new Date()): boolean {
  const s = loadBackupSettings(repo);
  const slot = latestSlot(s, now);
  if (!slot) return false;
  const armed = Date.parse(repo.getSetting('backup_armed_at') ?? '') || 0;
  if (slot.getTime() <= armed) return false;
  const last = repo.lastScheduledBackup();
  return !last || Date.parse(last.created_at) < slot.getTime();
}

export const backupDir = (ctx: AppContext): string => path.join(ctx.config.dataDir, 'backups');
export const backupFilePath = (ctx: AppContext, b: Backup): string | null => (b.file ? path.join(backupDir(ctx), path.basename(b.file)) : null);

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

function tarGz(out: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // -h follows the audio symlink, so audio is read in place rather than copied first.
    const p = spawn('tar', ['-czhf', out, '-C', cwd, '.'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c: Buffer) => (err += c.toString()));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar failed (${code}): ${err.trim().slice(0, 200)}`))));
  });
}

const inflight = new Set<Promise<void>>();
/** Tests: resolves when no backup is running. */
export async function backupsIdle(): Promise<void> {
  while (inflight.size) await Promise.allSettled([...inflight]);
}
export const backupRunning = (): boolean => inflight.size > 0;

/** Starts a backup in the background. Returns its id, or an error if one is already running. */
export function startBackup(ctx: AppContext, kind: Backup['kind'], startedBy: string | null): { id: string } | { error: string } {
  if (inflight.size > 0) return { error: 'A backup is already running.' };
  const id = ulid();
  ctx.repo.insertBackup({ id, kind, started_by: startedBy });
  const p: Promise<void> = runBackup(ctx, id, kind).finally(() => inflight.delete(p));
  inflight.add(p);
  return { id };
}

async function runBackup(ctx: AppContext, id: string, kind: Backup['kind']): Promise<void> {
  const { repo, config, storage, log } = ctx;
  const settings = loadBackupSettings(repo);
  const dir = backupDir(ctx);
  const staging = path.join(config.tmpDir, `backup-${id}`);
  const name = `listenerloop-${stamp(new Date())}-${id.slice(-4).toLowerCase()}.tar.gz`;
  const final = path.join(dir, name);
  const partial = `${final}.part`;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(staging, 'snapshot'), { recursive: true });
    // SQLite's own online backup: a consistent copy while the app keeps running.
    await repo.db.backup(path.join(staging, 'snapshot', 'app.db'));
    fs.writeFileSync(path.join(staging, 'CREATED'), `${new Date().toISOString()}\n`);
    const withAudio = settings.includeAudio && storage.name === 'local' && fs.existsSync(config.localStoragePath);
    if (withAudio) fs.symlinkSync(config.localStoragePath, path.join(staging, 'audio'), 'dir');
    await tarGz(partial, staging);
    fs.chmodSync(partial, 0o600);
    fs.renameSync(partial, final);
    const size = fs.statSync(final).size;

    let storageKey: string | null = null;
    if (settings.copyToStorage && storage.name === 's3') {
      storageKey = `backups/${name}`;
      await storage.put(storageKey, final, 'application/gzip');
    }
    repo.updateBackup(id, { status: 'ok', file: name, size_bytes: size, includes_audio: withAudio ? 1 : 0, storage_key: storageKey, finished_at: new Date().toISOString() });
    log.info({ backup: name, size }, 'backup finished');
    await pruneBackups(ctx, settings.keep);
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 300);
    log.error({ err }, 'backup failed');
    repo.updateBackup(id, { status: 'failed', error: reason, finished_at: new Date().toISOString() });
    fs.rmSync(partial, { force: true });
    if (kind === 'scheduled') await alertFailure(ctx, reason);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function alertFailure(ctx: AppContext, reason: string): Promise<void> {
  const to = ctx.repo.firstOwner()?.email;
  if (!ctx.mailer || !to) return;
  await ctx.mailer
    .send({ to, subject: 'ListenerLoop: the scheduled backup failed', text: `The scheduled backup did not finish.\n\nReason: ${reason}\n\nOpen ${ctx.config.appUrl}/settings to see the details and run it again.\n` })
    .catch((err) => ctx.log.warn({ err }, 'could not send the backup failure email'));
}

/** Removes a backup's file, its storage copy and its record. */
export async function removeBackup(ctx: AppContext, b: Backup): Promise<void> {
  const file = backupFilePath(ctx, b);
  if (file) fs.rmSync(file, { force: true });
  if (b.storage_key) await ctx.storage.delete(b.storage_key).catch((err) => ctx.log.warn({ err, key: b.storage_key }, 'could not remove the stored backup copy'));
  ctx.repo.deleteBackup(b.id);
}

/** Keeps the newest `keep` finished backups and the 10 newest failures. */
export async function pruneBackups(ctx: AppContext, keep: number): Promise<void> {
  const all = ctx.repo.listBackups(500);
  const ok = all.filter((b) => b.status === 'ok');
  const failed = all.filter((b) => b.status === 'failed');
  for (const b of [...ok.slice(keep), ...failed.slice(10)]) await removeBackup(ctx, b);
}
