import { deliverDue } from './webhook.js';
import { applyPendingRestore, prunePreRestore, reconcileBackups } from './restore.js';
import { scheduledBackupDue, startBackup } from './backup.js';
import './env.js';
import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { backfillWaveforms, purgeDeleted, purgeExpired, recoverInterrupted } from './process.js';
import { recoverTranscriptions } from './transcribe.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  // A restore chosen in the admin is applied here, before the database is opened.
  const restored = applyPendingRestore({
    dataDir: config.dataDir,
    databasePath: config.databasePath,
    audioPath: config.localStoragePath,
    localStorage: config.storageDriver === 'local',
  });
  prunePreRestore(config.dataDir);
  const { app, ctx } = await buildApp({ config });
  if (restored) {
    ctx.repo.setSetting('last_restore', JSON.stringify(restored));
    if (restored.ok) app.log.warn({ safeDir: restored.safeDir }, 'restored a backup');
    else app.log.error({ error: restored.error }, 'the staged restore failed; the previous data is still in use');
  }
  void reconcileBackups(ctx).catch((err) => app.log.warn({ err }, 'could not check the backups folder'));

  if (!ctx.mailer) {
    app.log.warn('No mail provider is configured (MAIL_PROVIDER, SMTP_HOST or RESEND_API_KEY, MAIL_FROM). Email alerts are off.');
  }
  if (!ctx.repo.hasSiteAdmin()) {
    app.log.warn('No admin account yet. Create one with: node dist/cli.js create-admin you@example.com');
  }

  const requeuedTranscripts = recoverTranscriptions(ctx);
  if (requeuedTranscripts > 0) app.log.info({ requeued: requeuedTranscripts }, 'requeued unfinished transcriptions');
  const drawn = backfillWaveforms(ctx);
  if (drawn > 0) app.log.info({ drawn }, 'drawing waveforms for older messages');
  const requeued = recoverInterrupted(ctx);
  if (requeued > 0) app.log.info({ requeued }, 'requeued interrupted uploads');

  const purgeAndLog = (): void => {
    void purgeDeleted(ctx).then((n) => {
      if (n > 0) app.log.info({ purged: n }, 'removed deleted messages from storage');
    });
    void purgeExpired(ctx).then((n) => {
      if (n > 0) app.log.info({ purged: n, retentionDays: ctx.config.retentionDays }, 'removed messages past the retention period');
    });
  };
  purgeAndLog();
  ctx.repo.deleteExpiredSessions();
  ctx.repo.pruneDeliveries();
  const sweep = setInterval(() => {
    ctx.repo.deleteExpiredSessions();
    purgeAndLog();
  }, 60 * 60 * 1000);
  sweep.unref();
  // Retry webhook deliveries that failed earlier, and pick up any left over from a restart.
  // Scheduled backups: checked every minute, started when a scheduled time has passed.
  const interrupted = ctx.repo.failInterruptedBackups();
  if (interrupted > 0) app.log.warn({ interrupted }, 'marked unfinished backups as failed');
  const backups = setInterval(() => {
    if (scheduledBackupDue(ctx.repo)) startBackup(ctx, 'scheduled', null);
  }, 60_000);
  backups.unref();
  const hooks = setInterval(() => void deliverDue(ctx), 30_000);
  hooks.unref();
  void deliverDue(ctx);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'shutting down');
    clearInterval(sweep);
    clearInterval(hooks);
    clearInterval(backups);
    await app.close();
    // Let an in-flight conversion finish, but do not hang forever.
    await Promise.race([Promise.all([ctx.queue.idle(), ctx.transcribeQueue.idle()]), new Promise((r) => setTimeout(r, 30_000))]);
    ctx.repo.db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
