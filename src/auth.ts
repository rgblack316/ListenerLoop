import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';
import type { Role } from './db/repo.js';
import { hmacHex, randomToken, safeEqual, sha256hex } from './lib/util.js';

export const SESSION_COOKIE = 'll_session';
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface AdminSession {
  userId: string;
  email: string;
  name: string;
  role: Role;
  tokenHash: string;
  csrf: string;
}

export const isOwner = (s: AdminSession): boolean => s.role === 'owner';
/** Owners and editors may change messages; viewers are read-only. */
export const canEdit = (s: AdminSession): boolean => s.role !== 'viewer';

export function csrfFor(ctx: AppContext, tokenHash: string): string {
  return hmacHex(ctx.config.sessionSecret, `csrf:${tokenHash}`).slice(0, 32);
}

export function getSession(ctx: AppContext, req: FastifyRequest): AdminSession | null {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = sha256hex(token);
  const row = ctx.repo.getSession(tokenHash);
  if (!row || row.expires_at < new Date().toISOString()) return null;
  const user = ctx.repo.getUser(row.user_id);
  if (!user || user.disabled_at) return null;
  return { userId: user.id, email: user.email, name: user.name, role: user.role, tokenHash, csrf: csrfFor(ctx, tokenHash) };
}

export function startSession(ctx: AppContext, reply: FastifyReply, userId: string): void {
  const token = randomToken(32);
  ctx.repo.createSession(sha256hex(token), userId, SESSION_TTL_MS);
  void reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: ctx.config.secureCookies,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function endSession(ctx: AppContext, req: FastifyRequest, reply: FastifyReply): void {
  const token = req.cookies[SESSION_COOKIE];
  if (token) ctx.repo.deleteSession(sha256hex(token));
  void reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function csrfValid(session: AdminSession, supplied: unknown): boolean {
  return typeof supplied === 'string' && supplied.length > 0 && safeEqual(session.csrf, supplied);
}

/** Simple in-memory login throttle: 8 failures per IP per 15 minutes. */
export class LoginThrottle {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly limit = 8,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  blocked(ip: string, now = Date.now()): boolean {
    const hit = this.hits.get(ip);
    if (!hit || hit.resetAt < now) return false;
    return hit.count >= this.limit;
  }

  fail(ip: string, now = Date.now()): void {
    const hit = this.hits.get(ip);
    if (!hit || hit.resetAt < now) this.hits.set(ip, { count: 1, resetAt: now + this.windowMs });
    else hit.count++;
  }

  clear(ip: string): void {
    this.hits.delete(ip);
  }
}
