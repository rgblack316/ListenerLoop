import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { Repo } from './db/repo.js';
import type { Mailer } from './mail/index.js';
import type { JobQueue } from './queue.js';
import type { StorageDriver } from './storage/index.js';
import type { TurnstileVerifier } from './turnstile.js';

/** Everything the routes and background jobs need, passed explicitly so tests can swap parts. */
export interface AppContext {
  config: Config;
  repo: Repo;
  storage: StorageDriver;
  mailer: Mailer | null;
  queue: JobQueue;
  verifyTurnstile: TurnstileVerifier;
  log: FastifyBaseLogger;
}
