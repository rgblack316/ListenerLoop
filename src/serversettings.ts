import type { Config } from './config.js';
import type { Repo } from './db/repo.js';
import { cleanText, decryptSecret, encryptSecret, ulid } from './lib/util.js';
import { createStorage, type StorageDriver } from './storage/index.js';

/**
 * Turnstile and storage settings edited on the Settings page. Like the email settings they live in the
 * database, secrets encrypted with a key derived from SESSION_SECRET, and replace the matching .env values.
 */
const TURNSTILE_KEY = 'turnstile_settings';
const STORAGE_KEY = 'storage_settings';

function open(value: string | undefined, secret: string): { value?: string; unreadable: boolean } {
  if (!value) return { unreadable: false };
  try {
    return { value: decryptSecret(value, secret), unreadable: false };
  } catch {
    return { unreadable: true };
  }
}

const parse = <T>(raw: string | undefined): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

// ------------------------------------------------------------------ Turnstile
interface StoredTurnstile {
  siteKey: string;
  secretKey?: string; // encrypted
}

export interface TurnstileForm {
  siteKey: string;
  /** Left blank to keep the saved secret. */
  secretKey: string;
}

export function applyStoredTurnstile(config: Config, repo: Repo): { unreadable: boolean } {
  const s = parse<StoredTurnstile>(repo.getSetting(TURNSTILE_KEY));
  if (!s) return { unreadable: false };
  const secret = open(s.secretKey, config.sessionSecret);
  config.turnstile = { siteKey: s.siteKey, secretKey: secret.value ?? '' };
  return { unreadable: secret.unreadable };
}

export function readTurnstileForm(body: unknown): TurnstileForm {
  const b = (body ?? {}) as Record<string, unknown>;
  return { siteKey: cleanText(b.site_key, 100), secretKey: typeof b.secret_key === 'string' ? b.secret_key.trim().slice(0, 200) : '' };
}

export function checkTurnstileForm(form: TurnstileForm, config: Config): string[] {
  const problems: string[] = [];
  if (!/^[0-9A-Za-z_-]{8,80}$/.test(form.siteKey)) problems.push('Enter the Turnstile site key from your Cloudflare dashboard.');
  if (form.secretKey && !/^[0-9A-Za-z_-]{8,200}$/.test(form.secretKey)) problems.push('The secret key should be letters and numbers only. Copy it again from Cloudflare.');
  if (!form.secretKey && !config.turnstile.secretKey) problems.push('Enter the Turnstile secret key.');
  return problems;
}

/** The secret that would be in use after saving this form. */
export const effectiveTurnstileSecret = (form: TurnstileForm, config: Config): string => form.secretKey || config.turnstile.secretKey;

export function saveTurnstile(config: Config, repo: Repo, form: TurnstileForm): void {
  const secret = effectiveTurnstileSecret(form, config);
  const stored: StoredTurnstile = { siteKey: form.siteKey, secretKey: secret ? encryptSecret(secret, config.sessionSecret) : undefined };
  repo.setSetting(TURNSTILE_KEY, JSON.stringify(stored));
  applyStoredTurnstile(config, repo);
}

// ------------------------------------------------------------------ storage
interface StoredStorage {
  driver: 'local' | 's3';
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey?: string; // encrypted
  forcePathStyle: boolean;
}

export interface StorageForm {
  driver: 'local' | 's3';
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  /** Left blank to keep the saved secret. */
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** Ticked to say existing recordings stay where they are. */
  confirmMove: boolean;
}

export function applyStoredStorage(config: Config, repo: Repo): { unreadable: boolean } {
  const s = parse<StoredStorage>(repo.getSetting(STORAGE_KEY));
  if (!s) return { unreadable: false };
  const secret = open(s.secretAccessKey, config.sessionSecret);
  config.storageDriver = s.driver;
  config.s3 = {
    endpoint: s.endpoint || undefined,
    region: s.region || 'auto',
    bucket: s.bucket || undefined,
    accessKeyId: s.accessKeyId || undefined,
    secretAccessKey: secret.value,
    forcePathStyle: s.forcePathStyle,
  };
  return { unreadable: secret.unreadable };
}

export function storageForm(config: Config): StorageForm {
  const s = config.s3;
  return {
    driver: config.storageDriver,
    endpoint: s.endpoint ?? '',
    region: s.region,
    bucket: s.bucket ?? '',
    accessKeyId: s.accessKeyId ?? '',
    secretAccessKey: '',
    forcePathStyle: s.forcePathStyle,
    confirmMove: false,
  };
}

