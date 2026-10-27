import { fireWebhooks, messagePayload } from './webhook.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { AppContext } from './context.js';
import { toWav16k } from './media/convert.js';

const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

export const transcriptionAvailable = (ctx: AppContext): boolean => ctx.config.transcription === 'whisper';

export function modelPath(ctx: AppContext): string {
  return path.join(ctx.config.whisperModelDir, `ggml-${ctx.config.whisperModel}.bin`);
}

let modelDownload: Promise<void> | null = null;

/** Download the whisper model on first use. The file lives in the data volume, so it is fetched once. */
export function ensureModel(ctx: AppContext): Promise<void> {
  const file = modelPath(ctx);
  if (fs.existsSync(file)) return Promise.resolve();
  modelDownload ??= (async () => {
    ctx.log.info({ model: ctx.config.whisperModel }, 'downloading the whisper model (one time)');
    await fs.promises.mkdir(ctx.config.whisperModelDir, { recursive: true });
    const url = `${MODEL_BASE_URL}/ggml-${ctx.config.whisperModel}.bin`;
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Could not download the whisper model (${url} answered ${res.status}).`);
    const tmp = `${file}.part`;
    try {
      await pipeline(res.body as unknown as NodeJS.ReadableStream, fs.createWriteStream(tmp));
      await fs.promises.rename(tmp, file);
    } finally {
      await fs.promises.rm(tmp, { force: true });
    }
    ctx.log.info({ model: ctx.config.whisperModel }, 'whisper model ready');
  })().finally(() => {
    modelDownload = null;
  });
  return modelDownload;
}

/** Whisper marks silence and noise with bracketed tags; they are not speech. */
export function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[[^\]]{0,40}\]|\((?:silence|music|applause|laughter|noise)[^)]*\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function runWhisper(ctx: AppContext, wav: string): Promise<string> {
  const { config } = ctx;
  const args = ['-m', modelPath(ctx), '-f', wav, '-l', config.whisperLanguage, '-t', String(config.whisperThreads), '-nt', '-np'];
  return new Promise((resolve, reject) => {
    const child = spawn(config.whisperBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    // Lower priority so the web app and conversions stay responsive while this runs.
    try {
      if (child.pid) os.setPriority(child.pid, 10);
    } catch {
      /* not fatal */
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < 1_000_000) stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 20_000) stderr += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Transcription timed out after ${config.transcribeTimeoutSec} seconds.`));
    }, config.transcribeTimeoutSec * 1000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not start ${config.whisperBin}: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`whisper exited with code ${code}: ${stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300)}`));
    });
  });
}

/** Transcribe one ready message and store the text. Never throws; the outcome is recorded on the message. */
export async function transcribeMessage(ctx: AppContext, id: string): Promise<void> {
  const { repo, storage, config, log } = ctx;
  const msg = repo.getMessage(id);
  if (!msg || msg.status !== 'ready' || !msg.mp3_key || msg.transcript_status !== 'pending') return;
  const started = Date.now();
  const mp3 = path.join(config.tmpDir, `${id}.tr.mp3`);
  const wav = path.join(config.tmpDir, `${id}.tr.wav`);
  try {
    await ensureModel(ctx);
    await pipeline(await storage.getStream(msg.mp3_key), fs.createWriteStream(mp3));
    await toWav16k(mp3, wav, { ffmpegPath: config.ffmpegPath });
    const text = cleanTranscript(await runWhisper(ctx, wav));
    // The message may have been deleted while this ran.
    if (!repo.getMessage(id)) return;
    repo.updateMessage(id, {
      transcript: text,
      transcript_status: 'done',
      transcript_error: null,
      transcript_seconds: Math.round((Date.now() - started) / 100) / 10,
    });
    fireWebhooks(ctx, msg.show_id, 'message.transcribed', messagePayload(ctx, 'message.transcribed', repo.getMessage(id)!));
    log.info({ messageId: id, seconds: (Date.now() - started) / 1000, audioSeconds: msg.duration_seconds }, 'transcribed message');
  } catch (err) {
    log.warn({ err, messageId: id }, 'transcription failed');
    if (repo.getMessage(id)) {
      const reason = err instanceof Error ? err.message : String(err);
      repo.updateMessage(id, { transcript_status: 'failed', transcript_error: reason.replace(/\s+/g, ' ').slice(0, 300) });
    }
  } finally {
    await fs.promises.rm(mp3, { force: true });
    await fs.promises.rm(wav, { force: true });
  }
}

/** Mark a message for transcription and put it in line. Returns false when transcription is off. */
export function queueTranscription(ctx: AppContext, id: string): boolean {
  if (!transcriptionAvailable(ctx)) return false;
  const msg = ctx.repo.getMessage(id);
  if (!msg || msg.status !== 'ready' || !msg.mp3_key) return false;
  ctx.repo.updateMessage(id, { transcript_status: 'pending', transcript_error: null });
  ctx.transcribeQueue.add(() => transcribeMessage(ctx, id));
  return true;
}

/** Called after a message is processed: transcribe it if its show has the option on. */
export function maybeTranscribe(ctx: AppContext, id: string): void {
  const msg = ctx.repo.getMessage(id);
  if (!msg) return;
  if (ctx.repo.getShow(msg.show_id)?.transcribe === 1) queueTranscription(ctx, id);
}

/** On startup, requeue transcriptions that were waiting or running when the app stopped. */
export function recoverTranscriptions(ctx: AppContext): number {
  if (!transcriptionAvailable(ctx)) return 0;
  const pending = ctx.repo.listPendingTranscripts();
  for (const m of pending) ctx.transcribeQueue.add(() => transcribeMessage(ctx, m.id));
  return pending.length;
}
