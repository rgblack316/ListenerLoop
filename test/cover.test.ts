import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FetchError, findCoverUrl, isPublicAddress, safeGet } from '../src/feed.js';
import { checkFeedUrl } from '../src/cover.js';
import { APP_URL, formPost, hasFfmpeg, login, makeHarness, type Harness } from './helpers.js';

describe('address safety', () => {
  it('only treats public addresses as reachable', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', 'nonsense']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it('refuses private, odd or unsafe addresses before connecting', async () => {
    const bad = ['http://127.0.0.1/feed', 'http://[::1]/feed', 'http://169.254.169.254/latest/meta-data/', 'http://localhost/feed', 'https://example.com:8443/x', 'ftp://example.com/feed', 'http://user:pw@example.com/feed', 'not a url'];
    for (const url of bad) await expect(safeGet(url, { maxBytes: 1000, timeoutMs: 3000 }), url).rejects.toBeInstanceOf(FetchError);
  });

  it('checks the feed address typed into the form', () => {
    expect(checkFeedUrl('  ')).toEqual({ url: '' });
    expect(checkFeedUrl('https://example.com/feed.xml')).toEqual({ url: 'https://example.com/feed.xml' });
    expect(checkFeedUrl('ftp://example.com/x')).toHaveProperty('error');
    expect(checkFeedUrl('javascript:alert(1)')).toHaveProperty('error');
    expect(checkFeedUrl('https://a:b@example.com/')).toHaveProperty('error');
    expect(checkFeedUrl('x'.repeat(600))).toHaveProperty('error');
  });
});

describe('finding the cover in a feed', () => {
  it('prefers the iTunes image and ignores episode artwork', () => {
    const xml = `<rss><channel><title>T</title><image><url>https://x.test/plain.jpg</url></image><itunes:image href="https://x.test/it.jpg?a=1&amp;b=2"/><item><itunes:image href="https://x.test/ep.jpg"/></item></channel></rss>`;
    expect(findCoverUrl(xml)).toBe('https://x.test/it.jpg?a=1&b=2');
  });
  it('falls back to the plain RSS image and understands CDATA', () => {
    expect(findCoverUrl('<rss><channel><image><title>t</title><url><![CDATA[https://x.test/p.png]]></url></image></channel></rss>')).toBe('https://x.test/p.png');
    expect(findCoverUrl("<channel><itunes:image href='/rel.jpg'/></channel>")).toBe('/rel.jpg');
  });
  it('does not take artwork that only appears in an episode', () => {
    expect(findCoverUrl('<channel><title>T</title><item><itunes:image href="https://x.test/ep.jpg"/></item></channel>')).toBeNull();
    expect(findCoverUrl('<html>nothing</html>')).toBeNull();
  });
});