export function readStorageForm(body: unknown): StorageForm {
  const b = (body ?? {}) as Record<string, unknown>;
  const f = (name: string, max: number): string => cleanText(b[name], max);
  return {
    driver: f('driver', 5) === 's3' ? 's3' : 'local',
    endpoint: f('s3_endpoint', 300),
    region: f('s3_region', 60) || 'auto',
    bucket: f('s3_bucket', 120),
    accessKeyId: f('s3_access_key_id', 200),
    secretAccessKey: typeof b.s3_secret_access_key === 'string' ? b.s3_secret_access_key.trim().slice(0, 300) : '',
    forcePathStyle: b.s3_force_path_style === '1',
    confirmMove: b.confirm_move === '1',
  };
}

/** Where recordings would go, as a comparable string. */
const place = (driver: string, endpoint: string | undefined, bucket: string | undefined, region: string | undefined): string =>
  driver === 'local' ? 'local' : `s3|${(endpoint ?? '').replace(/\/+$/, '')}|${bucket ?? ''}|${region ?? ''}`;

export function storageWouldMove(form: StorageForm, config: Config): boolean {
  return place(form.driver, form.endpoint, form.bucket, form.region) !== place(config.storageDriver, config.s3.endpoint, config.s3.bucket, config.s3.region);
}

export function checkStorageForm(form: StorageForm, config: Config): string[] {
  const problems: string[] = [];
  if (form.driver === 's3') {
    if (!form.bucket) problems.push('Enter the bucket name.');
    if (!form.accessKeyId) problems.push('Enter the access key ID.');
    if (!form.secretAccessKey && !config.s3.secretAccessKey) problems.push('Enter the secret access key.');
    if (form.endpoint) {
      try {
        const u = new URL(form.endpoint);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('x');
      } catch {
        problems.push('The endpoint must be a web address such as https://ACCOUNT.r2.cloudflarestorage.com.');
      }
    }
  }
  if (problems.length === 0 && storageWouldMove(form, config) && !form.confirmMove) {
    problems.push('This points the app at a different place for recordings. Existing recordings are not copied there, so older messages will stop playing. Tick the box to confirm you understand.');
  }
  return problems;
}

/** A copy of the config with the form applied, used to build and check a driver before anything changes. */
export function candidateConfig(form: StorageForm, config: Config): Config {
  return {
    ...config,
    storageDriver: form.driver,
    s3: {
      endpoint: form.endpoint || undefined,
      region: form.region || 'auto',
      bucket: form.bucket || undefined,
      accessKeyId: form.accessKeyId || undefined,
      secretAccessKey: form.secretAccessKey || config.s3.secretAccessKey,
      forcePathStyle: form.forcePathStyle,
    },
  };
}

/** Writes, reads back and deletes a small file. Returns the steps that worked, or throws with the reason. */
export async function runStorageCheck(storage: StorageDriver): Promise<string[]> {
  const key = `healthcheck/${ulid()}.txt`;
  const body = Buffer.from('ListenerLoop storage check');
  const steps: string[] = [];
  try {
    await storage.put(key, body, 'text/plain');
    steps.push('Wrote a test file');
    const size = await storage.size(key);
    if (size !== body.length) throw new Error('The test file was not the size that was written');
    const chunks: Buffer[] = [];
    for await (const c of await storage.getStream(key)) chunks.push(c as Buffer);
    if (Buffer.concat(chunks).toString() !== body.toString()) throw new Error('The test file read back differently');
    steps.push('Read it back');
    await storage.delete(key);
    if (await storage.exists(key)) throw new Error('The test file was not deleted');
    steps.push('Deleted it');
    return steps;
  } catch (err) {
    await storage.delete(key).catch(() => undefined);
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { steps });
  }
}

/** Saves the form and applies it; returns the new driver for the running app to use. */
export function saveStorage(config: Config, repo: Repo, form: StorageForm): StorageDriver {
  const next = candidateConfig(form, config);
  const stored: StoredStorage = {
    driver: form.driver,
    endpoint: form.endpoint,
    region: form.region,
    bucket: form.bucket,
    accessKeyId: form.accessKeyId,
    secretAccessKey: next.s3.secretAccessKey ? encryptSecret(next.s3.secretAccessKey, config.sessionSecret) : undefined,
    forcePathStyle: form.forcePathStyle,
  };
  repo.setSetting(STORAGE_KEY, JSON.stringify(stored));
  applyStoredStorage(config, repo);
  return createStorage(config);
}
