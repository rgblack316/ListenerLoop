import nodemailer, { type Transporter } from 'nodemailer';
import type { Config } from '../config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  readonly provider: 'smtp' | 'resend';
  send(message: MailMessage): Promise<void>;
}

/** Returns null when no provider is configured; callers then skip email and log it. */
export function createMailer(config: Config): Mailer | null {
  const { mail } = config;
  if (mail.provider === 'resend') {
    if (!mail.resendApiKey || !mail.from) return null;
    return new ResendMailer(mail.resendApiKey, mail.from);
  }
  if (mail.provider === 'smtp') {
    if (!mail.smtp.host || !mail.from) return null;
    return new SmtpMailer(config);
  }
  return null;
}

class SmtpMailer implements Mailer {
  readonly provider = 'smtp' as const;
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(config: Config) {
    const { smtp, from } = config.mail;
    this.from = from;
    this.transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass ?? '' } : undefined,
      connectionTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: message.to, subject: message.subject, text: message.text });
  }
}

class ResendMailer implements Mailer {
  readonly provider = 'resend' as const;

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: MailMessage): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Resend responded ${res.status}: ${body.slice(0, 200)}`);
    }
  }
}

export interface NewMessageEmailInput {
  to: string;
  showName: string;
  senderName: string;
  senderEmail: string | null;
  durationSeconds: number | null;
  adminUrl: string;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return 'unknown length';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Audio is deliberately not attached: it keeps email small and the recording private. */
export function buildNewMessageEmail(input: NewMessageEmailInput): MailMessage {
  const lines = [
    `${input.senderName} left a voicemail for ${input.showName}.`,
    '',
    `Length: ${formatDuration(input.durationSeconds)}`,
    input.senderEmail ? `Email: ${input.senderEmail}` : 'Email: not shared',
    '',
    `Listen: ${input.adminUrl}`,
  ];
  return {
    to: input.to,
    subject: `New voicemail from ${input.senderName} (${input.showName})`,
    text: lines.join('\n'),
  };
}
