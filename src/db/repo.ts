import type { DB } from './index.js';
import { randomToken, slugify, ulid } from '../lib/util.js';

export interface Show {
  id: string;
  name: string;
  slug: string;
  site_key: string;
  allowed_origins: string; // JSON array of origins
  notify_email: string | null;
  max_seconds: number;
  ask_email: number;
  consent_text: string;
  button_label: string;
  accent_color: string;
  prompt_text: string;
  thanks_text: string;
  retain_original: number;
  /** 1 = transcribe new messages (needs TRANSCRIPTION=whisper on the server). */
  transcribe: number;
  turnstile_site_key: string | null;
  turnstile_secret_key: string | null; // encrypted
  created_at: string;
}

export interface Message {
  id: string;
  show_id: string;
  status: 'processing' | 'ready' | 'failed';
  starred: number;
  archived: number;
  sender_name: string;
  sender_email: string | null;
  consent_given: number;
  duration_seconds: number | null;
  mp3_key: string | null;
  original_key: string | null;
  size_bytes: number | null;
  original_mime: string | null;
  ip_hash: string | null;
  user_agent: string | null;
  transcript: string | null;
  /** null = never queued, pending = waiting or running, done, failed */
  transcript_status: 'pending' | 'done' | 'failed' | null;
  transcript_error: string | null;
  transcript_seconds: number | null;
  notes: string | null;
  error: string | null;
  /** Why the email alert could not be sent, or null if it was sent (or none is configured). */
  email_error: string | null;
  read_at: string | null;
  created_at: string;
  deleted_at: string | null;
}

/** Slugs that would clash with fixed paths under /shows. */
export const RESERVED_SLUGS = ['new'];

export type MessageWithShow = Message & { show_name: string; show_slug: string };

export type InboxFilter = 'inbox' | 'new' | 'starred' | 'archived' | 'failed' | 'all';
export const INBOX_FILTERS: InboxFilter[] = ['inbox', 'new', 'starred', 'archived', 'failed', 'all'];

export const nowIso = (): string => new Date().toISOString();

/**
 * Turn what someone typed into a safe FTS5 query: every word is quoted (so punctuation and operators
 * like AND, OR, NEAR, - or * are plain text) and matches as a prefix. Returns null for an empty search.
 */
