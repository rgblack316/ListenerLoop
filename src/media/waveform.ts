import { spawn } from 'node:child_process';

export const WAVEFORM_BARS = 120;

/**
 * Peak heights (0-100) for a simple waveform, one per bar. The file is decoded to 8 kHz mono and each
 * bar takes the loudest sample in its slice. Heights are relative to the loudest bar so quiet messages
 * are still readable. Returns [] when there is no audio.
 */
export function computePeaks(file: string, ffmpegPath = 'ffmpeg', bars = WAVEFORM_BARS, timeoutMs = 60_000): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file', '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const cap = 8000 * 2 * 60 * 15; // 15 minutes; far beyond any allowed message
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      if (size < cap) {
        chunks.push(d);
        size += d.length;
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 2000) stderr += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('waveform timed out'));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || `ffmpeg exited with ${code}`));
      const buf = Buffer.concat(chunks);
      const samples = Math.floor(buf.length / 2);
      if (samples === 0) return resolve([]);
      const n = Math.min(bars, samples);
      const peaks = new Array<number>(n).fill(0);
      for (let i = 0; i < n; i++) {
        const from = Math.floor((i * samples) / n);
        const to = Math.max(from + 1, Math.floor(((i + 1) * samples) / n));
        let max = 0;
        for (let s = from; s < to; s++) {
          const v = Math.abs(buf.readInt16LE(s * 2));
          if (v > max) max = v;
        }
        peaks[i] = max;
      }
      const top = Math.max(...peaks, 1);
      resolve(peaks.map((p) => Math.max(3, Math.round((p / top) * 100))));
    });
  });
}
