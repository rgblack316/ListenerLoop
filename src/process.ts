import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { AppContext } from './context.js';
import { buildNewMessageEmail } from './mail/index.js';
import { assertAllowedFormat, MediaError, probe, toMp3 } from './media/convert.js';
import { computePeaks } from './media/waveform.js';
import { messageKey } from './storage/index.js';
import { maybeTranscribe } from './transcribe.js';

/** Seconds of slack over the show's limit; the widget stops recording at the limit itself. */
export const DURATION_SLACK = 2;
const MIN_SECONDS = 0.3;

export function uploadPath(ctx: AppContext, id: string): string {
  return path.join(ctx.config.tmpDir, `${id}.upload`);
}

export function userFacingError(err: unknown): string {
  if (err instanceof MediaError) {
    switch (err.code) {
      case 'too_long':
        return 'The recording is longer than this show allows.';
      case 'too_short':
        return 'The recording is too short.';
      case 'not_audio':
      case 'unsupported_format':
        return err.message;
      default:
        return 'The recording could not be converted.';
    }
  }
  return 'Processing failed unexpectedly.';
}

/**
 * Validate and convert one uploaded recording, store it, mark it ready and send the alert.
 * On failure the original is kept in storage so it can be inspected or retried from admin.
 */
export async function processMessage(ctx: AppContext, id: string): Promise<void> {
  const { repo, storage, config, log } = ctx;
  const msg = repo.getMessage(id);
  if (!msg || msg.status !== 'processing') return;
  const show = repo.getShow(msg.show_id);
  if (!show) return;

  const input = uploadPath(ctx, id);
  const output = path.join(config.tmpDir, `${id}.mp3`);
  const keepOriginal = config.keepOriginals || show.retain_original === 1;

  try {
    if (!fs.existsSync(input)) throw new Error('Upload file is missing');

    const info = await probe(input, config.ffprobePath);
    assertAllowedFormat(info);
    // MediaRecorder WebM files carry no duration header, so the real length is measured after conversion.
    if (info.durationSeconds !== null && info.durationSeconds > show.max_seconds + DURATION_SLACK) {
      throw new MediaError('too_long', 'Recording too long');
    }

    await toMp3(input, output, {
      ffmpegPath: config.ffmpegPath,
      bitrateKbps: config.mp3BitrateKbps,
      maxSeconds: show.max_seconds + DURATION_SLACK + 3,
      normalize: show.normalize_loudness === 1,
      denoise: show.noise_reduction,
      rnnoiseModel: fs.existsSync(config.rnnoiseModel) ? config.rnnoiseModel : undefined,
    });
    const outInfo = await probe(output, config.ffprobePath);
    const duration = outInfo.durationSeconds ?? info.durationSeconds ?? 0;
    if (duration < MIN_SECONDS) throw new MediaError('too_short', 'Recording too short');
    if (duration > show.max_seconds + DURATION_SLACK) throw new MediaError('too_long', 'Recording too long');

    const mp3Key = messageKey(show.id, msg.created_at, id, 'mp3');
    await storage.put(mp3Key, output, 'audio/mpeg');
    let originalKey: string | null = null;
    if (keepOriginal) {
      originalKey = messageKey(show.id, msg.created_at, id, 'orig');
      await storage.put(originalKey, input, 'application/octet-stream');
    }
    const { size } = await fs.promises.stat(output);
    // A waveform is a nicety; if it cannot be drawn the message is still fine.
    const peaks = await computePeaks(output, config.ffmpegPath).catch(() => []);
    // A retried message may still have the original saved when it failed; drop it unless originals are kept.
    if (msg.original_key && !originalKey) {
      await storage.delete(msg.original_key).catch((e) => log.warn({ err: e, messageId: id }, 'could not remove the saved original'));
    }
    repo.updateMessage(id, {
      status: 'ready',
      mp3_key: mp3Key,
      original_key: originalKey,
      duration_seconds: Math.round(duration * 10) / 10,
      size_bytes: size,
      waveform: JSON.stringify(peaks),
      error: null,
    });
  } catch (err) {
    log.warn({ err, messageId: id }, 'message processing failed');
    let originalKey: string | null = null;
    try {
      if (fs.existsSync(input)) {
        originalKey = messageKey(show.id, msg.created_at, id, 'orig');
        await storage.put(originalKey, input, 'application/octet-stream');
      }
    } catch (storeErr) {
      log.error({ err: storeErr, messageId: id }, 'could not keep original of failed message');
      originalKey = null;
    }
    repo.updateMessage(id, { status: 'failed', error: userFacingError(err), original_key: originalKey });
  } finally {
    await fs.promises.rm(input, { force: true });
    await fs.promises.rm(output, { force: true });
  }

  const done = repo.getMessage(id);
  if (done?.status === 'ready') {
    await notifyNewMessage(ctx, id);
    // After the alert, so a transcript never delays it.
    maybeTranscribe(ctx, id);
  }
}

export type AlertResult = 'sent' | 'failed' | 'skipped';