export function ftsQuery(input: string): string | null {
  const words = input
    .split(/\s+/)
    .map((w) => w.replace(/"/g, ''))
    .filter((w) => /[\p{L}\p{N}]/u.test(w))
    .slice(0, 12);
  return words.length ? words.map((w) => `"${w}"*`).join(' ') : null;
}

export function showOrigins(show: Pick<Show, 'allowed_origins'>): string[] {
  try {
    const parsed: unknown = JSON.parse(show.allowed_origins);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Normalize user-entered origins to "https://example.com" form. Returns null for invalid entries. */
export function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function parseOriginList(text: string): { origins: string[]; invalid: string[] } {
  const origins: string[] = [];
  const invalid: string[] = [];
  for (const part of text.split(/[\s,]+/)) {
    if (!part) continue;
    const origin = normalizeOrigin(part);
    if (!origin) invalid.push(part);
    else if (!origins.includes(origin)) origins.push(origin);
  }
  return { origins, invalid };
}

export class Repo {
  constructor(readonly db: DB) {}

  // ---- shows ----
  getShowByKey(siteKey: string): Show | undefined {
    return this.db.prepare('SELECT * FROM shows WHERE site_key = ?').get(siteKey) as Show | undefined;
  }
  getShow(id: string): Show | undefined {
    return this.db.prepare('SELECT * FROM shows WHERE id = ?').get(id) as Show | undefined;
  }
  getShowBySlug(slug: string): Show | undefined {
    return this.db.prepare('SELECT * FROM shows WHERE slug = ?').get(slug) as Show | undefined;
  }
  listShows(): Show[] {
    return this.db.prepare('SELECT * FROM shows ORDER BY name COLLATE NOCASE').all() as Show[];
  }

  uniqueSlug(name: string): string {
    let base = slugify(name);
    if (RESERVED_SLUGS.includes(base)) base = `${base}-show`;
    let slug = base;
    for (let i = 2; this.getShowBySlug(slug); i++) slug = `${base}-${i}`;
    return slug;
  }

  createShow(input: Partial<Omit<Show, 'id' | 'site_key' | 'created_at'>> & { name: string }): Show {
    const show: Show = {
      id: ulid(),
      name: input.name,
      slug: input.slug ?? this.uniqueSlug(input.name),
      site_key: `pk_${randomToken(16)}`,
      allowed_origins: input.allowed_origins ?? '[]',
      notify_email: input.notify_email ?? null,
      max_seconds: input.max_seconds ?? 180,
      ask_email: input.ask_email ?? 1,
      consent_text: input.consent_text ?? 'By sending this message you agree that it may be played on the show.',
      button_label: input.button_label ?? 'Leave a voicemail',
      accent_color: input.accent_color ?? '#21649E',
      prompt_text: input.prompt_text ?? 'Record a message for the show.',
      thanks_text: input.thanks_text ?? 'Thank you! Your message was sent.',
      retain_original: input.retain_original ?? 0,
      transcribe: input.transcribe ?? 0,
      turnstile_site_key: input.turnstile_site_key ?? null,
      turnstile_secret_key: input.turnstile_secret_key ?? null,
      created_at: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO shows (id, name, slug, site_key, allowed_origins, notify_email, max_seconds, ask_email, consent_text,
          button_label, accent_color, prompt_text, thanks_text, retain_original, transcribe, turnstile_site_key, turnstile_secret_key, created_at)
         VALUES (@id, @name, @slug, @site_key, @allowed_origins, @notify_email, @max_seconds, @ask_email, @consent_text,
          @button_label, @accent_color, @prompt_text, @thanks_text, @retain_original, @transcribe, @turnstile_site_key, @turnstile_secret_key, @created_at)`,
      )
      .run(show);
    return show;
  }

  updateShow(id: string, fields: Partial<Omit<Show, 'id' | 'created_at'>>): void {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE shows SET ${sets} WHERE id = @__id`).run({ ...fields, __id: id });
  }

  rotateSiteKey(id: string): string {
    const key = `pk_${randomToken(16)}`;
    this.updateShow(id, { site_key: key });
    return key;
  }

  // ---- messages ----
  insertMessage(m: Pick<Message, 'id' | 'show_id' | 'sender_name' | 'sender_email' | 'consent_given' | 'original_mime' | 'ip_hash' | 'user_agent'>): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, show_id, status, sender_name, sender_email, consent_given, original_mime, ip_hash, user_agent, created_at)
         VALUES (@id, @show_id, 'processing', @sender_name, @sender_email, @consent_given, @original_mime, @ip_hash, @user_agent, @created_at)`,
      )
      .run({ ...m, created_at: nowIso() });
  }

  getMessage(id: string): MessageWithShow | undefined {
    return this.db
      .prepare(
        `SELECT m.*, s.name AS show_name, s.slug AS show_slug FROM messages m JOIN shows s ON s.id = m.show_id
         WHERE m.id = ? AND m.deleted_at IS NULL`,
      )
      .get(id) as MessageWithShow | undefined;
  }

  updateMessage(id: string, fields: Partial<Omit<Message, 'id' | 'show_id' | 'created_at'>>): void {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE messages SET ${sets} WHERE id = @__id`).run({ ...fields, __id: id });
  }

  private filterSql(filter: InboxFilter, showId?: string, search?: string): { where: string; params: Record<string, unknown> } {
    const clauses = ['m.deleted_at IS NULL'];
    const params: Record<string, unknown> = {};
    const fts = search ? ftsQuery(search) : null;
    if (fts) {
      clauses.push('m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH @fts)');
      params.fts = fts;
    }
    if (showId) {
      clauses.push('m.show_id = @show_id');
      params.show_id = showId;
    }
    switch (filter) {
      case 'inbox':
        clauses.push('m.archived = 0');
        break;
      case 'new':
        clauses.push('m.archived = 0', "m.status = 'ready'", 'm.read_at IS NULL');
        break;
      case 'starred':
        clauses.push('m.starred = 1');
        break;
      case 'archived':
        clauses.push('m.archived = 1');
        break;
      case 'failed':
        clauses.push("m.status = 'failed'");
        break;
      case 'all':
        break;
    }
    return { where: clauses.join(' AND '), params };
  }

  listMessages(filter: InboxFilter, opts: { showId?: string; limit: number; offset: number; search?: string }): MessageWithShow[] {
    const { where, params } = this.filterSql(filter, opts.showId, opts.search);
    return this.db
      .prepare(
        `SELECT m.*, s.name AS show_name, s.slug AS show_slug FROM messages m JOIN shows s ON s.id = m.show_id
         WHERE ${where} ORDER BY m.created_at DESC LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: opts.limit, offset: opts.offset }) as MessageWithShow[];
  }

  countMessages(filter: InboxFilter, showId?: string, search?: string): number {
    const { where, params } = this.filterSql(filter, showId, search);
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE ${where}`).get(params) as { n: number };
    return row.n;
  }

  /** Matching text from the transcript for each message id, with matches wrapped in \u0001 and \u0002. */
  transcriptSnippets(search: string, ids: string[]): Map<string, string> {
    const out = new Map<string, string>();
    const fts = ftsQuery(search);
    if (!fts || ids.length === 0) return out;
    const marks = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT m.id AS id, snippet(messages_fts, 3, char(1), char(2), '…', 16) AS snip
         FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
         WHERE messages_fts MATCH ? AND m.id IN (${marks})`,
      )
      .all(fts, ...ids) as { id: string; snip: string | null }[];
    for (const r of rows) if (r.snip && r.snip.includes('\u0001')) out.set(r.id, r.snip);
    return out;
  }

  countSinceForShow(showId: string, sinceIso: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE show_id = ? AND created_at >= ?').get(showId, sinceIso) as { n: number };
    return row.n;
  }

  countRecentByIp(ipHash: string, sinceIso: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE ip_hash = ? AND created_at >= ?')
      .get(ipHash, sinceIso) as { n: number };
    return row.n;
  }

  listProcessing(): Message[] {
    return this.db.prepare("SELECT * FROM messages WHERE status = 'processing' AND deleted_at IS NULL ORDER BY created_at").all() as Message[];
  }

  /** Messages whose transcription was queued but not finished (for example the app restarted). */
  listPendingTranscripts(): Message[] {
    return this.db.prepare("SELECT * FROM messages WHERE transcript_status = 'pending' AND status = 'ready' AND deleted_at IS NULL ORDER BY created_at").all() as Message[];
  }

  /** Messages the admin deleted whose audio and record have not been removed yet. */
  listDeleted(): Message[] {
    return this.db.prepare('SELECT * FROM messages WHERE deleted_at IS NOT NULL').all() as Message[];
  }

  /** Messages older than the cutoff that are due for automatic deletion. Starred messages are kept. */
  listExpired(beforeIso: string): Message[] {
    return this.db
      .prepare("SELECT * FROM messages WHERE created_at < ? AND starred = 0 AND deleted_at IS NULL AND status != 'processing'")
      .all(beforeIso) as Message[];
  }

  purgeMessage(id: string): void {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  }

  // ---- admin + sessions ----
  getAdmin(): { id: number; email: string; password_hash: string } | undefined {
    return this.db.prepare('SELECT id, email, password_hash FROM admin WHERE id = 1').get() as
      | { id: number; email: string; password_hash: string }
      | undefined;
  }

  upsertAdmin(email: string, passwordHash: string): void {
    this.db
      .prepare(
        `INSERT INTO admin (id, email, password_hash, created_at) VALUES (1, @email, @hash, @at)
         ON CONFLICT(id) DO UPDATE SET email = @email, password_hash = @hash`,
      )
      .run({ email, hash: passwordHash, at: nowIso() });
  }

  createSession(tokenHash: string, adminId: number, ttlMs: number): void {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO sessions (token_hash, admin_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash, adminId, new Date(now).toISOString(), new Date(now + ttlMs).toISOString());
  }

  getSession(tokenHash: string): { admin_id: number; expires_at: string } | undefined {
    return this.db.prepare('SELECT admin_id, expires_at FROM sessions WHERE token_hash = ?').get(tokenHash) as
      | { admin_id: number; expires_at: string }
      | undefined;
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  /** Signs out every session except the one given (used after a password change). */
  deleteOtherSessions(keepTokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash != ?').run(keepTokenHash);
  }

  deleteExpiredSessions(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
  }
}
