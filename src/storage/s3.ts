import fs from 'node:fs';
import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from '../config.js';
import type { SignedUrlOptions, StorageDriver } from './index.js';

/** Any S3-compatible service (Cloudflare R2, Backblaze B2, MinIO, AWS S3). The bucket stays private. */
export class S3Storage implements StorageDriver {
  readonly name = 's3' as const;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: Config) {
    const { s3 } = config;
    if (!s3.bucket || !s3.accessKeyId || !s3.secretAccessKey) throw new Error('S3 storage is not fully configured');
    this.bucket = s3.bucket;
    this.client = new S3Client({
      region: s3.region,
      endpoint: s3.endpoint,
      forcePathStyle: s3.forcePathStyle,
      credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
      // R2 and several other providers reject the newer default checksum headers.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async put(key: string, file: string | Buffer, contentType: string): Promise<void> {
    // Uploads are capped (MAX_UPLOAD_MB), so buffering keeps this simple and retry-safe.
    const body = typeof file === 'string' ? await fs.promises.readFile(file) : file;
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async getStream(key: string, range?: { start: number; end: number }): Promise<Readable> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range ? `bytes=${range.start}-${range.end}` : undefined }),
    );
    return res.Body as Readable;
  }

  async size(key: string): Promise<number | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return res.ContentLength ?? 0;
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.size(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async getSignedUrl(key: string, ttlSeconds: number, options: SignedUrlOptions = {}): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentType: options.contentType,
      ResponseContentDisposition: options.downloadName ? `attachment; filename="${options.downloadName.replace(/[^\w.-]/g, '_')}"` : undefined,
    });
    return getSignedUrl(this.client, command, { expiresIn: ttlSeconds });
  }
}
