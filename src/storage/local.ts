import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { StorageDriver } from './index.js';

/** Stores objects as files under a root directory. Audio is streamed through the app. */
export class LocalStorage implements StorageDriver {
  readonly name = 'local' as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
  }

  private resolve(key: string): string {
    if (!key || key.includes('\0') || path.isAbsolute(key)) throw new Error('Invalid storage key');
    const full = path.resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new Error('Invalid storage key');
    return full;
  }

  async put(key: string, file: string | Buffer, _contentType?: string): Promise<void> {
    const dest = this.resolve(key);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.partial`;
    if (typeof file === 'string') await fs.promises.copyFile(file, tmp);
    else await fs.promises.writeFile(tmp, file);
    await fs.promises.rename(tmp, dest);
  }

  async getStream(key: string, range?: { start: number; end: number }): Promise<Readable> {
    return fs.createReadStream(this.resolve(key), range ? { start: range.start, end: range.end } : undefined);
  }

  async size(key: string): Promise<number | null> {
    try {
      return (await fs.promises.stat(this.resolve(key))).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.size(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    await fs.promises.rm(this.resolve(key), { force: true });
  }
}
