import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type DB = Database.Database;

interface Migration {
  id: number;
  name: string;
  sql: string;
}

/** Append-only. Never edit a migration that has shipped; add a new one. */
const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE shows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        site_key TEXT NOT NULL UNIQUE,
        allowed_origins TEXT NOT NULL DEFAULT '[]',
        notify_email TEXT,
        max_seconds INTEGER NOT NULL DEFAULT 180,
        ask_email INTEGER NOT NULL DEFAULT 1,
        consent_text TEXT NOT NULL DEFAULT 'By sending this message you agree that it may be played on the show.',
        button_label TEXT NOT NULL DEFAULT 'Leave a voicemail',
        accent_color TEXT NOT NULL DEFAULT '#21649E',
        prompt_text TEXT NOT NULL DEFAULT 'Record a message for the show.',
        thanks_text TEXT NOT NULL DEFAULT 'Thank you! Your message was sent.',
        retain_original INTEGER NOT NULL DEFAULT 0,
        turnstile_site_key TEXT,
        turnstile_secret_key TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('processing', 'ready', 'failed')),
        starred INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        sender_name TEXT NOT NULL,
        sender_email TEXT,
        consent_given INTEGER NOT NULL DEFAULT 0,
        duration_seconds REAL,
        mp3_key TEXT,
        original_key TEXT,
        size_bytes INTEGER,
        original_mime TEXT,
        ip_hash TEXT,
        user_agent TEXT,
        transcript TEXT,
        notes TEXT,
        error TEXT,
        read_at TEXT,
        created_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX idx_messages_show_created ON messages(show_id, created_at);
      CREATE INDEX idx_messages_created ON messages(created_at);
      CREATE INDEX idx_messages_ip_created ON messages(ip_hash, created_at);

      CREATE TABLE admin (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        admin_id INTEGER NOT NULL REFERENCES admin(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    id: 2,
    name: 'email alert status',
    sql: `ALTER TABLE messages ADD COLUMN email_error TEXT;`,
  },
  {
    id: 3,
    name: 'full-text search',
    // External-content FTS5 index over the searchable text of each message. Triggers keep it in step,
    // so transcripts (when added later) become searchable just by being written to messages.transcript.
    sql: `
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        sender_name, sender_email, notes, transcript,
        content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
      );
      INSERT INTO messages_fts(rowid, sender_name, sender_email, notes, transcript)
        SELECT rowid, sender_name, sender_email, notes, transcript FROM messages;
      CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, sender_name, sender_email, notes, transcript)
          VALUES (new.rowid, new.sender_name, new.sender_email, new.notes, new.transcript);
      END;
      CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, sender_name, sender_email, notes, transcript)
          VALUES ('delete', old.rowid, old.sender_name, old.sender_email, old.notes, old.transcript);
      END;
      CREATE TRIGGER messages_fts_au AFTER UPDATE OF sender_name, sender_email, notes, transcript ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, sender_name, sender_email, notes, transcript)
          VALUES ('delete', old.rowid, old.sender_name, old.sender_email, old.notes, old.transcript);
        INSERT INTO messages_fts(rowid, sender_name, sender_email, notes, transcript)
          VALUES (new.rowid, new.sender_name, new.sender_email, new.notes, new.transcript);
      END;
    `,
  },
  {
    id: 4,
    name: 'transcription',
    sql: `
      ALTER TABLE shows ADD COLUMN transcribe INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE messages ADD COLUMN transcript_status TEXT;
      ALTER TABLE messages ADD COLUMN transcript_error TEXT;
      ALTER TABLE messages ADD COLUMN transcript_seconds REAL;
    `,
  },
  {
    id: 5,
    name: 'loudness and waveform',
    sql: `
      ALTER TABLE shows ADD COLUMN normalize_loudness INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE messages ADD COLUMN waveform TEXT;
    `,
  },
];

export function migrate(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => (r as { id: number }).id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    const run = db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, new Date().toISOString());
    });
    run();
  }
}

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}