/** Sends the new-message email and records whether it worked, so a failure is visible in the admin. */
export async function notifyNewMessage(ctx: AppContext, id: string): Promise<AlertResult> {
  const { repo, mailer, config, log } = ctx;
  const msg = repo.getMessage(id);
  if (!msg) return 'skipped';
  const show = repo.getShow(msg.show_id);
  const to = show?.notify_email || repo.getAdmin()?.email;
  if (!mailer) {
    log.info({ messageId: id }, 'no mail provider configured; skipping email alert');
    return 'skipped';
  }
  if (!to) {
    log.info({ messageId: id }, 'no notification address; skipping email alert');
    return 'skipped';
  }
  try {
    await mailer.send(
      buildNewMessageEmail({
        to,
        showName: msg.show_name,
        senderName: msg.sender_name,
        senderEmail: msg.sender_email,
        durationSeconds: msg.duration_seconds,
        adminUrl: `${config.appUrl}/shows/${msg.show_slug}/messages/${msg.id}`,
      }),
    );
    if (msg.email_error) repo.updateMessage(id, { email_error: null });
    return 'sent';
  } catch (err) {
    // An email failure never affects the submission; it is logged and shown on the message in the admin.
    log.error({ err, messageId: id }, 'email alert failed');
    const reason = err instanceof Error ? err.message : String(err);
    repo.updateMessage(id, { email_error: reason.replace(/\s+/g, ' ').slice(0, 300) || 'Unknown error' });
    return 'failed';
  }
}

export type RetryResult = 'queued' | 'not_failed' | 'no_original' | 'storage_error';

/** Puts a failed message back in the queue using the original recording saved when it failed. */
export async function retryMessage(
  ctx: AppContext,
  m: { id: string; status: string; original_key: string | null },
): Promise<RetryResult> {
  if (m.status !== 'failed') return 'not_failed';
  if (!m.original_key) return 'no_original';
  const input = uploadPath(ctx, m.id);
  try {
    await pipeline(await ctx.storage.getStream(m.original_key), fs.createWriteStream(input, { flags: 'w' }));
  } catch (err) {
    ctx.log.error({ err, messageId: m.id }, 'could not fetch the saved original for a retry');
    await fs.promises.rm(input, { force: true });
    return 'storage_error';
  }
  ctx.repo.updateMessage(m.id, { status: 'processing', error: null });
  ctx.queue.add(() => processMessage(ctx, m.id));
  return 'queued';
}

/** On startup, requeue uploads that were mid-processing when the app stopped. */
export function recoverInterrupted(ctx: AppContext): number {
  let requeued = 0;
  for (const m of ctx.repo.listProcessing()) {
    if (fs.existsSync(uploadPath(ctx, m.id))) {
      ctx.queue.add(() => processMessage(ctx, m.id));
      requeued++;
    } else {
      ctx.repo.updateMessage(m.id, { status: 'failed', error: 'Upload was interrupted before processing finished.' });
    }
  }
  return requeued;
}

/**
 * Permanently removes one deleted message: its audio (MP3 and original), any leftover upload,
 * and the database row, which also erases the sender's name and email. If storage cannot be
 * reached the row is kept, so the next sweep retries.
 */
export async function purgeMessage(ctx: AppContext, m: { id: string; mp3_key: string | null; original_key: string | null }): Promise<boolean> {
  try {
    for (const key of [m.mp3_key, m.original_key]) if (key) await ctx.storage.delete(key);
    await fs.promises.rm(uploadPath(ctx, m.id), { force: true });
    ctx.repo.purgeMessage(m.id);
    return true;
  } catch (err) {
    ctx.log.error({ err, messageId: m.id }, 'could not remove a deleted message from storage; will retry');
    return false;
  }
}

/** Removes every message that was deleted in the admin. Returns how many were purged. */
export async function purgeDeleted(ctx: AppContext): Promise<number> {
  let purged = 0;
  for (const m of ctx.repo.listDeleted()) if (await purgeMessage(ctx, m)) purged++;
  return purged;
}

/** Deletes messages older than RETENTION_DAYS (0 = keep forever). Starred messages are kept. */
export async function purgeExpired(ctx: AppContext): Promise<number> {
  const days = ctx.config.retentionDays;
  if (days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  let purged = 0;
  for (const m of ctx.repo.listExpired(cutoff)) if (await purgeMessage(ctx, m)) purged++;
  return purged;
}

/** Draw waveforms for messages that predate the feature. Quick and cheap; runs one message at a time on the main queue. */
export function backfillWaveforms(ctx: AppContext, limit = 500): number {
  const missing = ctx.repo.listMissingWaveforms(limit);
  for (const m of missing) {
    ctx.queue.add(async () => {
      const file = path.join(ctx.config.tmpDir, `${m.id}.wf.mp3`);
      try {
        await pipeline(await ctx.storage.getStream(m.mp3_key!), fs.createWriteStream(file));
        const peaks = await computePeaks(file, ctx.config.ffmpegPath);
        ctx.repo.updateMessage(m.id, { waveform: JSON.stringify(peaks) });
      } catch (err) {
        ctx.log.warn({ err, messageId: m.id }, 'could not draw a waveform');
        ctx.repo.updateMessage(m.id, { waveform: '[]' });
      } finally {
        await fs.promises.rm(file, { force: true });
      }
    });
  }
  return missing.length;
}
