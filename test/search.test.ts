import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ftsQuery } from '../src/db/repo.js';
import { login, makeHarness, type Harness } from './helpers.js';

describe('search', () => {
  let h: Harness;
  let cookie: string;
  let showA: { id: string; slug: string };
  let showB: { id: string; slug: string };

  const add = (id: string, show: { id: string }, name: string, extra: Record<string, unknown> = {}): void => {
    h.ctx.repo.insertMessage({ id, show_id: show.id, sender_name: name, sender_email: null, consent_given: 1, original_mime: 'audio/webm', ip_hash: null, user_agent: null });
    h.ctx.repo.updateMessage(id, { status: 'ready', ...extra });
  };
  const get = async (url: string): Promise<string> => (await h.app.inject({ method: 'GET', url, headers: { cookie } })).body;

  beforeAll(async () => {
    h = await makeHarness();
    cookie = (await login(h)).cookie;
    showA = h.ctx.repo.createShow({ name: 'Alpha Show' });
    showB = h.ctx.repo.createShow({ name: 'Beta Show' });
    add('m1', showA, 'Dave Thompson', { sender_email: 'dave@example.com', notes: 'wants a guest spot' });
    add('m2', showA, 'María José', { transcript: 'I loved the episode about gardening and compost' });
    add('m3', showB, 'Dave Other');
    add('m4', showA, 'Archived Ann', { archived: 1 });
  });
  afterAll(async () => {
    await h.close();
  });

  it('turns typed text into a safe query', () => {
    expect(ftsQuery('  ')).toBeNull();
    expect(ftsQuery('"" -- *')).toBeNull();
    expect(ftsQuery('dave AND "x')).toBe('"dave"* "AND"* "x"*');
  });

  it('finds by name prefix, email and notes, within one show', async () => {
    let body = await get(`/shows/${showA.slug}?q=dav`);
    expect(body).toContain('Dave Thompson');
    expect(body).not.toContain('Dave Other');
    expect(await get(`/shows/${showA.slug}?q=dave@example.com`)).toContain('Dave Thompson');
    expect(await get(`/shows/${showA.slug}?q=guest`)).toContain('Dave Thompson');
    body = await get('/inbox?q=dave');
    expect(body).toContain('Dave Thompson');
    expect(body).toContain('Dave Other');
    expect(body).toContain('2 results');
  });

  it('ignores accents, searches archived messages, and shows transcript snippets', async () => {
    expect(await get(`/shows/${showA.slug}?q=maria`)).toContain('María José');
    expect(await get(`/shows/${showA.slug}?q=ann`)).toContain('Archived Ann');
    const body = await get(`/shows/${showA.slug}?q=gardening`);
    expect(body).toContain('<mark>gardening</mark>');
  });

  it('treats operators and markup as plain text', async () => {
    for (const q of ['AND OR', '"', 'dave*', '(', '<script>alert(1)</script>', 'NEAR(a b)', '-dave']) {
      const res = await h.app.inject({ method: 'GET', url: `/inbox?q=${encodeURIComponent(q)}`, headers: { cookie } });
      expect(res.statusCode, q).toBe(200);
      expect(res.body).not.toContain('<script>alert');
    }
  });

  it('keeps the index current when notes change and when a message is deleted', async () => {
    h.ctx.repo.updateMessage('m1', { notes: 'follow up about podcasting' });
    expect(await get('/inbox?q=podcasting')).toContain('Dave Thompson');
    expect(await get('/inbox?q=guest')).not.toContain('Dave Thompson');
    h.ctx.repo.updateMessage('m1', { deleted_at: new Date().toISOString() });
    expect(await get('/inbox?q=podcasting')).not.toContain('Dave Thompson');
    h.ctx.repo.purgeMessage('m1');
    expect(await get('/inbox?q=dave')).toContain('1 result');
  });

  it('shows a friendly message for no matches and clears back to the tabs', async () => {
    const body = await get('/inbox?q=zzzzqq');
    expect(body).toContain('No messages match that search.');
    expect(body).toContain('Clear search');
    expect(await get('/inbox')).toContain('aria-label="Filter messages"');
  });
});
