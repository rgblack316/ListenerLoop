import { PassThrough, type Readable } from 'node:stream';
import yazl from 'yazl';
import type { AppContext } from './context.js';
import type { MessageWithShow } from './db/repo.js';

/** The most messages one download may contain. Keeps a request from running for ages. */
export const MAX_ZIP_MESSAGES = 100;

const part = (s: string, max = 40): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'message';

/** One CSV cell. Cells that start with = + - @ are prefixed so a spreadsheet never treats them as formulas. */
export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function zipEntryName(m: MessageWithShow): string {
  return `${m.created_at.slice(0, 10)}_${part(m.sender_name)}_${m.id.slice(-6).toLowerCase()}`;
}

/**
 * A zip stream with each message's MP3 (plus a transcript .txt where there is one) and a messages.csv index.
 * Audio is fetched one file at a time, so memory stays small however many messages are included.
 * MP3s are already compressed, so they are stored as they are.
 */
export function buildZip(ctx: AppContext, messages: MessageWithShow[]): Readable {
  const zip = new yazl.ZipFile();
  const out = zip.outputStream as unknown as Readable;
  const header = ['file', 'received_utc', 'show', 'name', 'email', 'seconds', 'starred', 'notes', 'transcript'];
  const rows = [header.join(',')];
  for (const m of messages) {
    rows.push(
      [`${zipEntryName(m)}.mp3`, m.created_at, m.show_name, m.sender_name, m.sender_email, m.duration_seconds, m.starred ? 'yes' : '', m.notes, m.transcript]
        .map(csvCell)
        .join(','),
    );
  }
  // A byte-order mark makes Excel read the file as UTF-8.
  zip.addBuffer(Buffer.from(`﻿${rows.join('\r\n')}\r\n`, 'utf8'), 'messages.csv', { compress: true });

  const gates: PassThrough[] = [];
  for (const m of messages) {
    const base = zipEntryName(m);
    if (m.transcript) zip.addBuffer(Buffer.from(`${m.sender_name} - ${m.show_name} - ${m.created_at}\n\n${m.transcript}\n`, 'utf8'), `${base}.txt`, { compress: true });
    const gate = new PassThrough();
    gates.push(gate);
    zip.addReadStream(gate, `${base}.mp3`, { compress: false });
  }
  zip.end();

  // Feed each file in turn: the zip only reads an entry once the one before it is finished.
  void (async () => {
    for (const [i, m] of messages.entries()) {
      const gate = gates[i]!;
      try {
        const src = await ctx.storage.getStream(m.mp3_key!);
        await new Promise<void>((resolve, reject) => {
          src.on('error', reject);
          gate.on('error', reject);
          gate.on('finish', resolve);
          src.pipe(gate);
        });
      } catch (err) {
        ctx.log.error({ err, messageId: m.id }, 'zip download failed');
        out.destroy(err instanceof Error ? err : new Error(String(err)));
        for (const g of gates.slice(i)) g.destroy();
        return;
      }
    }
  })();
  return out;
}
