import { fireWebhooks, messagePayload } from './webhook.js';
import type { AppContext } from './context.js';
import type { MessageWithShow } from './db/repo.js';
import { ulid } from './lib/util.js';

export const MAX_REPLY_BODY = 5000;
export const MAX_REPLY_SUBJECT = 150;
/** At most this many replies to one message, and this many in total per hour. Stops a stolen session from mass-mailing. */
export const MAX_REPLIES_PER_MESSAGE = 10;
export const MAX_REPLIES_PER_HOUR = 30;

export type ReplyBlock = 'no_mailer' | 'no_listener_email' | 'no_show_email' | 'not_ready' | 'no_from_address';

/** Why a reply cannot be sent for this message right now, or null when it can. */
export function replyBlocked(ctx: AppContext, m: MessageWithShow): ReplyBlock | null {
  if (!ctx.mailer) return 'no_mailer';
  if (!ctx.config.replyFromAddress) return 'no_from_address';
  if (m.status !== 'ready') return 'not_ready';
  if (!m.sender_email) return 'no_listener_email';
  if (!m.show_email) return 'no_show_email';
  return null;
}

export const REPLY_BLOCK_TEXT: Record<ReplyBlock, string> = {
  no_mailer: 'Email is not set up on this server, so replies cannot be sent.',
  no_from_address: 'Set REPLY_FROM_ADDRESS (or MAIL_FROM) in .env to send replies.',
  not_ready: 'This message is not ready yet.',
  no_listener_email: 'This listener did not share an email address, so there is nobody to reply to.',
  no_show_email: "Add this show's email address in its settings first. Replies use it as the Reply-To address, so the listener's answer reaches you.",
};

/** A header-safe display name: no quotes, angle brackets, commas or line breaks. */
export function safeDisplayName(name: string): string {
  return name.replace(/[\r\n"<>\\,;:@]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'ListenerLoop';
}

export function replyFromHeader(showName: string, address: string): string {
  return `"${safeDisplayName(showName)}" <${address}>`;
}

export const defaultReplySubject = (showName: string): string => `Re: your message to ${showName}`.slice(0, MAX_REPLY_SUBJECT);

/** Subjects and bodies come from a form; subjects must never carry a line break into a header. */
export function cleanSubject(raw: string): string {
  return raw.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_REPLY_SUBJECT);
}

export function replyText(body: string, showName: string, when: string): string {
  return `${body.trim()}\n\n--\nYou are getting this because you left a voice message for ${showName} on ${when.slice(0, 10)}.\nYou can reply to this email to answer ${showName} directly.\n`;
}

export type SendReplyResult = { ok: true; id: string } | { ok: false; error: string; id?: string };

/** Send one reply, record it with the message, and keep the text if sending fails so it can be tried again. */
export async function sendReply(ctx: AppContext, m: MessageWithShow, input: { subject: string; body: string }, existingId?: string): Promise<SendReplyResult> {
  const { repo, mailer, config, log } = ctx;
  const blocked = replyBlocked(ctx, m);
  if (blocked || !mailer) return { ok: false, error: REPLY_BLOCK_TEXT[blocked ?? 'no_mailer'] };
  const to = m.sender_email!;
  const replyTo = m.show_email!;
  const id = existingId ?? ulid();
  if (!existingId) {
    repo.insertReply({ id, message_id: m.id, to_email: to, reply_to: replyTo, subject: input.subject, body: input.body, status: 'failed', error: 'Not sent yet', });
  }
  try {
    await mailer.send({
      to,
      from: replyFromHeader(m.show_name, config.replyFromAddress),
      replyTo,
      subject: input.subject,
      text: replyText(input.body, m.show_name, m.created_at),
    });
    repo.updateReply(id, { status: 'sent', error: null });
    if (!m.replied_at) repo.updateMessage(m.id, { replied_at: new Date().toISOString() });
    fireWebhooks(ctx, m.show_id, 'reply.sent', messagePayload(ctx, 'reply.sent', repo.getMessage(m.id)!, repo.getReply(id)));
    return { ok: true, id };
  } catch (err) {
    log.error({ err, messageId: m.id }, 'reply email failed');
    const reason = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 300) || 'Unknown error';
    repo.updateReply(id, { status: 'failed', error: reason });
    return { ok: false, error: reason, id };
  }
}
