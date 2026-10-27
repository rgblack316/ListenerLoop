import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { verify } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';
import { csrfValid } from '../auth.js';
import { reconcileBackups, inspectArchive, localCopy, MAX_IMPORT_MB, requestRestart, stageRestore } from '../restore.js';
import { restoreConfirmPage, restoringPage } from '../views/restore.js';
import { ulid } from '../lib/util.js';
import { backupDir, backupRunning, backupFilePath, normalizeSettings, removeBackup, saveBackupSettings, startBackup } from '../backup.js';
import type { AppContext } from '../context.js';
import type { RouteKit } from './users.js';

export function registerBackupRoutes(app: FastifyInstance, ctx: AppContext, kit: RouteKit): void {
  const { repo, storage } = ctx;
  const { ownerAuthed, ownerMutating, field, notFound, renderSettings } = kit;
  const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 300);
  const back = (flash: string) => `/settings?backup=${flash}#backups`;

  app.post('/settings/backups/run', ownerMutating((_req, reply, session) => {
    const r = startBackup(ctx, 'manual', session.email);
    return reply.redirect(back('error' in r ? 'running' : 'started'));
  }));

  app.post('/settings/backups', ownerMutating((req, reply) => {
    const body = req.body as Record<string, unknown>;
    const s = normalizeSettings({
      schedule: field(body, 'schedule') as 'off',
      weekday: Number(field(body, 'weekday')),
      hour: Number(field(body, 'hour')),
      keep: Number(field(body, 'keep')),
      includeAudio: storage.name === 'local' ? field(body, 'include_audio') === '1' : true,
      destination: field(body, 'destination') as 'both',
    });
    saveBackupSettings(repo, s);
    return reply.redirect(back('saved'));
  }));

  app.get('/settings/backups/:id/download', ownerAuthed(async (req, reply) => {
    const b = repo.getBackup((req.params as { id: string }).id);
    if (!b || b.status !== 'ok' || !b.file) return notFound(reply);
    reply.header('Content-Disposition', `attachment; filename="${b.file}"`).header('Cache-Control', 'no-store').type('application/gzip');
    const file = backupFilePath(ctx, b);
    if (file && fs.existsSync(file)) return reply.header('Content-Length', fs.statSync(file).size).send(fs.createReadStream(file));
    // Bucket-only backups are streamed from the bucket.
    if (b.storage_key && (await storage.exists(b.storage_key))) return reply.send(await storage.getStream(b.storage_key));
    return notFound(reply);
  }));

  app.post('/settings/backups/:id/delete', ownerMutating(async (req, reply) => {
    const b = repo.getBackup((req.params as { id: string }).id);
    if (!b) return notFound(reply);
    if (b.status === 'running') return reply.redirect(back('running'));
    await removeBackup(ctx, b);
    return reply.redirect(back('deleted'));
  }));

  // ---------------------------------------------------------------- restore
  app.get('/settings/backups/:id/restore', ownerAuthed(async (req, reply, session) => {
    const b = repo.getBackup((req.params as { id: string }).id);
    if (!b || b.status !== 'ok') return notFound(reply);
    let copy;
    try {
      copy = await localCopy(ctx, b);
      const info = await inspectArchive(ctx, copy.path);
      return kit.page(reply, restoreConfirmPage({ csrf: session.csrf, backup: b, info, storage: storage.name, dataDir: ctx.config.dataDir }));
    } catch (err) {
      return renderSettings(reply, session, { section: 'backups', ok: false, message: `This backup cannot be restored: ${msg(err)}` }, 400);
    } finally {
      copy?.cleanup();
    }
  }));

  app.post('/settings/backups/:id/restore', ownerMutating(async (req, reply, session) => {
    const b = repo.getBackup((req.params as { id: string }).id);
    if (!b || b.status !== 'ok') return notFound(reply);
    const fail = (message: string, status = 400) => renderSettings(reply, session, { section: 'backups', ok: false, message }, status);
    if (field(req.body, 'confirm').trim() !== 'RESTORE') return fail('Type RESTORE exactly to confirm. Nothing was changed.');
    let good = false;
    try {
      good = await verify(repo.getUser(session.userId)!.password_hash, field(req.body, 'password'));
    } catch {
      good = false;
    }
    if (!good) return fail('The password is not right. Nothing was changed.', 401);
    if (backupRunning()) return fail('A backup is running. Wait for it to finish, then try again.');
    let copy;
    try {
      copy = await localCopy(ctx, b);
      await stageRestore(ctx, copy.path, session.email);
    } catch (err) {
      return fail(`The restore was not started: ${msg(err)}`);
    } finally {
      copy?.cleanup();
    }
    ctx.log.warn({ backup: b.file, by: session.email }, 'restore staged; restarting to apply it');
    reply.raw.once('finish', () => setTimeout(requestRestart, 500));
    return kit.page(reply, restoringPage());
  }));

  app.post('/settings/backups/scan', ownerMutating(async (_req, reply) => {
    await reconcileBackups(ctx);
    return reply.redirect(back('scanned'));
  }));

  // Uploading a backup file. The token field must come before the file so it is checked before anything is written.
  app.post('/settings/backups/import', ownerAuthed(async (req, reply, session) => {
    const fail = (message: string, status = 400) => renderSettings(reply, session, { section: 'backups', ok: false, message }, status);
    if (!kit.sameOrigin(req)) return reply.code(403).type('text/plain').send('Request could not be verified. Reload the page and try again.');
    if (!req.isMultipart()) return fail('Choose a backup file to upload.');
    const dir = backupDir(ctx);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `import-${ulid()}.part`);
    let verified = false;
    let got = false;
    try {
      for await (const part of req.parts({ limits: { fileSize: MAX_IMPORT_MB * 1024 * 1024, files: 1, fields: 4, parts: 6 } })) {
        if (part.type === 'field') {
          if (part.fieldname === '_csrf' && csrfValid(session, part.value)) verified = true;
          continue;
        }
        if (!verified || got) {
          part.file.resume();
          continue;
        }
        got = true;
        await pipeline(part.file, fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
        if (part.file.truncated) throw new Error(`That file is larger than ${MAX_IMPORT_MB} MB.`);
      }
      if (!verified) return reply.code(403).type('text/plain').send('Request could not be verified. Reload the page and try again.');
      if (!got) return fail('Choose a backup file to upload.');
      const info = await inspectArchive(ctx, tmp);
      const name = `imported-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')}-${ulid().slice(-4).toLowerCase()}.tar.gz`;
      fs.renameSync(tmp, path.join(dir, name));
      const id = ulid();
      repo.insertBackup({ id, kind: 'manual', started_by: `${session.email} (imported)` });
      repo.updateBackup(id, { status: 'ok', file: name, size_bytes: fs.statSync(path.join(dir, name)).size, includes_audio: info.hasAudio ? 1 : 0, finished_at: new Date().toISOString() });
      return reply.redirect(back('imported'));
    } catch (err) {
      return fail(`That file was not added: ${msg(err)}`);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }));
}
