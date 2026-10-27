import { createHmac } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Show } from '../src/db/repo.js';
import { checkWebhookUrl, deliverDue, fireWebhooks, messagePayload, signature, webhooksIdle } from '../src/webhook.js';
import { APP_URL, formPost, hasFfmpeg, login, makeAudio, makeHarness, multipart, type Harness } from './helpers.js';

interface Hit {
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe('checkWebhookUrl', () => {
  it('needs https and refuses internal addresses', () => {
    expect(checkWebhookUrl('https://example.com/hook')).toHaveProperty('url');
    expect(checkWebhookUrl('http://example.com/hook')).toHaveProperty('error');
    expect(checkWebhookUrl('https://127.0.0.1/hook')).toHaveProperty('error');
    expect(checkWebhookUrl('https://10.0.0.5/hook')).toHaveProperty('error');
    expect(checkWebhookUrl('https://user:pw@example.com/')).toHaveProperty('error');
    expect(checkWebhookUrl('')).toHaveProperty('error');
    expect(checkWebhookUrl('nonsense')).toHaveProperty('error');
  });
});

describe('webhooks and export', () => {
  let h: Harness;
  let server: http.Server;
  let owner: { cookie: string; csrf: string };
  let a: Show;
  let b: Show;
  let hits: Hit[] = [];
  let respond = 200;

  const addMsg = (id: string, show: Show, name: string, extra: Record<string, unknown> = {}): void => {
    h.ctx.repo.insertMessage({ id, show_id: show.id, sender_name: name, sender_email: 'pat@example.com', consent_given: 1, original_mime: null, ip_hash: null, user_agent: null });
    h.ctx.repo.updateMessage(id, { status: 'ready', duration_seconds: 12.5, ...extra });
  };
  const hookUrl = (): string => `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  const get = (url: string, s: { cookie: string }) => h.app.inject({ method: 'GET', url, headers: { cookie: s.cookie } });

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        hits.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
        res.statusCode = respond;
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    h = await makeHarness({ FEED_ALLOW_PRIVATE: 'true', REPLY_FROM_ADDRESS: 'replies@listenerloop.test' });
    owner = await login(h);
    a = h.ctx.repo.createShow({ name: 'Hook A', notify_email: 'a@example.com' });
    b = h.ctx.repo.createShow({ name: 'Hook B', notify_email: 'b@example.com' });
    addMsg('m1', a, 'Pat', { transcript: '=SUM(1,1) hello', transcript_status: 'done', notes: 'a, "note"' });
    addMsg('m2', b, 'Bo');
  });
  afterAll(async () => {
    await h.close();
    await new Promise((r) => server.close(r));
  });

  it('adds a webhook from the owner page and rejects bad input', async () => {
    const bad = await formPost(h, `/shows/${a.slug}/webhooks`, owner, { url: 'ftp://x.example.com', events: 'message.ready' });
    expect(bad.statusCode).toBe(400);
    const none = await formPost(h, `/shows/${a.slug}/webhooks`, owner, { url: hookUrl() });
    expect(none.statusCode).toBe(400);
    const ok = await formPost(h, `/shows/${a.slug}/webhooks`, owner, { url: hookUrl(), events: 'message.ready' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('whsec_');
    expect(h.ctx.repo.listWebhooks(a.id)).toHaveLength(1);
  });

  it('delivers a signed payload for subscribed events only', async () => {
    hits = [];
    const hook = h.ctx.repo.listWebhooks(a.id)[0]!;
    fireWebhooks(h.ctx, a.id, 'message.transcribed', { nope: true }); // not subscribed
    fireWebhooks(h.ctx, a.id, 'message.ready', messagePayload(h.ctx, 'message.ready', h.ctx.repo.getMessage('m1')!));
    await webhooksIdle();
    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    const body = JSON.parse(hit.body);
    expect(body.event).toBe('message.ready');
    expect(body.show.slug).toBe(a.slug);
    expect(body.message).toMatchObject({ id: 'm1', name: 'Pat', email: 'pat@example.com', duration_seconds: 12.5 });
    expect(body.message.admin_url).toBe(`${APP_URL}/shows/${a.slug}/messages/m1`);
    const ts = String(hit.headers['x-listenerloop-timestamp']);
    expect(hit.headers['x-listenerloop-signature']).toBe(`sha256=${createHmac('sha256', hook.secret).update(`${ts}.${hit.body}`).digest('hex')}`);
    expect(hit.headers['x-listenerloop-signature']).toBe(signature(hook.secret, ts, hit.body));
    expect(hit.headers['x-listenerloop-event']).toBe('message.ready');
    const d = h.ctx.repo.recentDeliveries(hook.id)[0]!;
    expect(d.status).toBe('sent');
    expect(d.attempts).toBe(1);
  });

  it('retries failures with a delay and gives up after five attempts', async () => {
    const hook = h.ctx.repo.listWebhooks(a.id)[0]!;
    h.ctx.repo.db.prepare('DELETE FROM webhook_deliveries').run();
    respond = 500;
    hits = [];
    fireWebhooks(h.ctx, a.id, 'message.ready', messagePayload(h.ctx, 'message.ready', h.ctx.repo.getMessage('m1')!));
    await webhooksIdle();
    let d = h.ctx.repo.recentDeliveries(hook.id)[0]!;
    expect(d).toMatchObject({ status: 'pending', attempts: 1, response_code: 500 });
    expect(d.error).toContain('500');
    expect(Date.parse(d.next_attempt_at!)).toBeGreaterThan(Date.now());
    expect(await deliverDue(h.ctx)).toBe(0); // not due yet
    for (let i = 2; i <= 5; i++) {
      h.ctx.repo.db.prepare("UPDATE webhook_deliveries SET next_attempt_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(d.id);
      await deliverDue(h.ctx);
      d = h.ctx.repo.recentDeliveries(hook.id)[0]!;
      expect(d.attempts).toBe(i);
    }
    expect(d.status).toBe('failed');
    expect(d.next_attempt_at).toBeNull();
    expect(hits).toHaveLength(5);
    // and it recovers when the server comes back
    respond = 200;
    fireWebhooks(h.ctx, a.id, 'message.ready', messagePayload(h.ctx, 'message.ready', h.ctx.repo.getMessage('m1')!));
    await webhooksIdle();
    expect(h.ctx.repo.recentDeliveries(hook.id)[0]!.status).toBe('sent');
  });

  it('skips turned-off webhooks, and a hook only fires for its own show', async () => {
    const hook = h.ctx.repo.listWebhooks(a.id)[0]!;
    hits = [];
    h.ctx.repo.updateWebhook(hook.id, { enabled: 0 });
    fireWebhooks(h.ctx, a.id, 'message.ready', { x: 1 });
    await webhooksIdle();
    h.ctx.repo.updateWebhook(hook.id, { enabled: 1 });
    fireWebhooks(h.ctx, b.id, 'message.ready', { x: 1 });
    await webhooksIdle();
    expect(hits).toHaveLength(0);
  });

  it('the test button reports what the server answered', async () => {
    const hook = h.ctx.repo.listWebhooks(a.id)[0]!;
    hits = [];
    const ok = await formPost(h, `/shows/${a.slug}/webhooks/${hook.id}/test`, owner, {});
    expect(ok.body).toContain('Test sent');
    expect(JSON.parse(hits[0]!.body).event).toBe('ping');
    respond = 503;
    const bad = await formPost(h, `/shows/${a.slug}/webhooks/${hook.id}/test`, owner, {});
    respond = 200;
    expect(bad.body).toContain('The test failed');
    expect(bad.body).toContain('503');
  });

  it('keeps webhooks scoped to their show and to owners', async () => {
    const hook = h.ctx.repo.listWebhooks(a.id)[0]!;
    expect((await formPost(h, `/shows/${b.slug}/webhooks/${hook.id}/delete`, owner, {})).statusCode).toBe(404);
    expect(h.ctx.repo.getWebhook(hook.id)).toBeDefined();
    // an editor cannot see or change webhooks
    const inv = h.ctx.repo.createUser({ email: 'ed@example.com', passwordHash: await hash('a long enough password'), role: 'editor', showIds: [a.id] });
    const ed = await login(h, inv.email, 'a long enough password');
    expect((await get(`/shows/${a.slug}/webhooks`, ed)).statusCode).toBe(403);
    expect((await formPost(h, `/shows/${a.slug}/webhooks`, ed, { url: hookUrl(), events: 'message.ready' })).statusCode).toBe(403);
  });

  it('refuses internal addresses at delivery time too', async () => {
    const strict = await makeHarness();
    try {
      const s = strict.ctx.repo.createShow({ name: 'Strict', notify_email: 's@example.com' });
      const hook = strict.ctx.repo.createWebhook(s.id, 'https://127.0.0.1/hook', ['message.ready']);
      fireWebhooks(strict.ctx, s.id, 'message.ready', { x: 1 });
      await webhooksIdle();
      const d = strict.ctx.repo.recentDeliveries(hook.id)[0]!;
      expect(d.status).toBe('pending');
      expect(d.error).toMatch(/private|internal/i);
    } finally {
      await strict.close();
    }
  });

  it('fires reply.sent when a reply goes out', async () => {
    const hook = h.ctx.repo.createWebhook(b.id, hookUrl(), ['reply.sent']);
    h.ctx.repo.updateMessage('m2', { mp3_key: 'm2.mp3' });
    hits = [];
    const res = await formPost(h, `/shows/${b.slug}/messages/m2/reply`, owner, { subject: 'Thanks', body: 'Hello there' });
    expect(res.statusCode).toBe(302);
    await webhooksIdle();
    const body = JSON.parse(hits[0]!.body);
    expect(body.event).toBe('reply.sent');
    expect(body.reply).toMatchObject({ subject: 'Thanks', to: 'pat@example.com' });
    h.ctx.repo.deleteWebhook(hook.id);
  });

  it.skipIf(!hasFfmpeg())('fires message.ready when a real upload finishes processing', async () => {
    for (const old of h.ctx.repo.listWebhooks(a.id)) h.ctx.repo.deleteWebhook(old.id);
    const hook = h.ctx.repo.createWebhook(a.id, hookUrl(), ['message.ready']);
    hits = [];
    const body = multipart({ key: a.site_key, name: 'Live Caller', consent: 'true', 'cf-turnstile-response': 'ok' }, { data: makeAudio('webm-stream') });
    const res = await h.app.inject({ method: 'POST', url: '/api/public/messages', payload: body.payload, headers: { ...body.headers, origin: APP_URL } });
    expect(res.statusCode).toBe(202);
    await h.ctx.queue.idle();
    await webhooksIdle();
    expect(hits).toHaveLength(1);
    expect(JSON.parse(hits[0]!.body).message).toMatchObject({ name: 'Live Caller' });
    h.ctx.repo.deleteWebhook(hook.id);
    h.ctx.repo.purgeMessage(String(res.json().id));
  });

  describe('export', () => {
    it('downloads CSV and JSON for what the user may see', async () => {
      const csv = await get('/inbox/export.csv', owner);
      expect(csv.statusCode).toBe(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.headers['content-disposition']).toContain('attachment');
      expect(csv.body.startsWith('﻿id,show,received_utc,name,email,seconds,status')).toBe(true);
      expect(csv.body).toContain("'=SUM(1,1) hello"); // spreadsheet formulas are defused
      expect(csv.body).toContain('"a, ""note"""');
      expect(csv.body).toContain('Hook B');

      const json = (await get(`/shows/${a.slug}/export.json`, owner)).json() as Array<Record<string, unknown>>;
      expect(json.map((r) => r.id)).toEqual(['m1']);
      expect(json[0]).toMatchObject({ name: 'Pat', email: 'pat@example.com', transcript: '=SUM(1,1) hello', seconds: 12.5 });
    });

    it('respects filters, search and show access', async () => {
      h.ctx.repo.updateMessage('m2', { starred: 1 });
      const starred = (await get('/inbox/export.json?filter=starred', owner)).json() as Array<{ id: string }>;
      expect(starred.map((r) => r.id)).toEqual(['m2']);
      const found = (await get('/inbox/export.json?q=hello', owner)).json() as Array<{ id: string }>;
      expect(found.map((r) => r.id)).toEqual(['m1']);

      const viewer = h.ctx.repo.createUser({ email: 'v@example.com', passwordHash: await hash('a long enough password'), role: 'viewer', showIds: [b.id] });
      const v = await login(h, viewer.email, 'a long enough password');
      const mine = (await get('/inbox/export.json', v)).json() as Array<{ id: string }>;
      expect(mine.map((r) => r.id)).toEqual(['m2']);
      expect((await get(`/shows/${a.slug}/export.csv`, v)).statusCode).toBe(404);
      expect((await h.app.inject({ method: 'GET', url: '/inbox/export.csv' })).statusCode).toBe(302);
    });
  });
});
