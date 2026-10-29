import type { DB } from './index.js';
import { randomToken, slugify, ulid } from '../lib/util.js';

export type NoiseReduction = 'off' | 'light' | 'strong';
export const NOISE_REDUCTION_LEVELS: NoiseReduction[] = ['off', 'light', 'strong'];

export type Role = 'owner' | 'editor' | 'viewer';
export const ROLES: Role[] = ['owner', 'editor', 'viewer'];

export interface User {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  role: Role;
  disabled_at: string | null;
  totp_secret: string | null;
  totp_enabled: number;
  totp_last_step: number | null;
  created_at: string;
  last_login_at: string | null;
}

export interface Invite {
  id: string;
  token_hash: string;
  kind: 'invite' | 'reset';
  email: string;
  role: Role | null;
  show_ids: string; // JSON array
  user_id: string | null;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

export const WEBHOOK_EVENTS = ['message.ready', 'message.transcribed', 'reply.sent'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface Webhook {
  id: string;
  show_id: string;
  url: string;
  secret: string;
  events: string; // JSON array of WebhookEvent
  enabled: number;
  created_at: string;
}

export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  event: string;
  payload: string;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  next_attempt_at: string | null;
  response_code: number | null;
  error: string | null;
  created_at: string;
  delivered_at: string | null;
}

export interface Backup {
  id: string;
  kind: 'manual' | 'scheduled';
  status: 'running' | 'ok' | 'failed';
  file: string | null;
  size_bytes: number | null;
  includes_audio: number;
  /** 1 when the archive is on this server's disk. */
  has_local: number;
  storage_key: string | null;
  error: string | null;
  started_by: string | null;
  created_at: string;
  finished_at: string | null;
}

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
  /** Short text shown above the embed button; null = the built-in default. */
  embed_blurb: string | null;
  /** 'card' (message, button, branding) or 'button' (the button alone). */
  embed_style: string;
  accent_color: string;
  prompt_text: string;
  thanks_text: string;
  retain_original: number;
  /** 1 = transcribe new messages (needs TRANSCRIPTION=whisper on the server). */
  transcribe: number;
  /** 1 = even out the volume of new messages (EBU R128 loudness normalization) when converting. */
  normalize_loudness: number;
  /** Noise reduction applied when converting: off, light (filters) or strong (neural network). */
  noise_reduction: NoiseReduction;
  /** The podcast's RSS feed, used only to fetch cover art for the dashboard. */
  feed_url: string | null;
  /** Storage key of the 256 px cover image, once fetched. */
  cover_key: string | null;
  cover_updated_at: string | null;
  cover_error: string | null;
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
  /** JSON array of 0-100 peak heights for the player waveform; '[]' = could not be computed; null = not yet. */
  waveform: string | null;
  notes: string | null;
  error: string | null;
  /** Why the email alert could not be sent, or null if it was sent (or none is configured). */
  email_error: string | null;
  read_at: string | null;
  /** When the first reply to the listener was sent. */
  replied_at: string | null;
  created_at: string;
  deleted_at: string | null;
}

/** Slugs that would clash with fixed paths under /shows. */
export const RESERVED_SLUGS = ['new'];

export type MessageWithShow = Message & { show_name: string; show_slug: string; show_email: string | null };