function png(width: number, height: number): Buffer {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=orange:s=${width}x${height}`, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { maxBuffer: 50 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(String(r.stderr));
  return r.stdout;
}

describe.skipIf(!hasFfmpeg())('cover art from a feed', () => {
  let h: Harness;
  let server: http.Server;
  let base = '';
  let session: { cookie: string; csrf: string };
  const art = png(600, 400);
  const tooWide = png(9000, 10);

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const send = (type: string, body: Buffer | string, status = 200): void => {
        res.writeHead(status, { 'content-type': type });
        res.end(body);
      };
      const u = req.url ?? '';
      if (u === '/feed.xml') return send('application/rss+xml', `<rss xmlns:itunes="x"><channel><title>Feed</title><itunes:image href="${base}/art.png"/><item><title>e</title></item></channel></rss>`);
      if (u === '/relative.xml') return send('application/xml', '<rss><channel><itunes:image href="/art.png"/></channel></rss>');
      if (u === '/redirect.xml') { res.writeHead(302, { location: '/feed.xml' }); return res.end(); }
      if (u === '/noart.xml') return send('application/xml', '<rss><channel><title>No art</title></channel></rss>');
      if (u === '/notimage.xml') return send('application/xml', `<rss><channel><itunes:image href="${base}/notimage.txt"/></channel></rss>`);
      if (u === '/notimage.txt') return send('text/plain', 'hello, this is not an image at all, just words '.repeat(10));
      if (u === '/wide.xml') return send('application/xml', `<rss><channel><itunes:image href="${base}/wide.png"/></channel></rss>`);
      if (u === '/art.png') return send('image/png', art);
      if (u === '/wide.png') return send('image/png', tooWide);
      return send('text/plain', 'missing', 404);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    h = await makeHarness({ FEED_ALLOW_PRIVATE: 'true' });
    session = await login(h);
  });
  afterAll(async () => {
    await h.close();
    await new Promise((r) => server.close(r));
  });

  const save = (slug: string, feed: string, name = 'Cover Show') =>
    formPost(h, `/shows/${slug}/settings`, session, { name, slug, notify_email: 'h@example.com', max_seconds: '60', accent_color: '#21649e', allowed_origins: APP_URL, feed_url: feed });
  const dims = (file: string): string => spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout.trim();

  it('fetches, shrinks and stores the cover when a feed is saved, then shows it around the dashboard', async () => {
    const show = h.ctx.repo.createShow({ name: 'Cover Show', notify_email: 'h@example.com' });
    const res = await save(show.slug, `${base}/feed.xml`);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/shows?flash=saved');
    const saved = h.ctx.repo.getShow(show.id)!;
    expect(saved.feed_url).toBe(`${base}/feed.xml`);
    expect(saved.cover_key).toBe(`covers/${show.id}.jpg`);
    expect(saved.cover_error).toBeNull();
    expect(dims(path.join(h.config.localStoragePath, saved.cover_key!))).toBe('256,256');

    const img = await h.app.inject({ method: 'GET', url: `/shows/${show.slug}/cover`, headers: { cookie: session.cookie } });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(img.rawPayload.subarray(0, 2).toString('hex')).toBe('ffd8');

    const get = async (url: string): Promise<string> => (await h.app.inject({ method: 'GET', url, headers: { cookie: session.cookie } })).body;
    for (const url of ['/shows', `/shows/${show.slug}`, `/shows/${show.slug}/settings`]) {
      expect(await get(url), url).toContain(`/shows/${show.slug}/cover?v=`);
    }
  });

  it('follows redirects and relative cover addresses', async () => {
    const a = h.ctx.repo.createShow({ name: 'Redirect Show', notify_email: 'h@example.com' });
    await save(a.slug, `${base}/redirect.xml`, 'Redirect Show');
    expect(h.ctx.repo.getShow(a.id)!.cover_key).not.toBeNull();
    const b = h.ctx.repo.createShow({ name: 'Relative Show', notify_email: 'h@example.com' });
    await save(b.slug, `${base}/relative.xml`, 'Relative Show');
    expect(h.ctx.repo.getShow(b.id)!.cover_key).not.toBeNull();
  });

  it('keeps the show saved but explains what went wrong', async () => {
    const cases: [string, string][] = [
      ['/noart.xml', 'does not list any cover art'],
      ['/notimage.xml', 'not an image'],
      ['/wide.xml', 'too large'],
      ['/missing.xml', 'answered 404'],
    ];
    for (const [feed, reason] of cases) {
      const show = h.ctx.repo.createShow({ name: `Fail ${feed}`, notify_email: 'h@example.com' });
      const res = await save(show.slug, `${base}${feed}`, `Fail ${feed}`);
      expect(res.statusCode, feed).toBe(302);
      expect(res.headers.location).toContain('flash=coverfail');
      const saved = h.ctx.repo.getShow(show.id)!;
      expect(saved.feed_url).toBe(`${base}${feed}`);
      expect(saved.cover_key).toBeNull();
      expect(saved.cover_error, feed).toContain(reason);
      const page = await h.app.inject({ method: 'GET', url: `/shows/${show.slug}/settings`, headers: { cookie: session.cookie } });
      expect(page.body).toContain('Cover art could not be fetched');
      expect(page.body).toContain('Fetch cover art');
      expect(page.body).toContain('cover-letter'); // letter tile until a cover exists
    }
  });

  it('refreshes on request, and removing the feed removes the cover', async () => {
    const show = h.ctx.repo.createShow({ name: 'Refresh Show', notify_email: 'h@example.com' });
    await save(show.slug, `${base}/feed.xml`, 'Refresh Show');
    const file = path.join(h.config.localStoragePath, h.ctx.repo.getShow(show.id)!.cover_key!);
    fs.rmSync(file);
    const refreshed = await formPost(h, `/shows/${show.slug}/cover/refresh`, session, {});
    expect(refreshed.headers.location).toContain('flash=coverok');
    expect(fs.existsSync(file)).toBe(true);
    await save(show.slug, '', 'Refresh Show');
    const cleared = h.ctx.repo.getShow(show.id)!;
    expect(cleared.feed_url).toBeNull();
    expect(cleared.cover_key).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
    expect((await h.app.inject({ method: 'GET', url: `/shows/${show.slug}/cover`, headers: { cookie: session.cookie } })).statusCode).toBe(404);
  });

  it('rejects a bad feed address in the form and needs a login to see covers', async () => {
    const show = h.ctx.repo.createShow({ name: 'Plain Show', notify_email: 'h@example.com' });
    const bad = await save(show.slug, 'javascript:alert(1)', 'Plain Show');
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('must start with https://');
    expect((await h.app.inject({ method: 'GET', url: `/shows/${show.slug}/cover` })).statusCode).toBe(302);
    expect((await formPost(h, `/shows/${show.slug}/cover/refresh`, { ...session, csrf: 'wrong' }, {})).statusCode).toBe(403);
  });

  it('fetches the cover when a show is created with a feed', async () => {
    const res = await formPost(h, '/shows', session, { name: 'Born With Art', notify_email: 'h@example.com', max_seconds: '60', accent_color: '#21649e', feed_url: `${base}/feed.xml` });
    expect(res.statusCode).toBe(302);
    const created = h.ctx.repo.listShows().find((s) => s.name === 'Born With Art')!;
    expect(created.cover_key).not.toBeNull();
  });
});
