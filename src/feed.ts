import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

/** Addresses a server-side fetch must never reach: this machine, private networks, link-local and cloud metadata. */
const blocked = new net.BlockList();
for (const [net4, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net4, bits, 'ipv4');
for (const [net6, bits] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32], ['2002::', 16], ['100::', 64],
] as const) blocked.addSubnet(net6, bits, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '');
  const family = net.isIP(ip);
  if (family === 0) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return !blocked.check(mapped[1]!, 'ipv4');
  return !blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

export class FetchError extends Error {}

export interface SafeGetOptions {
  maxBytes: number;
  timeoutMs?: number;
  accept?: string;
  /** Stop reading early once this returns true for the text read so far (used to read only a feed's header). */
  stopWhen?: (soFar: string) => boolean;
  /** Tests only: allow local addresses and any port. */
  allowPrivate?: boolean;
  maxRedirects?: number;
}

export interface SafeGetResult {
  finalUrl: string;
  contentType: string;
  body: Buffer;
}

/** Resolve a name and only ever connect to a public address, so DNS tricks cannot point us at the inside network. */
function guardedLookup(allowPrivate: boolean): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err, '', 4);
      const ok = addresses.filter((a) => allowPrivate || isPublicAddress(a.address));
      if (ok.length === 0 || ok.length !== addresses.length) {
        return callback(new FetchError('That address points to a private or internal network, which is not allowed.') as NodeJS.ErrnoException, '', 4);
      }
      if ((options as { all?: boolean }).all) {
        (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, ok);
      } else {
        callback(null, ok[0]!.address, ok[0]!.family);
      }
    });
  };
}

function checkUrl(raw: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchError('That is not a valid web address.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new FetchError('Only http and https addresses are allowed.');
  if (url.username || url.password) throw new FetchError('Addresses with a username or password are not allowed.');
  if (!allowPrivate && url.port && url.port !== '80' && url.port !== '443') throw new FetchError('Only the standard web ports are allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !allowPrivate && !isPublicAddress(host)) throw new FetchError('That address points to a private or internal network, which is not allowed.');
  return url;
}

function requestOnce(url: URL, opts: SafeGetOptions, deadline: number): Promise<{ status: number; location?: string; contentType: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: 'GET',
        lookup: guardedLookup(!!opts.allowPrivate),
        headers: { 'user-agent': 'ListenerLoop/1.0 (+cover-art)', accept: opts.accept ?? '*/*', 'accept-encoding': 'gzip, deflate, br' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ status, location: String(res.headers.location), contentType, body: Buffer.alloc(0) });
        }
        if (status !== 200) {
          res.resume();
          return reject(new FetchError(`The server answered ${status}.`));
        }
        if (Number(res.headers['content-length'] ?? 0) > opts.maxBytes * 20) {
          res.destroy();
          return reject(new FetchError('The file is too large.'));
        }
        const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
        const stream: NodeJS.ReadableStream =
          encoding === 'gzip' ? res.pipe(zlib.createGunzip()) : encoding === 'deflate' ? res.pipe(zlib.createInflate()) : encoding === 'br' ? res.pipe(zlib.createBrotliDecompress()) : res;
        const chunks: Buffer[] = [];
        let size = 0;
        let tail = '';
        let done = false;
        const finish = (err?: Error): void => {
          if (done) return;
          done = true;
          res.destroy();
          if (err) reject(err);
          else resolve({ status, contentType, body: Buffer.concat(chunks).subarray(0, opts.maxBytes) });
        };
        stream.on('data', (chunk: Buffer) => {
          if (Date.now() > deadline) return finish(new FetchError('The server took too long to answer.'));
          chunks.push(chunk);
          size += chunk.length;
          if (opts.stopWhen) {
            tail = (tail.slice(-64) + chunk.toString('latin1'));
            if (opts.stopWhen(tail)) return finish();
          }
          if (size > opts.maxBytes) {
            if (opts.stopWhen) return finish(); // a feed header can be read from the start of a large file
            return finish(new FetchError('The file is too large.'));
          }
        });
        stream.on('end', () => finish());
        stream.on('error', (e) => finish(new FetchError(`Could not read the response: ${(e as Error).message}`)));
      },
    );
    req.setTimeout(Math.max(1000, deadline - Date.now()), () => req.destroy(new FetchError('The server took too long to answer.')));
    req.on('error', (e) => reject(e instanceof FetchError ? e : new FetchError(`Could not connect: ${e.message}`)));
    req.end();
  });
}

/** Fetch a public web address with limits on redirects, size and time. Used for the podcast's RSS feed and cover image. */
export async function safeGet(rawUrl: string, opts: SafeGetOptions): Promise<SafeGetResult> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  let current = rawUrl;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 4); hop++) {
    const url = checkUrl(current, !!opts.allowPrivate);
    const res = await requestOnce(url, opts, deadline);
    if (res.status >= 300 && res.status < 400 && res.location) {
      try {
        current = new URL(res.location, url).toString();
      } catch {
        throw new FetchError('The server sent a broken redirect.');
      }
      continue;
    }
    return { finalUrl: url.toString(), contentType: res.contentType, body: res.body };
  }
  throw new FetchError('Too many redirects.');
}

const decodeXml = (s: string): string =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .trim();

/** The channel's cover art address: the iTunes image first, then the plain RSS image. Ignores anything inside an episode. */
export function findCoverUrl(xml: string): string | null {
  const head = xml.split(/<item[\s>]/i)[0] ?? xml;
  const itunes = /<itunes:image\b[^>]*?\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(head);
  if (itunes) return decodeXml(itunes[1] ?? itunes[2] ?? '') || null;
  const image = /<image\b[^>]*>[\s\S]*?<url[^>]*>([\s\S]*?)<\/url>/i.exec(head);
  if (image) return decodeXml(image[1] ?? '') || null;
  return null;
}
