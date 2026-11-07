import type { Config } from './config.js';
import type { Repo } from './db/repo.js';
import { cleanText, decryptSecret, encryptSecret, isValidEmail } from './lib/util.js';

/**
 * Email settings edited on the Settings page. They are stored in the database (secrets encrypted with a key
 * derived from SESSION_SECRET) and, when present, take the place of the MAIL_* values in .env.
 */
const KEY = 'mail_settings';

export type MailProvider = 'smtp' | 'resend' | 'none';

interface Stored {
  provider: MailProvider;
  from: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  resendApiKey?: string; // encrypted
  smtpPass?: string; // encrypted
}

export interface MailForm {
  provider: MailProvider;
  from: string;
  smtpHost: string;
  smtpPort: string;
  smtpUser: string;
  /** Left blank to keep the saved value. */
  resendApiKey: string;
  smtpPass: string;
}

export const addressOf = (v: string): string => (/<([^<>\s]+@[^<>\s]+)>/.exec(v)?.[1] ?? v).trim();

function open(value: string | undefined, secret: string): { value?: string; unreadable: boolean } {
  if (!value) return { unreadable: false };
  try {
    return { value: decryptSecret(value, secret), unreadable: false };
  } catch {
    return { unreadable: true };
  }
}

/** Reads what was saved on the Settings page and puts it over the .env values. Returns true when a saved secret could not be read. */
export function applyStoredMailSettings(config: Config, repo: Repo): { applied: boolean; unreadable: boolean } {
  const raw = repo.getSetting(KEY);
  if (!raw) return { applied: false, unreadable: false };
  let s: Stored;
  try {
    s = JSON.parse(raw) as Stored;
  } catch {
    return { applied: false, unreadable: false };
  }
  const key = open(s.resendApiKey, config.sessionSecret);
  const pass = open(s.smtpPass, config.sessionSecret);
  const replyWasDerived = config.replyFromAddress === addressOf(config.mail.from);
  config.mail = {
    provider: s.provider,
    from: s.from,
    smtp: { host: s.smtpHost || undefined, port: s.smtpPort || 587, user: s.smtpUser || undefined, pass: pass.value },
    resendApiKey: key.value,
  };
  if (replyWasDerived) config.replyFromAddress = addressOf(s.from);
  return { applied: true, unreadable: key.unreadable || pass.unreadable };
}

export function mailForm(config: Config): MailForm {
  const m = config.mail;
  return { provider: m.provider, from: m.from, smtpHost: m.smtp.host ?? '', smtpPort: String(m.smtp.port || 587), smtpUser: m.smtp.user ?? '', resendApiKey: '', smtpPass: '' };
}

/** Which secrets are currently set, so the page can say so without showing them. */
export const secretsSet = (config: Config): { resend: boolean; smtp: boolean } => ({ resend: !!config.mail.resendApiKey, smtp: !!config.mail.smtp.pass });

export function readMailForm(body: unknown): MailForm {
  const b = (body ?? {}) as Record<string, unknown>;
  const f = (name: string, max: number): string => cleanText(b[name], max);
  const provider = f('provider', 10);
  return {
    provider: (['smtp', 'resend', 'none'].includes(provider) ? provider : 'none') as MailProvider,
    from: f('from', 200),
    smtpHost: f('smtp_host', 200),
    smtpPort: f('smtp_port', 6),
    smtpUser: f('smtp_user', 200),
    // Secrets are trimmed only; cleanText would also collapse spaces inside a password.
    resendApiKey: typeof b.resend_api_key === 'string' ? b.resend_api_key.trim().slice(0, 300) : '',
    smtpPass: typeof b.smtp_pass === 'string' ? b.smtp_pass.slice(0, 300) : '',
  };
}

const HAS_LINE_BREAK = /[\r\n]/;

/** Checks the form and returns problems in plain words (empty when it can be saved). */
export function checkMailForm(form: MailForm, config: Config): string[] {
  const problems: string[] = [];
  if (HAS_LINE_BREAK.test(form.resendApiKey + form.smtpPass)) problems.push('Keys and passwords cannot contain line breaks.');
  if (form.provider === 'none') return problems;
  if (!form.from) problems.push('Enter the address alerts are sent from, for example ListenerLoop <alerts@yourdomain.com>.');
  else if (!isValidEmail(addressOf(form.from))) problems.push('The "sent from" address does not look right. Use alerts@yourdomain.com or Name <alerts@yourdomain.com>.');
  if (form.provider === 'resend' && !form.resendApiKey && !config.mail.resendApiKey) problems.push('Enter your Resend API key.');
  if (form.provider === 'smtp') {
    if (!form.smtpHost) problems.push('Enter the SMTP server address.');
    const port = Number(form.smtpPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('The SMTP port must be a number from 1 to 65535 (587 is the usual one).');
  }
  return problems;
}

/** Saves the form, keeping any secret left blank, and applies it to the running config. */
export function saveMailForm(config: Config, repo: Repo, form: MailForm): void {
  const resendApiKey = form.resendApiKey || config.mail.resendApiKey;
  const smtpPass = form.smtpPass || config.mail.smtp.pass;
  const stored: Stored = {
    provider: form.provider,
    from: form.from,
    smtpHost: form.smtpHost,
    smtpPort: Number(form.smtpPort) || 587,
    smtpUser: form.smtpUser,
    resendApiKey: resendApiKey ? encryptSecret(resendApiKey, config.sessionSecret) : undefined,
    smtpPass: smtpPass ? encryptSecret(smtpPass, config.sessionSecret) : undefined,
  };
  repo.setSetting(KEY, JSON.stringify(stored));
  applyStoredMailSettings(config, repo);
}
