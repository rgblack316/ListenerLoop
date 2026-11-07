import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { hash } from '@node-rs/argon2';
import { formPost, login, makeHarness, type Harness } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { applyStoredMailSettings } from '../src/mailsettings.js';
import { applyStoredStorage, applyStoredTurnstile } from '../src/serversettings.js';
import type { TurnstileVerifier } from '../src/turnstile.js';

const SECRET_RESEND = 're_test_SECRETKEY1234567890';
const NEW_RESEND = 're_test_NEWKEY0987654321';

const verify: TurnstileVerifier = async ({ secret }) => {
  if (secret === 'wrongsecretvalue1') return { success: false, errorCodes: ['invalid-input-secret'] };
  if (secret === 'offlinesecretvalue') return { success: false, errorCodes: ['network-error'] };
  return { success: false, errorCodes: ['invalid-input-response'] }; // a real secret with a made-up token
};

describe('settings page: email, Turnstile and storage', () => {
  let h: Harness;
  let admin: { cookie: string; csrf: string };
  beforeAll(async () => {
    h = await makeHarness({}, verify);
    admin = await login(h);
  });
  afterAll(async () => {
    await h.close();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const settingsHtml = async (): Promise<string> => (await h.app.inject({ method: 'GET', url: '/settings', headers: { cookie: admin.cookie } })).body;

  describe('email', () => {
    const resend = { provider: 'resend', from: 'ListenerLoop <alerts@example.com>', resend_api_key: SECRET_RESEND };

    it('switches to Resend right away, with no restart', async () => {
      expect(h.ctx.mailer).not.toBeNull(); // the harness's own test mailer
      const res = await formPost(h, '/settings/email', admin, resend);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('saved and in use now');
      expect(h.ctx.mailer?.provider).toBe('resend');
      expect(h.config.mail.from).toBe('ListenerLoop <alerts@example.com>');
      expect(h.config.replyFromAddress).toBe('alerts@example.com');
    });

    it('sends with the saved key, and a new key replaces it', async () => {
      const calls: { auth: string; from: string }[] = [];
      vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string>; body: string }) => {
        calls.push({ auth: init.headers.Authorization!, from: (JSON.parse(init.body) as { from: string }).from });
        return new Response('{}', { status: 200 });
      });
      await h.ctx.mailer!.send({ to: 'me@example.com', subject: 's', text: 't' });
      expect(calls[0]).toEqual({ auth: `Bearer ${SECRET_RESEND}`, from: 'ListenerLoop <alerts@example.com>' });
      await formPost(h, '/settings/email', admin, { ...resend, resend_api_key: NEW_RESEND });
      await h.ctx.mailer!.send({ to: 'me@example.com', subject: 's', text: 't' });
      expect(calls[1]!.auth).toBe(`Bearer ${NEW_RESEND}`);
    });

    it('keeps the saved key when the box is left blank', async () => {
      const res = await formPost(h, '/settings/email', admin, { ...resend, resend_api_key: '', from: 'alerts@example.com' });
      expect(res.statusCode).toBe(200);
      expect(h.config.mail.resendApiKey).toBe(NEW_RESEND);
      expect(h.config.mail.from).toBe('alerts@example.com');
    });

    it('never shows the key, and stores it encrypted', async () => {
      const page = await settingsHtml();
      expect(page).not.toContain(NEW_RESEND);
      expect(page).not.toContain(SECRET_RESEND);
      expect(page).toContain('A key is saved');
      const stored = h.ctx.repo.getSetting('mail_settings')!;
      expect(stored).not.toContain(NEW_RESEND);
      expect(stored).toContain('"resendApiKey":"v1:');
    });

    it('rejects a missing key, a bad address, an unusable SMTP setup and line breaks', async () => {
      h.config.mail.resendApiKey = undefined; // as on a server that has never had a key
      const noKey = await formPost(h, '/settings/email', admin, { provider: 'resend', from: 'a@example.com', resend_api_key: '' });
      expect(noKey.statusCode).toBe(400);
      expect(noKey.body).toContain('Enter your Resend API key');
      expect((await formPost(h, '/settings/email', admin, { ...resend, from: 'not an address' })).statusCode).toBe(400);
      expect((await formPost(h, '/settings/email', admin, { provider: 'smtp', from: 'a@example.com', smtp_host: '', smtp_port: '587' })).statusCode).toBe(400);
      expect((await formPost(h, '/settings/email', admin, { provider: 'smtp', from: 'a@example.com', smtp_host: 'smtp.example.com', smtp_port: '99999' })).statusCode).toBe(400);
      expect((await formPost(h, '/settings/email', admin, { ...resend, resend_api_key: 're_x\r\nBcc: evil@example.com' })).statusCode).toBe(400);
    });

    it('can turn email off and can save an SMTP server', async () => {
      const smtp = await formPost(h, '/settings/email', admin, { provider: 'smtp', from: 'a@example.com', smtp_host: 'smtp.example.com', smtp_port: '2525', smtp_user: 'u', smtp_pass: 'p ass' });
      expect(smtp.statusCode).toBe(200);
      expect(h.ctx.mailer?.provider).toBe('smtp');
      expect(h.config.mail.smtp).toEqual({ host: 'smtp.example.com', port: 2525, user: 'u', pass: 'p ass' });
      const off = await formPost(h, '/settings/email', admin, { provider: 'none', from: '' });
      expect(off.statusCode).toBe(200);
      expect(h.ctx.mailer).toBeNull();
    });

    it('is loaded again at the next start', () => {
      const fresh = loadConfig({
        APP_URL: 'https://listenerloop.test',
        SESSION_SECRET: 't'.repeat(48),
        DATA_DIR: h.dir,
        TURNSTILE_SITE_KEY: 'x',
        TURNSTILE_SECRET_KEY: 'y',
        MAIL_PROVIDER: 'none',
      });
      const out = applyStoredMailSettings(fresh, h.ctx.repo);
      expect(out).toEqual({ applied: true, unreadable: false });
      expect(fresh.mail.provider).toBe('none');
    });

    it('treats a saved secret as unreadable, not as a crash, when SESSION_SECRET has changed', async () => {
      await formPost(h, '/settings/email', admin, resend);
      const fresh = loadConfig({ APP_URL: 'https://listenerloop.test', SESSION_SECRET: 'z'.repeat(48), DATA_DIR: h.dir, TURNSTILE_SITE_KEY: 'x', TURNSTILE_SECRET_KEY: 'y', MAIL_PROVIDER: 'none' });
      expect(applyStoredMailSettings(fresh, h.ctx.repo)).toEqual({ applied: true, unreadable: true });
      expect(fresh.mail.resendApiKey).toBeUndefined();
    });
  });

  describe('Turnstile', () => {
    it('checks the secret with Cloudflare first and refuses a wrong one', async () => {
      const before = { ...h.config.turnstile };
      const res = await formPost(h, '/settings/turnstile', admin, { site_key: '0x4AAAAAAAnewsitekey', secret_key: 'wrongsecretvalue1' });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('does not accept that secret key');
      expect(h.config.turnstile).toEqual(before);
    });

    it('does not save when Cloudflare cannot be reached', async () => {
      const before = { ...h.config.turnstile };
      const res = await formPost(h, '/settings/turnstile', admin, { site_key: '0x4AAAAAAAnewsitekey', secret_key: 'offlinesecretvalue' });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('could not be reached');
      expect(h.config.turnstile).toEqual(before);
    });

    it('saves new keys, uses them for listeners, and keeps the secret when it is left blank', async () => {
      const ok = await formPost(h, '/settings/turnstile', admin, { site_key: '0x4AAAAAAAnewsitekey', secret_key: 'goodsecretvalue12' });
      expect(ok.statusCode).toBe(200);
      expect(h.config.turnstile).toEqual({ siteKey: '0x4AAAAAAAnewsitekey', secretKey: 'goodsecretvalue12' });
      const show = h.ctx.repo.createShow({ name: 'Key Show', allowed_origins: JSON.stringify(['https://example.com']) });
      const cfg = await h.app.inject({ method: 'GET', url: `/api/public/config?key=${show.site_key}`, headers: { origin: 'https://example.com' } });
      expect(cfg.body).toContain('0x4AAAAAAAnewsitekey');
      await formPost(h, '/settings/turnstile', admin, { site_key: '0x4AAAAAAAanothersite', secret_key: '' });
      expect(h.config.turnstile).toEqual({ siteKey: '0x4AAAAAAAanothersite', secretKey: 'goodsecretvalue12' });
    });

    it('never shows the secret, stores it encrypted, and reloads at the next start', async () => {
      const page = await settingsHtml();
      expect(page).not.toContain('goodsecretvalue12');
      expect(h.ctx.repo.getSetting('turnstile_settings')).not.toContain('goodsecretvalue12');
      const fresh = loadConfig({ APP_URL: 'https://listenerloop.test', SESSION_SECRET: 't'.repeat(48), DATA_DIR: h.dir, TURNSTILE_SITE_KEY: 'old', TURNSTILE_SECRET_KEY: 'older', MAIL_PROVIDER: 'none' });
      applyStoredTurnstile(fresh, h.ctx.repo);
      expect(fresh.turnstile).toEqual({ siteKey: '0x4AAAAAAAanothersite', secretKey: 'goodsecretvalue12' });
    });

    it('rejects a missing or malformed site key', async () => {
      expect((await formPost(h, '/settings/turnstile', admin, { site_key: '', secret_key: '' })).statusCode).toBe(400);
      expect((await formPost(h, '/settings/turnstile', admin, { site_key: 'has spaces!', secret_key: '' })).statusCode).toBe(400);
    });
  });

  describe('storage', () => {
    const s3 = { driver: 's3', s3_endpoint: 'http://127.0.0.1:1', s3_bucket: 'bucket', s3_region: 'auto', s3_access_key_id: 'AKIA_TEST', s3_secret_access_key: 'S3SECRET_TEST_VALUE', confirm_move: '1' };

    it('asks for confirmation before pointing at a different place', async () => {
      const res = await formPost(h, '/settings/storage', admin, { ...s3, confirm_move: '' });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('not copied');
      expect(h.config.storageDriver).toBe('local');
    });

    it('changes nothing when the new storage fails its check', async () => {
      const before = h.ctx.storage;
      const res = await formPost(h, '/settings/storage', admin, s3);
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('Nothing was changed');
      expect(h.ctx.storage).toBe(before);
      expect(h.config.storageDriver).toBe('local');
      expect(h.ctx.repo.getSetting('storage_settings')).toBeUndefined();
    }, 30_000);

    it('requires bucket and keys for S3', async () => {
      const res = await formPost(h, '/settings/storage', admin, { driver: 's3', confirm_move: '1' });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('Enter the bucket name');
    });

    it('saves a passing setup, applies it at once, and hides the secret', async () => {
      const res = await formPost(h, '/settings/storage', admin, { driver: 'local' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('in use now');
      expect(h.ctx.storage.name).toBe('local');
      const stored = h.ctx.repo.getSetting('storage_settings')!;
      expect(stored).toContain('"driver":"local"');
      expect(await settingsHtml()).not.toContain('S3SECRET_TEST_VALUE');
    });

    it('reloads saved storage at the next start and the secret is encrypted', () => {
      h.ctx.repo.setSetting('storage_settings', JSON.stringify({ driver: 'local', endpoint: 'https://x.example', region: 'auto', bucket: 'b', accessKeyId: 'k', forcePathStyle: true }));
      const fresh = loadConfig({ APP_URL: 'https://listenerloop.test', SESSION_SECRET: 't'.repeat(48), DATA_DIR: h.dir, TURNSTILE_SITE_KEY: 'x', TURNSTILE_SECRET_KEY: 'y', MAIL_PROVIDER: 'none' });
      applyStoredStorage(fresh, h.ctx.repo);
      expect(fresh.s3).toMatchObject({ endpoint: 'https://x.example', bucket: 'b', accessKeyId: 'k', forcePathStyle: true });
    });
  });

  describe('permissions', () => {
    it('only site admins may change them', async () => {
      h.ctx.repo.createUser({ email: 'owner@example.com', passwordHash: await hash('another long password 1'), role: 'owner' });
      const owner = await login(h, 'owner@example.com', 'another long password 1');
      for (const url of ['/settings/email', '/settings/turnstile', '/settings/storage']) {
        const res = await formPost(h, url, owner, { provider: 'none', site_key: 'abcdefgh1234', driver: 'local' });
        expect(res.statusCode, url).toBe(403);
      }
      expect((await h.app.inject({ method: 'GET', url: '/settings', headers: { cookie: owner.cookie } })).statusCode).toBe(403);
    });

    it('needs the CSRF token', async () => {
      const res = await formPost(h, '/settings/email', { cookie: admin.cookie }, { provider: 'none', from: '' });
      expect(res.statusCode).toBe(403);
    });
  });
});

describe('version', () => {
  it('is 1.0.0 and shown on the Settings page', async () => {
    const h = await makeHarness();
    try {
      const a = await login(h);
      const page = await h.app.inject({ method: 'GET', url: '/settings', headers: { cookie: a.cookie } });
      expect(page.body).toContain('1.0.0');
    } finally {
      await h.close();
    }
  });
});
