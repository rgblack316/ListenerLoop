import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Show } from '../src/db/repo.js';
import { csvCell } from '../src/zip.js';
import { APP_URL, hasFfmpeg, login, makeAudio, makeHarness, multipart, type Harness } from './helpers.js';

describe('csvCell', () => {
  it('quotes when needed and defuses spreadsheet formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b "c"')).toBe('"a,b ""c"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvCell('+1 555')).toBe("'+1 555");
    expect(csvCell(null)).toBe('');
    expect(csvCell(12.5)).toBe('12.5');
  });
});

describe.skipIf(!hasFfmpeg())('bulk zip download', () => {
  let h: Harness;
  let cookie = '';
  let csrf = '';
  let a: Show;
  let b: Show;
  const ids: Record<string, string> = {};

  const send = async (key: string, name: string): Promise<string> => {
    const body = multipart({ key, name, consent: 'true', 'cf-turnstile-response': 'ok' }, { data: makeAudio('webm-stream') });
    const res = await h.app.inject({ method: 'POST', url: '/api/public/messages', payload: body.payload, headers: { ...body.headers, origin: APP_URL } });
    expect(res.statusCode).toBe(202);
    await h.ctx.queue.idle();
    return res.json().id as string;
  };
  const post = (url: string, fields: [string, string][], token = csrf) =>
    h.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: APP_URL, cookie },
      payload: new URLSearchParams([['_csrf', token], ...fields]).toString(),
    });

  beforeAll(async () => {
    h = await makeHarness();
    ({ cookie, csrf } = await login(h));
    a = h.ctx.repo.createShow({ name: 'Zip A' });
    b = h.ctx.repo.createShow({ name: 'Zip B' });
    ids.ann = await send(a.site_key, '=Ann');
    ids.bob = await send(a.site_key, 'Bob, "Jr"');
    ids.cat = await send(b.site_key, 'Cat');
    h.ctx.repo.updateMessage(ids.ann!, { transcript: 'hello zip', notes: 'a note' });
  });
  afterAll(async () => {
    await h.close();
  });

  const list = (file: string): { names: string[]; ok: boolean; csv: string } => {
    const py = `import zipfile,sys,json
z=zipfile.ZipFile(sys.argv[1])
print(json.dumps({"names":z.namelist(),"ok":z.testzip() is None,"csv":z.read("messages.csv").decode("utf-8")}))`;
    const r = spawnSync('python3', ['-I', '-c', py, file], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return JSON.parse(r.stdout);
  };

  it('zips the picked messages with a CSV index and transcripts', async () => {
    const res = await post(`/shows/${a.slug}/download`, [['ids', ids.ann!], ['ids', ids.bob!]]);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="listenerloop-zip-a-\d{4}-\d{2}-\d{2}\.zip"/);
    const file = path.join(os.tmpdir(), `ll-zip-${process.pid}.zip`);
    fs.writeFileSync(file, res.rawPayload);
    const z = list(file);
    fs.rmSync(file, { force: true });
    expect(z.ok).toBe(true);
    expect(z.names.filter((n) => n.endsWith('.mp3')).length).toBe(2);
    expect(z.names.filter((n) => n.endsWith('.txt')).length).toBe(1);
    expect(z.names).toContain('messages.csv');
    expect(z.csv).toContain('hello zip');
    expect(z.csv).toContain("'=Ann"); // formula defused
    expect(z.csv).toContain('"Bob, ""Jr"""');
  });

  it('ignores messages from another show when downloading from one show', async () => {
    const res = await post(`/shows/${a.slug}/download`, [['ids', ids.cat!]]);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('flash=nopicked');
  });

  it('combined download spans shows', async () => {
    const res = await post('/inbox/download', [['ids', ids.ann!], ['ids', ids.cat!]]);
    expect(res.statusCode).toBe(200);
    const file = path.join(os.tmpdir(), `ll-zip2-${process.pid}.zip`);
    fs.writeFileSync(file, res.rawPayload);
    const z = list(file);
    fs.rmSync(file, { force: true });
    expect(z.names.filter((n) => n.endsWith('.mp3')).length).toBe(2);
  });

  it('needs a login and a valid CSRF token, and handles empty or junk picks', async () => {
    const anon = await h.app.inject({ method: 'POST', url: '/inbox/download', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: APP_URL }, payload: 'ids=x' });
    expect(anon.statusCode).toBe(302);
    expect((await post('/inbox/download', [['ids', ids.ann!]], 'wrong')).statusCode).toBe(403);
    expect((await post('/inbox/download', [])).headers.location).toContain('flash=nopicked');
    expect((await post('/inbox/download', [['ids', 'nope'], ['ids', '../../etc/passwd']])).headers.location).toContain('flash=nopicked');
  });

  it('shows the selection controls in the inbox', async () => {
    const page = await h.app.inject({ method: 'GET', url: `/shows/${a.slug}`, headers: { cookie } });
    expect(page.body).toContain('data-pick-all');
    expect(page.body).toContain(`action="/shows/${a.slug}/download"`);
    expect(page.body).toContain(`name="ids" value="${ids.ann}"`);
  });
});
