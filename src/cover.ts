import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from './context.js';
import type { Show } from './db/repo.js';
import { FetchError, findCoverUrl, safeGet } from './feed.js';
import { run } from './media/convert.js';

export const COVER_SIZE = 256;
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_SIDE = 8000;

export const coverKey = (showId: string): string => `covers/${showId}.jpg`;

/** A feed address from a form: http or https, trimmed, or an error message. */
export function checkFeedUrl(raw: string): { url: string } | { error: string } {
  const value = raw.trim();
  if (!value) return { url: '' };
  if (value.length > 500) return { error: 'The RSS feed address is too long.' };
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'The RSS feed address must start with https://' };
    if (u.username || u.password) return { error: 'The RSS feed address should not contain a username or password.' };
    return { url: u.toString() };
  } catch {
    return { error: 'The RSS feed address does not look like a web address.' };
  }
}

async function fetchCover(ctx: AppContext, feedUrl: string, work: string): Promise<string> {
  const allowPrivate = ctx.config.feedAllowPrivate;
  const feed = await safeGet(feedUrl, {
    maxBytes: MAX_FEED_BYTES,
    timeoutMs: 15_000,
    accept: 'application/rss+xml, application/xml, text/xml, */*',
    stopWhen: (soFar) => /<item[\s>]/i.test(soFar),
    allowPrivate,
  });
  const found = findCoverUrl(feed.body.toString('utf8'));
  if (!found) throw new FetchError("That feed does not list any cover art. Check that it is your podcast's RSS feed.");
  let imageUrl: string;
  try {
    imageUrl = new URL(found, feed.finalUrl).toString();
  } catch {
    throw new FetchError('The feed lists a cover art address that is not valid.');
  }
  const image = await safeGet(imageUrl, { maxBytes: MAX_IMAGE_BYTES, timeoutMs: 20_000, accept: 'image/*', allowPrivate });
  if (image.body.length < 100) throw new FetchError('The cover art file is empty.');
  const input = `${work}.src`;
  const output = `${work}.jpg`;
  await fs.promises.writeFile(input, image.body);
  // Size check before decoding, so a tiny file that claims enormous dimensions cannot exhaust memory.
  const probe = await run(ctx.config.ffprobePath, ['-v', 'error', '-protocol_whitelist', 'file', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', input], 15_000).catch(() => null);
  const dims = /^(\d+),(\d+)/.exec((probe?.stdout ?? '').trim());
  if (!probe || probe.code !== 0 || !dims) throw new FetchError('The cover art is not an image this app can read (use JPEG, PNG or WebP).');
  if (Number(dims[1]) > MAX_IMAGE_SIDE || Number(dims[2]) > MAX_IMAGE_SIDE) throw new FetchError('The cover art image is too large to process.');
  const conv = await run(
    ctx.config.ffmpegPath,
    ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file', '-i', input, '-frames:v', '1', '-map_metadata', '-1',
      '-vf', `scale=${COVER_SIZE}:${COVER_SIZE}:force_original_aspect_ratio=increase,crop=${COVER_SIZE}:${COVER_SIZE}`, '-q:v', '4', output],
    30_000,
  ).catch(() => null);
  if (!conv || conv.code !== 0) throw new FetchError('The cover art could not be converted.');
  return output;
}

export type CoverResult = { ok: true } | { ok: false; error: string };

/**
 * Fetch the show's cover art from its RSS feed, shrink it to a small square JPEG (which also strips metadata and
 * neutralizes odd files) and keep it in storage. A failure is recorded on the show; the previous cover is kept.
 */
export async function refreshCover(ctx: AppContext, show: Show): Promise<CoverResult> {
  const { repo, storage, config, log } = ctx;
  if (!show.feed_url) return { ok: false, error: 'No RSS feed address is set.' };
  const work = path.join(config.tmpDir, `cover-${show.id}`);
  try {
    const output = await fetchCover(ctx, show.feed_url, work);
    await storage.put(coverKey(show.id), output, 'image/jpeg');
    repo.updateShow(show.id, { cover_key: coverKey(show.id), cover_updated_at: new Date().toISOString(), cover_error: null });
    return { ok: true };
  } catch (err) {
    const message = err instanceof FetchError ? err.message : 'The cover art could not be fetched.';
    if (!(err instanceof FetchError)) log.warn({ err, showId: show.id }, 'cover art fetch failed');
    repo.updateShow(show.id, { cover_error: message });
    return { ok: false, error: message };
  } finally {
    await Promise.all([`${work}.src`, `${work}.jpg`].map((f) => fs.promises.rm(f, { force: true })));
  }
}

/** Forget the cover (the feed address was removed). */
export async function clearCover(ctx: AppContext, show: Show): Promise<void> {
  if (show.cover_key) await ctx.storage.delete(show.cover_key).catch((err) => ctx.log.warn({ err, showId: show.id }, 'could not remove the cover art'));
  ctx.repo.updateShow(show.id, { cover_key: null, cover_updated_at: null, cover_error: null });
}
