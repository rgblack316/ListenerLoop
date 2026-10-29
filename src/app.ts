import rateLimit from '@fastify/rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { openDb, type DB } from './db/index.js';
import { Repo } from './db/repo.js';
import { createMailer, type Mailer } from './mail/index.js';
import { JobQueue } from './queue.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerPublicRoutes } from './routes/public.js';
import { createStorage, type StorageDriver } from './storage/index.js';
import { verifyWithCloudflare, type TurnstileVerifier } from './turnstile.js';

export interface BuildOptions {
  config: Config;
  db?: DB;
  storage?: StorageDriver;
  mailer?: Mailer | null;
  verifyTurnstile?: TurnstileVerifier;
  logger?: boolean | { level: string };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../public');
const brandDir = path.resolve(here, '../brand-assets');

export async function buildApp(opts: BuildOptions): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const { config } = opts;
  fs.mkdirSync(config.tmpDir, { recursive: true });

  const app = Fastify({
    logger: opts.logger ?? { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  });

  const ctx: AppContext = {
    config,
    repo: new Repo(opts.db ?? openDb(config.databasePath)),
    storage: opts.storage ?? createStorage(config),
    mailer: opts.mailer === undefined ? createMailer(config) : opts.mailer,
    queue: new JobQueue(1, (err) => app.log.error({ err }, 'background job failed')),
    transcribeQueue: new JobQueue(1, (err) => app.log.error({ err }, 'transcription job failed')),
    verifyTurnstile: opts.verifyTurnstile ?? verifyWithCloudflare,
    log: app.log,
  };

  // Broad per-IP ceiling for every route; sign-in and uploads have tighter limits of their own.
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart, {
    throwFileSizeLimit: true,
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 3, fields: 12, fieldSize: 4096, parts: 20 },
  });

  const htmxDist = path.dirname(createRequire(import.meta.url).resolve('htmx.org/dist/htmx.min.js'));
  await app.register(fastifyStatic, { root: publicDir, prefix: '/static/', index: false, maxAge: '5m' });
  await app.register(fastifyStatic, { root: brandDir, prefix: '/static/brand/', index: false, maxAge: '1d', decorateReply: false });
  await app.register(fastifyStatic, { root: htmxDist, prefix: '/static/vendor/', index: false, maxAge: '1d', decorateReply: false });

  app.addHook('onSend', async (_req, reply) => {
    void reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'strict-origin-when-cross-origin');
  });

  app.setErrorHandler((error, req, reply) => {
    const err = error as FastifyError;
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    const message =
      status === 413 ? 'The recording is too large.' : status >= 500 ? 'Something went wrong. Please try again.' : err.message;
    if (req.url.startsWith('/api/')) return reply.code(status).send({ error: err.code ?? 'error', message });
    return reply.code(status).type('text/plain').send(message);
  });

  app.get('/healthz', (_req, reply) => {
    try {
      ctx.repo.db.prepare('SELECT 1').get();
      return reply.send({ status: 'ok' });
    } catch {
      return reply.code(503).send({ status: 'error' });
    }
  });

  registerPublicRoutes(app, ctx, publicDir);
  registerAdminRoutes(app, ctx);

  return { app, ctx };
}