export interface Reply {
  id: string;
  message_id: string;
  to_email: string;
  reply_to: string;
  subject: string;
  body: string;
  status: 'sent' | 'failed';
  error: string | null;
  created_at: string;
}

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
      embed_blurb: input.embed_blurb ?? null,
      embed_style: input.embed_style ?? 'card',
      accent_color: input.accent_color ?? '#21649E',
      prompt_text: input.prompt_text ?? 'Record a message for the show.',
      thanks_text: input.thanks_text ?? 'Thank you! Your message was sent.',
      retain_original: input.retain_original ?? 0,
      transcribe: input.transcribe ?? 0,
      normalize_loudness: input.normalize_loudness ?? 0,
      noise_reduction: input.noise_reduction ?? 'off',
      feed_url: input.feed_url ?? null,
      cover_key: null,
      cover_updated_at: null,
      cover_error: null,
      created_at: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO shows (id, name, slug, site_key, allowed_origins, notify_email, max_seconds, ask_email, consent_text,
          button_label, embed_blurb, embed_style, accent_color, prompt_text, thanks_text, retain_original, transcribe, normalize_loudness, noise_reduction, feed_url, created_at)
         VALUES (@id, @name, @slug, @site_key, @allowed_origins, @notify_email, @max_seconds, @ask_email, @consent_text,
          @button_label, @embed_blurb, @embed_style, @accent_color, @prompt_text, @thanks_text, @retain_original, @transcribe, @normalize_loudness, @noise_reduction, @feed_url, @created_at)`,
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
        `SELECT m.*, s.name AS show_name, s.slug AS show_slug, s.notify_email AS show_email FROM messages m JOIN shows s ON s.id = m.show_id
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

  private filterSql(filter: InboxFilter, showId?: string | string[], search?: string): { where: string; params: Record<string, unknown> } {
    const clauses = ['m.deleted_at IS NULL'];
    const params: Record<string, unknown> = {};
    const fts = search ? ftsQuery(search) : null;
    if (fts) {
      clauses.push('m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH @fts)');
      params.fts = fts;
    }
    if (Array.isArray(showId)) {
      if (!showId.length) clauses.push('0');
      else {
        clauses.push(`m.show_id IN (${showId.map((_, i) => `@sid${i}`).join(', ')})`);
        showId.forEach((id, i) => (params[`sid${i}`] = id));
      }
    } else if (showId) {
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

  listMessages(filter: InboxFilter, opts: { showId?: string | string[]; limit: number; offset: number; search?: string }): MessageWithShow[] {
    const { where, params } = this.filterSql(filter, opts.showId, opts.search);
    return this.db
      .prepare(
        `SELECT m.*, s.name AS show_name, s.slug AS show_slug, s.notify_email AS show_email FROM messages m JOIN shows s ON s.id = m.show_id
         WHERE ${where} ORDER BY m.created_at DESC LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: opts.limit, offset: opts.offset }) as MessageWithShow[];
  }

  countMessages(filter: InboxFilter, showId?: string | string[], search?: string): number {
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

  // ---- replies ----
  insertReply(r: Omit<Reply, 'created_at'>): void {
    this.db
      .prepare('INSERT INTO replies (id, message_id, to_email, reply_to, subject, body, status, error, created_at) VALUES (@id, @message_id, @to_email, @reply_to, @subject, @body, @status, @error, @created_at)')
      .run({ ...r, created_at: nowIso() });
  }

  getReply(id: string): Reply | undefined {
    return this.db.prepare('SELECT * FROM replies WHERE id = ?').get(id) as Reply | undefined;
  }

  updateReply(id: string, fields: Partial<Pick<Reply, 'status' | 'error'>>): void {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    this.db.prepare(`UPDATE replies SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @__id`).run({ ...fields, __id: id });
  }

  listReplies(messageId: string): Reply[] {
    return this.db.prepare('SELECT * FROM replies WHERE message_id = ? ORDER BY created_at').all(messageId) as Reply[];
  }

  countRepliesForMessage(messageId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM replies WHERE message_id = ?').get(messageId) as { n: number }).n;
  }

  countRepliesSince(sinceIso: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM replies WHERE created_at >= ?').get(sinceIso) as { n: number }).n;
  }

  /** Ready messages that have audio but no waveform yet. */
  listMissingWaveforms(limit: number): Message[] {
    return this.db.prepare("SELECT * FROM messages WHERE status = 'ready' AND mp3_key IS NOT NULL AND waveform IS NULL AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?").all(limit) as Message[];
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

  // ---- users + sessions ----
  firstOwner(): User | undefined {
    return this.db.prepare("SELECT * FROM users WHERE role = 'owner' AND disabled_at IS NULL ORDER BY created_at LIMIT 1").get() as User | undefined;
  }

  hasOwner(): boolean {
    return !!this.firstOwner();
  }

  getUser(id: string): User | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
  }

  getUserByEmail(email: string): User | undefined {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim()) as User | undefined;
  }

  listUsers(): User[] {
    return this.db.prepare('SELECT * FROM users ORDER BY created_at').all() as User[];
  }

  countActiveOwners(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND disabled_at IS NULL").get() as { n: number }).n;
  }

  createUser(u: { email: string; name?: string; passwordHash: string; role: Role; showIds?: string[] }): User {
    const id = randomToken(16);
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, u.email.trim(), (u.name ?? '').trim(), u.passwordHash, u.role, nowIso());
      this.setUserShows(id, u.showIds ?? []);
    })();
    return this.getUser(id)!;
  }

  /** Creates the owner, or replaces the first owner's email and password (CLI). */
  upsertOwner(email: string, passwordHash: string): void {
    const owner = this.firstOwner();
    if (!owner) {
      this.createUser({ email, passwordHash, role: 'owner' });
      return;
    }
    this.db.prepare('UPDATE users SET email = ?, password_hash = ?, disabled_at = NULL WHERE id = ?').run(email.trim(), passwordHash, owner.id);
    this.deleteUserSessions(owner.id);
  }

  updateUser(id: string, fields: Partial<Pick<User, 'email' | 'name' | 'role' | 'password_hash' | 'disabled_at' | 'last_login_at' | 'totp_secret' | 'totp_enabled' | 'totp_last_step'>>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE users SET ${sets} WHERE id = @__id`).run({ ...fields, __id: id });
  }

  deleteUser(id: string): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  userShowIds(userId: string): string[] {
    return (this.db.prepare('SELECT show_id FROM user_shows WHERE user_id = ?').all(userId) as { show_id: string }[]).map((r) => r.show_id);
  }

  setUserShows(userId: string, showIds: string[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM user_shows WHERE user_id = ?').run(userId);
      const ins = this.db.prepare('INSERT OR IGNORE INTO user_shows (user_id, show_id) SELECT ?, id FROM shows WHERE id = ?');
      for (const sid of showIds) ins.run(userId, sid);
    })();
  }

  // invites + password-reset links (one table, told apart by kind)
  createInvite(i: { kind: 'invite' | 'reset'; email: string; role?: Role; showIds?: string[]; userId?: string; createdBy?: string; tokenHash: string; ttlMs: number }): string {
    const id = randomToken(8);
    const now = Date.now();
    if (i.kind === 'invite') this.db.prepare("DELETE FROM invites WHERE kind = 'invite' AND email = ? AND used_at IS NULL").run(i.email.trim());
    else this.db.prepare("DELETE FROM invites WHERE kind = 'reset' AND user_id = ? AND used_at IS NULL").run(i.userId);
    this.db
      .prepare(
        `INSERT INTO invites (id, token_hash, kind, email, role, show_ids, user_id, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, i.tokenHash, i.kind, i.email.trim(), i.role ?? null, JSON.stringify(i.showIds ?? []), i.userId ?? null, i.createdBy ?? null, new Date(now).toISOString(), new Date(now + i.ttlMs).toISOString());
    return id;
  }

  /** The unused, unexpired invite or reset link behind a token hash. */
  findInvite(tokenHash: string): Invite | undefined {
    return this.db
      .prepare('SELECT * FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
      .get(tokenHash, nowIso()) as Invite | undefined;
  }

  pendingInvites(): Invite[] {
    return this.db
      .prepare("SELECT * FROM invites WHERE kind = 'invite' AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC")
      .all(nowIso()) as Invite[];
  }

  getInvite(id: string): Invite | undefined {
    return this.db.prepare('SELECT * FROM invites WHERE id = ?').get(id) as Invite | undefined;
  }

  markInviteUsed(id: string): void {
    this.db.prepare('UPDATE invites SET used_at = ? WHERE id = ?').run(nowIso(), id);
  }

  deleteInvite(id: string): void {
    this.db.prepare('DELETE FROM invites WHERE id = ?').run(id);
  }

  // recovery codes for two-step sign-in
  replaceRecoveryCodes(userId: string, hashes: string[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
      const ins = this.db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)');
      for (const h of hashes) ins.run(userId, h);
    })();
  }

  /** Marks a recovery code used. False if it was wrong or already spent. */
  useRecoveryCode(userId: string, hash: string): boolean {
    return this.db.prepare('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL').run(nowIso(), userId, hash).changes > 0;
  }

  unusedRecoveryCodes(userId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId) as { n: number }).n;
  }

  createSession(tokenHash: string, userId: string, ttlMs: number): void {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash, userId, new Date(now).toISOString(), new Date(now + ttlMs).toISOString());
  }

  getSession(tokenHash: string): { user_id: string; expires_at: string } | undefined {
    return this.db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(tokenHash) as
      | { user_id: string; expires_at: string }
      | undefined;
  }

  deleteUserSessions(userId: string, exceptTokenHash?: string): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, exceptTokenHash ?? '');
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  // ---- webhooks ----
  listWebhooks(showId: string): Webhook[] {
    return this.db.prepare('SELECT * FROM webhooks WHERE show_id = ? ORDER BY created_at').all(showId) as Webhook[];
  }

  getWebhook(id: string): Webhook | undefined {
    return this.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as Webhook | undefined;
  }

  createWebhook(showId: string, url: string, events: WebhookEvent[]): Webhook {
    const hook: Webhook = { id: randomToken(8), show_id: showId, url, secret: `whsec_${randomToken(24)}`, events: JSON.stringify(events), enabled: 1, created_at: nowIso() };
    this.db
      .prepare('INSERT INTO webhooks (id, show_id, url, secret, events, enabled, created_at) VALUES (@id, @show_id, @url, @secret, @events, @enabled, @created_at)')
      .run(hook);
    return hook;
  }

  updateWebhook(id: string, fields: Partial<Pick<Webhook, 'url' | 'events' | 'enabled' | 'secret'>>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.db.prepare(`UPDATE webhooks SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @__id`).run({ ...fields, __id: id });
  }

  deleteWebhook(id: string): void {
    this.db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
  }

  enqueueDelivery(webhookId: string, event: string, payload: string): string {
    const id = randomToken(12);
    const now = nowIso();
    this.db
      .prepare("INSERT INTO webhook_deliveries (id, webhook_id, event, payload, status, next_attempt_at, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
      .run(id, webhookId, event, payload, now, now);
    return id;
  }

  /** Pending deliveries that are due, oldest first, with their hook's address and secret. */
  dueDeliveries(limit = 20): Array<WebhookDelivery & { url: string; secret: string; enabled: number }> {
    return this.db
      .prepare(
        `SELECT d.*, w.url, w.secret, w.enabled FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
         WHERE d.status = 'pending' AND d.next_attempt_at <= ? ORDER BY d.next_attempt_at LIMIT ?`,
      )
      .all(nowIso(), limit) as Array<WebhookDelivery & { url: string; secret: string; enabled: number }>;
  }

  updateDelivery(id: string, fields: Partial<Omit<WebhookDelivery, 'id' | 'webhook_id' | 'created_at'>>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.db.prepare(`UPDATE webhook_deliveries SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @__id`).run({ ...fields, __id: id });
  }

  recentDeliveries(webhookId: string, limit = 8): WebhookDelivery[] {
    return this.db.prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(webhookId, limit) as WebhookDelivery[];
  }

  /** Keeps the delivery log small: drops entries older than the given number of days. */
  pruneDeliveries(days = 30): void {
    this.db.prepare("DELETE FROM webhook_deliveries WHERE status != 'pending' AND created_at < ?").run(new Date(Date.now() - days * 86_400_000).toISOString());
  }

  // ---- app settings (small key/value pairs) ----
  getSetting(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---- backups ----
  insertBackup(b: { id: string; kind: Backup['kind']; started_by: string | null }): void {
    this.db.prepare("INSERT INTO backups (id, kind, status, started_by, created_at) VALUES (?, ?, 'running', ?, ?)").run(b.id, b.kind, b.started_by, nowIso());
  }

  updateBackup(id: string, fields: Partial<Omit<Backup, 'id' | 'created_at'>>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.db.prepare(`UPDATE backups SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @__id`).run({ ...fields, __id: id });
  }

  getBackup(id: string): Backup | undefined {
    return this.db.prepare('SELECT * FROM backups WHERE id = ?').get(id) as Backup | undefined;
  }

  listBackups(limit = 30): Backup[] {
    return this.db.prepare('SELECT * FROM backups ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as Backup[];
  }

  deleteBackup(id: string): void {
    this.db.prepare('DELETE FROM backups WHERE id = ?').run(id);
  }

  lastScheduledBackup(): Backup | undefined {
    return this.db.prepare("SELECT * FROM backups WHERE kind = 'scheduled' ORDER BY created_at DESC LIMIT 1").get() as Backup | undefined;
  }

  /** A backup left "running" by a restart can never finish; mark it failed. */
  failInterruptedBackups(): number {
    return this.db.prepare("UPDATE backups SET status = 'failed', error = 'Interrupted by a restart.', finished_at = ? WHERE status = 'running'").run(nowIso()).changes;
  }

  deleteExpiredSessions(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
  }
}
