import './env.js';
import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { purgeDeleted, purgeExpired, recoverInterrupted } from './process.js';

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

  const { app, ctx } = await buildApp({ config });

  if (!ctx.mailer) {
    app.log.warn('No mail provider is configured (MAIL_PROVIDER, SMTP_HOST or RESEND_API_KEY, MAIL_FROM). Email alerts are off.');
  }
  if (!ctx.repo.getAdmin()) {
    app.log.warn('No admin account yet. Create one with: node dist/cli.js create-admin you@example.com');
  }

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
  const sweep = setInterval(() => {
    ctx.repo.deleteExpiredSessions();
    purgeAndLog();
  }, 60 * 60 * 1000);
  sweep.unref();

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'shutting down');
    clearInterval(sweep);
    await app.close();
    // Let an in-flight conversion finish, but do not hang forever.
    await Promise.race([ctx.queue.idle(), new Promise((r) => setTimeout(r, 30_000))]);
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
