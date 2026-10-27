import { spawn } from 'node:child_process';

export class MediaError extends Error {
  constructor(
    readonly code: 'not_audio' | 'unsupported_format' | 'too_long' | 'too_short' | 'convert_failed' | 'probe_failed',
    message: string,
  ) {
    super(message);
    this.name = 'MediaError';
  }
}

export interface ProbeResult {
  hasAudio: boolean;
  formatNames: string[];
  durationSeconds: number | null;
}

/**
 * Container formats browsers produce with MediaRecorder, plus common upload formats.
 * Anything else (HLS playlists, concat lists, image sequences, ...) is rejected before conversion.
 */
const ALLOWED_FORMATS = new Set([
  'matroska', 'webm', 'ogg', 'mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'mp3', 'wav', 'flac', 'aac', 'aiff', 'caf', 'amr',
]);

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function run(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const cap = 1024 * 1024;
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < cap) stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < cap) stderr += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

export async function probe(file: string, ffprobePath = 'ffprobe', timeoutMs = 20_000): Promise<ProbeResult> {
  let res: RunResult;
  try {
    res = await run(
      ffprobePath,
      ['-v', 'error', '-protocol_whitelist', 'file', '-print_format', 'json', '-show_format', '-show_streams', file],
      timeoutMs,
    );
  } catch (err) {
    throw new MediaError('probe_failed', (err as Error).message);
  }
  if (res.code !== 0) throw new MediaError('not_audio', 'The file could not be read as audio.');
  let json: { format?: { format_name?: string; duration?: string }; streams?: { codec_type?: string; duration?: string }[] };
  try {
    json = JSON.parse(res.stdout);
  } catch {
    throw new MediaError('probe_failed', 'Unexpected ffprobe output.');
  }
  const formatNames = (json.format?.format_name ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const hasAudio = (json.streams ?? []).some((s) => s.codec_type === 'audio');
  const durations = [json.format?.duration, ...(json.streams ?? []).filter((s) => s.codec_type === 'audio').map((s) => s.duration)]
    .map((d) => (d === undefined ? NaN : Number(d)))
    .filter((d) => Number.isFinite(d) && d > 0);
  return { hasAudio, formatNames, durationSeconds: durations.length ? Math.max(...durations) : null };
}

export function assertAllowedFormat(result: ProbeResult): void {
  if (!result.hasAudio) throw new MediaError('not_audio', 'The file does not contain an audio track.');
  if (!result.formatNames.some((f) => ALLOWED_FORMATS.has(f))) {
    throw new MediaError('unsupported_format', `Unsupported file format (${result.formatNames.join(', ') || 'unknown'}).`);
  }
}

export interface ConvertOptions {
  ffmpegPath?: string;
  bitrateKbps: number;
  /** Output is cut off after this many seconds, so oversized input cannot run away. */
  maxSeconds: number;
  timeoutMs?: number;
  /** Even out the volume (EBU R128, -16 LUFS, which suits spoken word). */
  normalize?: boolean;
}

/** Convert any supported audio file to mono 44.1 kHz MP3 with metadata stripped. */
export async function toMp3(input: string, output: string, opts: ConvertOptions): Promise<void> {
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-protocol_whitelist', 'file',
    '-i', input,
    '-t', String(opts.maxSeconds),
    '-vn', '-map', '0:a:0', '-map_metadata', '-1',
    ...(opts.normalize ? ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11'] : []),
    '-ac', '1', '-ar', '44100',
    '-codec:a', 'libmp3lame', '-b:a', `${opts.bitrateKbps}k`,
    output,
  ];
  let res: RunResult;
  try {
    res = await run(opts.ffmpegPath ?? 'ffmpeg', args, opts.timeoutMs ?? 120_000);
  } catch (err) {
    throw new MediaError('convert_failed', (err as Error).message);
  }
  if (res.code !== 0) throw new MediaError('convert_failed', res.stderr.trim().slice(0, 500) || 'ffmpeg failed');
}

/** Convert any supported audio file to 16 kHz mono WAV, the input format whisper.cpp expects. */
export async function toWav16k(input: string, output: string, opts: { ffmpegPath?: string; timeoutMs?: number } = {}): Promise<void> {
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-protocol_whitelist', 'file',
    '-i', input, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output,
  ];
  let res: RunResult;
  try {
    res = await run(opts.ffmpegPath ?? 'ffmpeg', args, opts.timeoutMs ?? 120_000);
  } catch (err) {
    throw new MediaError('convert_failed', (err as Error).message);
  }
  if (res.code !== 0) throw new MediaError('convert_failed', res.stderr.trim().slice(0, 500) || 'ffmpeg failed');
}
