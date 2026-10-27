import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanSubject, replyFromHeader, safeDisplayName } from '../src/reply.js';
import type { Show } from '../src/db/repo.js';
import { APP_URL, formPost, login, makeHarness, type Harness } from './helpers.js';

describe('reply helpers', () => {
  it('keeps header values on one line and free of address syntax', () => {
    expect(cleanSubject('Hi\r\nBcc: evil@example.com')).toBe('Hi Bcc: evil@example.com');
    expect(cleanSubject('x'.repeat(400)).length).toBe(150);
    expect(safeDisplayName('Randy "Unscripted" <x@y.z>, Inc')).toBe('Randy Unscripted x y.z Inc');
    expect(replyFromHeader('Bible Bytes', 'replies@listenerloop.app')).toBe('"Bible Bytes" <replies@listenerloop.app>');
  });
});

describe('replies to listeners', () => {
  let h: Harness;
  let session: { cookie: string; csrf: string };
  let show: Show;
  let noEmailShow: Show;

  const add = (id: string, s: Show, name: string, email: string | null, extra: Record<string, unknown> = {}): void => {
    h.ctx.repo.insertMessage({ id, show_id: s.id, sender_name: name, sender_email: email, consent_given: 1, original_mime: null, ip_hash: null, user_agent: null });
    h.ctx.repo.updateMessage(id, { status: 'ready', mp3_key: `${id}.mp3`, ...extra });
  };
  const url = (s: Show, id: string, tail = ''): string => `/shows/${s.slug}/messages/${id}${tail}`;
  const reply = (s: Show, id: string, fields: Record<string, string>, tok = session) => formPost(h, url(s, id, '/reply'), tok, fields);

  beforeAll(async () => {
    h = await makeHarness({ REPLY_FROM_ADDRESS: 'replies@listenerloop.test' });
    session = await login(h);
    show = h.ctx.repo.createShow({ name: 'Bible Bytes', notify_email: 'host@biblebytes.test' });
    noEmailShow = h.ctx.repo.createShow({ name: 'No Email Show' });
    add('r1', show, 'Lena Listener', 'lena@example.com');
    add('r2', show, 'Shy Sam', null);
    add('r3', noEmailShow, 'Nora', 'nora@example.com');
  });
  afterAll(async () => {
    await h.close();
  });

  it('sends from the replies address with the show as Reply-To, and records it', async () => {
    h.sent.length = 0;
    const res = await reply(show, 'r1', { subject: 'Thanks Lena', body: 'Great question!\nWe will cover it.' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('flash=replied');
    expect(h.sent).toHaveLength(1);
    const mail = h.sent[0]!;
    expect(mail.to).toBe('lena@example.com');
    expect(mail.from).toBe('"Bible Bytes" <replies@listenerloop.test>');
    expect(mail.replyTo).toBe('host@biblebytes.test');
    expect(mail.subject).toBe('Thanks Lena');
    expect(mail.text).toContain('Great question!\nWe will cover it.');
    expect(mail.text).toContain('You are getting this because you left a voice message for Bible Bytes');
    const m = h.ctx.repo.getMessage('r1')!;
    expect(m.replied_at).not.toBeNull();
    expect(h.ctx.repo.listReplies('r1')).toMatchObject([{ status: 'sent', to_email: 'lena@example.com', reply_to: 'host@biblebytes.test', body: 'Great question!\nWe will cover it.' }]);
    const page = await h.app.inject({ method: 'GET', url: url(show, 'r1'), headers: { cookie: session.cookie } });
    expect(page.body).toContain('Great question!');
    expect(page.body).toContain('Sent');
    const inbox = await h.app.inject({ method: 'GET', url: `/shows/${show.slug}`, headers: { cookie: session.cookie } });
    expect(inbox.body).toContain('replied');
  });

  it('cannot put extra headers into the subject', async () => {
    h.sent.length = 0;
    await reply(show, 'r1', { subject: 'Hello\r\nBcc: evil@example.com', body: 'Hi' });
    expect(h.sent[0]!.subject).not.toMatch(/[\r\n]/);
    expect(h.sent[0]!.to).toBe('lena@example.com');
  });

  it('refuses when there is nobody to reply to, no show email, or no text', async () => {
    h.sent.length = 0;
    const noListener = await reply(show, 'r2', { subject: 's', body: 'hi' });
    expect(noListener.statusCode).toBe(400);
    expect(noListener.body).toContain('did not share an email address');
    const noShow = await reply(noEmailShow, 'r3', { subject: 's', body: 'hi' });
    expect(noShow.statusCode).toBe(400);
    expect(noShow.body).toContain('show&#39;s email address in its settings');
    const empty = await reply(show, 'r1', { subject: 's', body: '   ' });
    expect(empty.statusCode).toBe(400);
    expect(empty.body).toContain('Write your reply first.');
    const big = await reply(show, 'r1', { subject: 's', body: 'x'.repeat(5001) });
    expect(big.statusCode).toBe(400);
    expect(h.sent).toHaveLength(0);
  });

  it('shows the reply form only when it can work', async () => {
    const ok = await h.app.inject({ method: 'GET', url: url(show, 'r1'), headers: { cookie: session.cookie } });
    expect(ok.body).toContain('action="/shows/' + show.slug + '/messages/r1/reply"');
    expect(ok.body).toContain('Re: your message to Bible Bytes');
    const none = await h.app.inject({ method: 'GET', url: url(noEmailShow, 'r3'), headers: { cookie: session.cookie } });
    expect(none.body).not.toContain('/messages/r3/reply"');
    expect(none.body).toContain('Open show settings');
  });

  it('needs a login, a valid CSRF token, and the right show in the URL', async () => {
    const anon = await h.app.inject({ method: 'POST', url: url(show, 'r1', '/reply'), headers: { 'content-type': 'application/x-www-form-urlencoded', origin: APP_URL }, payload: 'body=hi' });
    expect(anon.statusCode).toBe(302);
    expect((await reply(show, 'r1', { subject: 's', body: 'hi' }, { ...session, csrf: 'wrong' })).statusCode).toBe(403);
    h.sent.length = 0;
    expect((await reply(noEmailShow, 'r1', { subject: 's', body: 'hi' })).statusCode).toBe(404);
    expect(h.sent).toHaveLength(0);
  });

  it('records a failed send and lets you try again', async () => {
    add('r4', show, 'Fay', 'fay@example.com');
    h.mail.fail = true;
    const res = await reply(show, 'r4', { subject: 'Hello Fay', body: 'Thanks for calling in.' });
    expect(res.headers.location).toContain('flash=replyfailed');
    expect(h.ctx.repo.getMessage('r4')!.replied_at).toBeNull();
    const failed = h.ctx.repo.listReplies('r4')[0]!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('domain not verified');
    const page = await h.app.inject({ method: 'GET', url: url(show, 'r4'), headers: { cookie: session.cookie } });
    expect(page.body).toContain('This reply could not be sent');
    expect(page.body).toContain('Thanks for calling in.');

    h.mail.fail = false;
    h.sent.length = 0;
    const again = await formPost(h, url(show, 'r4', `/replies/${failed.id}/resend`), session, {});
    expect(again.headers.location).toContain('flash=replied');
    expect(h.sent).toHaveLength(1);
    expect(h.ctx.repo.listReplies('r4')).toHaveLength(1);
    expect(h.ctx.repo.listReplies('r4')[0]!.status).toBe('sent');
    expect(h.ctx.repo.getMessage('r4')!.replied_at).not.toBeNull();
    // a sent reply cannot be re-sent
    h.sent.length = 0;
    await formPost(h, url(show, 'r4', `/replies/${failed.id}/resend`), session, {});
    expect(h.sent).toHaveLength(0);
  });

  it('limits replies per message and deletes them with the message', async () => {
    add('r5', show, 'Max', 'max@example.com');
    for (let i = 0; i < 10; i++) expect((await reply(show, 'r5', { subject: 's', body: `n${i}` })).statusCode).toBe(302);
    const over = await reply(show, 'r5', { subject: 's', body: 'one too many' });
    expect(over.statusCode).toBe(400);
    expect(over.body).toContain('most replies');
    h.ctx.repo.purgeMessage('r5');
    expect(h.ctx.repo.listReplies('r5')).toHaveLength(0);
  });

  it('refuses everything when the server has no mail provider', async () => {
    const quiet = await makeHarness();
    (quiet.ctx as { mailer: unknown }).mailer = null;
    try {
      const s = await login(quiet);
      const sh = quiet.ctx.repo.createShow({ name: 'Q', notify_email: 'q@example.com' });
      quiet.ctx.repo.insertMessage({ id: 'q1', show_id: sh.id, sender_name: 'Q', sender_email: 'x@example.com', consent_given: 1, original_mime: null, ip_hash: null, user_agent: null });
      quiet.ctx.repo.updateMessage('q1', { status: 'ready', mp3_key: 'q.mp3' });
      const res = await formPost(quiet, `/shows/${sh.slug}/messages/q1/reply`, s, { subject: 's', body: 'hi' });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('Email is not set up');
    } finally {
      await quiet.close();
    }
  });
});
