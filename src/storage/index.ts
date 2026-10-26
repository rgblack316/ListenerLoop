import type { Readable } from 'node:stream';
import type { Config } from '../config.js';
import { LocalStorage } from './local.js';
import { S3Storage } from './s3.js';

export interface SignedUrlOptions {
  contentType?: string;
  downloadName?: string;
}

export interface StorageDriver {
  readonly name: 'local' | 's3';
  /** Store a file (path on disk) or buffer under the given key. */
  put(key: string, file: string | Buffer, contentType: string): Promise<void>;
  /** Stream an object, optionally a byte range (inclusive). */
  getStream(key: string, range?: { start: number; end: number }): Promise<Readable>;
  /** Object size in bytes, or null when the object does not exist. */
  size(key: string): Promise<number | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Short-lived direct URL. Drivers that cannot sign (local) leave this undefined. */
  getSignedUrl?(key: string, ttlSeconds: number, options?: SignedUrlOptions): Promise<string>;
}

export function createStorage(config: Config): StorageDriver {
  return config.storageDriver === 's3' ? new S3Storage(config) : new LocalStorage(config.localStoragePath);
}

/** Keys look like shows/<show_id>/<yyyy>/<message_id>.mp3 */
export function messageKey(showId: string, createdAtIso: string, messageId: string, suffix: 'mp3' | 'orig'): string {
  return `shows/${showId}/${createdAtIso.slice(0, 4)}/${messageId}.${suffix}`;
}
