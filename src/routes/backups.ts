import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { backupFilePath, normalizeSettings, removeBackup, saveBackupSettings, startBackup } from '../backup.js';
import type { AppContext } from '../context.js';
import type { RouteKit } from './users.js';

export function registerBackupRoutes(app: FastifyInstance, ctx: AppContext, kit: RouteKit): void {
  const { repo, storage } = ctx;
  const { ownerAuthed, ownerMutating, field, notFound } = kit;
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
}
