import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AdminSession } from '../auth.js';
import type { AppContext } from '../context.js';
import { ftsQuery, INBOX_FILTERS, type InboxFilter, type MessageWithShow, type Show } from '../db/repo.js';
import { csvCell } from '../zip.js';
import type { RouteKit } from './users.js';

export const MAX_EXPORT_ROWS = 50_000;
const BATCH = 1000;

const COLUMNS = ['id', 'show', 'received_utc', 'name', 'email', 'seconds', 'status', 'starred', 'archived', 'replied_utc', 'transcript', 'notes', 'link'] as const;

export function registerExportRoutes(app: FastifyInstance, ctx: AppContext, kit: RouteKit): void {
  const { repo, config } = ctx;

  const rowsFor = (req: FastifyRequest, session: AdminSession, show?: Show): MessageWithShow[] => {
    const q = req.query as { filter?: string; q?: string };
    const search = (q.q ?? '').trim().slice(0, 200);
    const searching = ftsQuery(search) !== null;
    const filter: InboxFilter = searching ? 'all' : INBOX_FILTERS.includes(q.filter as InboxFilter) ? (q.filter as InboxFilter) : 'all';
    const scope = show ? show.id : kit.accessibleShows(session).map((s) => s.id);
    const out: MessageWithShow[] = [];
    for (let offset = 0; out.length < MAX_EXPORT_ROWS; offset += BATCH) {
      const batch = repo.listMessages(filter, { showId: scope, limit: BATCH, offset, search: searching ? search : undefined });
      out.push(...batch);
      if (batch.length < BATCH) break;
    }
    return out.slice(0, MAX_EXPORT_ROWS);
  };

  const record = (m: MessageWithShow): Record<(typeof COLUMNS)[number], string | number | boolean | null> => ({
    id: m.id,
    show: m.show_name,
    received_utc: m.created_at,
    name: m.sender_name,
    email: m.sender_email,
    seconds: m.duration_seconds,
    status: m.status,
    starred: !!m.starred,
    archived: !!m.archived,
    replied_utc: m.replied_at,
    transcript: m.transcript_status === 'done' ? m.transcript : null,
    notes: m.notes,
    link: `${config.appUrl}/shows/${m.show_slug}/messages/${m.id}`,
  });

  const send = (reply: FastifyReply, format: 'csv' | 'json', rows: MessageWithShow[], label: string): FastifyReply => {
    const day = new Date().toISOString().slice(0, 10);
    const name = `listenerloop-${label.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}-${day}.${format}`;
    reply.header('Content-Disposition', `attachment; filename="${name}"`).header('Cache-Control', 'no-store');
    if (format === 'json') return reply.type('application/json; charset=utf-8').send(JSON.stringify(rows.map(record), null, 2));
    const lines = [COLUMNS.join(',')];
    for (const m of rows) {
      const r = record(m);
      lines.push(COLUMNS.map((c) => csvCell(typeof r[c] === 'boolean' ? (r[c] ? 'yes' : '') : (r[c] as string | number | null))).join(','));
    }
    // A byte-order mark makes Excel read the file as UTF-8.
    return reply.type('text/csv; charset=utf-8').send(`﻿${lines.join('\r\n')}\r\n`);
  };

  for (const format of ['csv', 'json'] as const) {
    app.get(`/inbox/export.${format}`, kit.authed((req, reply, session) => send(reply, format, rowsFor(req, session), 'all-shows')));
    app.get(`/shows/:slug/export.${format}`, kit.authed((req, reply, session) => {
      const { slug } = req.params as { slug: string };
      const show = kit.accessibleShows(session).find((s) => s.slug === slug);
      return show ? send(reply, format, rowsFor(req, session, show), show.slug) : kit.notFound(reply);
    }));
  }
}
