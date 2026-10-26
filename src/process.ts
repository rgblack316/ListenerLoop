import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from './context.js';
import { buildNewMessageEmail } from './mail/index.js';
import { assertAllowedFormat, MediaError, probe, toMp3 } from './media/convert.js';
import { messageKey } from './storage/index.js';

/** Seconds of slack over the show's limit; the widget stops recording at the limit itself. */
const DURATION_SLACK = 2;
const MIN_SECONDS = 0.3;

export function uploadPath(ctx: AppContext, id: string): string {
  return path.join(ctx.config.tmpDir, `${id}.upload`);
}

function userFacingError(err: unknown): string {
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
    repo.updateMessage(id, {
      status: 'ready',
      mp3_key: mp3Key,
      original_key: originalKey,
      duration_seconds: Math.round(duration * 10) / 10,
      size_bytes: size,
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
  if (done?.status === 'ready') await notifyNewMessage(ctx, id);
}

export async function notifyNewMessage(ctx: AppContext, id: string): Promise<void> {
  const { repo, mailer, config, log } = ctx;
  const msg = repo.getMessage(id);
  if (!msg) return;
  const show = repo.getShow(msg.show_id);
  const to = show?.notify_email || repo.getAdmin()?.email;
  if (!mailer) {
    log.info({ messageId: id }, 'no mail provider configured; skipping email alert');
    return;
  }
  if (!to) {
    log.info({ messageId: id }, 'no notification address; skipping email alert');
    return;
  }
  try {
    await mailer.send(
      buildNewMessageEmail({
        to,
        showName: msg.show_name,
        senderName: msg.sender_name,
        senderEmail: msg.sender_email,
        durationSeconds: msg.duration_seconds,
        adminUrl: `${config.appUrl}/admin/messages/${msg.id}`,
      }),
    );
  } catch (err) {
    // An email failure never affects the submission; it is logged for the admin.
    log.error({ err, messageId: id }, 'email alert failed');
  }
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
