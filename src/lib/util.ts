import crypto from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Sortable unique id: 48-bit millisecond timestamp + 80 random bits, Crockford base32 (26 chars). */
export function ulid(now: number = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.randomBytes(10);
  let bits = 0;
  let acc = 0;
  let rand = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      rand += CROCKFORD[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return time + rand;
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hmacHex(secret: string, value: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Salted, one-way hash of an IP address. Only used for rate limiting and abuse review. */
export function hashIp(ip: string, secret: string): string {
  return hmacHex(secret, `ip:${ip}`).slice(0, 32);
}

const ENC_PREFIX = 'v1';

function encKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(`listenerloop:secrets:${secret}`).digest();
}

/** AES-256-GCM. Used to keep per-show Turnstile secret keys encrypted at rest. */
export function encryptSecret(plain: string, secret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(secret), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENC_PREFIX, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

export function decryptSecret(encoded: string, secret: string): string {
  const [prefix, iv, tag, ct] = encoded.split(':');
  if (prefix !== ENC_PREFIX || !iv || !tag || !ct) throw new Error('Unrecognized secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(secret), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029]+', 'g');

/** Trim, collapse whitespace and strip control characters. */
export function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  // Control characters and the Unicode line/paragraph separators become spaces.
  return value
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
export function isValidEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_RE.test(value);
}

export function slugify(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'show'
  );
}

/** Parse an HTTP Range header ("bytes=a-b") against a known size. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return 'invalid';
  const [, a = '', b = ''] = m;
  if (a === '' && b === '') return 'invalid';
  let start: number;
  let end: number;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

/** File-name-safe fragment for download names. */
export function safeFilePart(value: string): string {
  return slugify(value).slice(0, 40);
}
