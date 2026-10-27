import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { LoginThrottle, startSession, type AdminSession } from '../auth.js';
import type { AppContext } from '../context.js';
import { ROLES, type Role, type Show } from '../db/repo.js';
import { isValidEmail, randomToken, sha256hex } from '../lib/util.js';
import { hashRecoveryCode, newRecoveryCodes, newSecret, otpauthUrl, verifyTotp } from '../totp.js';
import { acceptPage, accountPage, linkProblemPage, userPage, usersPage, type Notice } from '../views/users.js';

type Handler = (req: FastifyRequest, reply: FastifyReply, session: AdminSession) => unknown;

export interface RouteKit {
  authed: (h: Handler) => (req: FastifyRequest, reply: FastifyReply) => unknown;
  mutating: (h: Handler) => (req: FastifyRequest, reply: FastifyReply) => unknown;
  ownerAuthed: (h: Handler) => (req: FastifyRequest, reply: FastifyReply) => unknown;
  ownerMutating: (h: Handler) => (req: FastifyRequest, reply: FastifyReply) => unknown;
  page: (reply: FastifyReply, body: string, status?: number) => FastifyReply;
  sameOrigin: (req: FastifyRequest) => boolean;
  field: (body: unknown, name: string) => string;
  forbidden: (reply: FastifyReply) => FastifyReply;
  accessibleShows: (session: AdminSession) => Show[];
  notFound: (reply: FastifyReply) => FastifyReply;
}

const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD = 12;

export function registerUserRoutes(app: FastifyInstance, ctx: AppContext, kit: RouteKit): void {
  const { repo, config } = ctx;
  const { ownerAuthed, ownerMutating, authed, mutating, page, sameOrigin, field, notFound } = kit;
  const pwThrottle = new LoginThrottle();
  const linkThrottle = new LoginThrottle();

  const shownIds = (body: unknown): string[] => {
    const raw = (body as Record<string, unknown> | undefined)?.shows;
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    const valid = new Set(repo.listShows().map((s) => s.id));
    return [...new Set(list.filter((v): v is string => typeof v === 'string' && valid.has(v)))];
  };
  const roleOf = (v: string): Role | null => (ROLES.includes(v as Role) ? (v as Role) : null);

  const usersView = (session: AdminSession, notice?: Notice): string =>
    usersPage({
      csrf: session.csrf,
      users: repo.listUsers().map((u) => ({ ...u, showNames: repo.listShows().filter((s) => repo.userShowIds(u.id).includes(s.id)).map((s) => s.name) })),
      invites: repo.pendingInvites(),
      shows: repo.listShows(),
      mailOn: !!ctx.mailer,
      notice,
    });

  const userView = (session: AdminSession, id: string, notice?: Notice): string | null => {
    const user = repo.getUser(id);
    if (!user) return null;
    return userPage({
      csrf: session.csrf,
      user,
      shows: repo.listShows(),
      picked: new Set(repo.userShowIds(id)),
      self: user.id === session.userId,
      lastOwner: user.role === 'owner' && !user.disabled_at && repo.countActiveOwners() <= 1,
      notice,
    });
  };

  const newLink = (kind: 'invite' | 'reset', token: string): string => `${config.appUrl}/${kind}/${token}`;

  /** Emails a link if mail is set up. False when mail is off or the send failed. */
  const mailLink = async (to: string, subject: string, text: string): Promise<boolean> => {
    if (!ctx.mailer) return false;
    try {
      await ctx.mailer.send({ to, subject, text });
      return true;
    } catch (err) {
      ctx.log.error({ err }, "invite email failed");
      return false;
    }
  };

  const issueInvite = async (session: AdminSession, email: string, role: Role, showIds: string[]): Promise<Notice> => {
    const token = randomToken(32);
    repo.createInvite({ kind: 'invite', email, role, showIds, createdBy: session.userId, tokenHash: sha256hex(token), ttlMs: LINK_TTL_MS });
    const link = newLink('invite', token);
    const who = session.name || session.email;
    const sent = await mailLink(
      email,
      'You are invited to ListenerLoop',
      `${who} invited you to ListenerLoop as ${role === 'owner' ? 'an' : 'a'} ${role}.\n\nChoose your password here (the link works for 7 days):\n${link}\n`,
    );
    return sent
      ? { ok: true, message: `Invitation emailed to ${email}.` }
      : { ok: true, message: ctx.mailer ? `The email to ${email} could not be sent. Share this link with them yourself:` : `Email is not set up. Share this link with ${email} yourself:`, link };
  };

  // ---------------------------------------------------------------- owner: users
  app.get('/users', ownerAuthed((_req, reply, session) => page(reply, usersView(session))));

  app.post(
    '/users/invite',
    ownerMutating(async (req, reply, session) => {
      const email = field(req.body, 'email').trim().toLowerCase();
      const role = roleOf(field(req.body, 'role'));
      if (!isValidEmail(email) || !role) return page(reply, usersView(session, { ok: false, message: 'Enter a valid email and choose a role.' }), 400);
      if (repo.getUserByEmail(email)) return page(reply, usersView(session, { ok: false, message: 'That email already has an account.' }), 400);
      const notice = await issueInvite(session, email, role, role === 'owner' ? [] : shownIds(req.body));
      return page(reply, usersView(session, notice));
    }),
  );

  app.post(
    '/users/invites/:id/resend',
    ownerMutating(async (req, reply, session) => {
      const inv = repo.getInvite((req.params as { id: string }).id);
      if (!inv || inv.kind !== 'invite' || inv.used_at) return notFound(reply);
      const notice = await issueInvite(session, inv.email, (inv.role ?? 'viewer') as Role, JSON.parse(inv.show_ids) as string[]);
      return page(reply, usersView(session, notice));
    }),
  );

  app.post(
    '/users/invites/:id/revoke',
    ownerMutating((req, reply, session) => {
      repo.deleteInvite((req.params as { id: string }).id);
      return page(reply, usersView(session, { ok: true, message: 'Invitation revoked.' }));
    }),
  );

  app.get(
    '/users/:id',
    ownerAuthed((req, reply, session) => {
      const body = userView(session, (req.params as { id: string }).id);
      return body ? page(reply, body) : notFound(reply);
    }),
  );

  const withUser = (fn: (user: NonNullable<ReturnType<typeof repo.getUser>>, session: AdminSession, req: FastifyRequest, reply: FastifyReply) => unknown) =>
    ownerMutating((req, reply, session) => {
      const user = repo.getUser((req.params as { id: string }).id);
      return user ? fn(user, session, req, reply) : notFound(reply);
    });
  const isLastOwner = (u: { id: string; role: Role; disabled_at: string | null }): boolean => u.role === 'owner' && !u.disabled_at && repo.countActiveOwners() <= 1;
  const back = (reply: FastifyReply, session: AdminSession, id: string, notice: Notice, status = 200): FastifyReply => page(reply, userView(session, id, notice) ?? '', status);

  app.post(
    '/users/:id',
    withUser((user, session, req, reply) => {
      const role = roleOf(field(req.body, 'role')) ?? user.role;
      if (role !== 'owner' && isLastOwner(user)) return back(reply, session, user.id, { ok: false, message: 'There must always be one active owner.' }, 400);
      repo.updateUser(user.id, { name: field(req.body, 'name').trim().slice(0, 80), role });
      repo.setUserShows(user.id, shownIds(req.body));
      return back(reply, session, user.id, { ok: true, message: 'Saved.' });
    }),
  );

  app.post(
    '/users/:id/disable',
    withUser((user, session, _req, reply) => {
      if (user.id === session.userId || isLastOwner(user)) return back(reply, session, user.id, { ok: false, message: 'You cannot disable the only active owner or yourself.' }, 400);
      repo.updateUser(user.id, { disabled_at: new Date().toISOString() });
      repo.deleteUserSessions(user.id);
      return back(reply, session, user.id, { ok: true, message: 'Disabled and signed out.' });
    }),
  );

  app.post(
    '/users/:id/enable',
    withUser((user, session, _req, reply) => {
      repo.updateUser(user.id, { disabled_at: null });
      return back(reply, session, user.id, { ok: true, message: 'Enabled.' });
    }),
  );

  app.post(
    '/users/:id/delete',
    withUser((user, session, _req, reply) => {
      if (user.id === session.userId || isLastOwner(user)) return back(reply, session, user.id, { ok: false, message: 'You cannot remove the only active owner or yourself.' }, 400);
      repo.deleteUser(user.id);
      return page(reply, usersView(session, { ok: true, message: `${user.email} was removed.` }));
    }),
  );

  app.post(
    '/users/:id/reset-totp',
    withUser((user, session, _req, reply) => {
      repo.updateUser(user.id, { totp_enabled: 0, totp_secret: null, totp_last_step: null });
      repo.replaceRecoveryCodes(user.id, []);
      return back(reply, session, user.id, { ok: true, message: 'Two-step sign-in turned off. They can set it up again from their account.' });
    }),
  );

  app.post(
    '/users/:id/reset-link',
    withUser(async (user, session, _req, reply) => {
      const token = randomToken(32);
      repo.createInvite({ kind: 'reset', email: user.email, userId: user.id, createdBy: session.userId, tokenHash: sha256hex(token), ttlMs: LINK_TTL_MS });
      const link = newLink('reset', token);
      const sent = await mailLink(user.email, 'Reset your ListenerLoop password', `An owner made a password reset link for your ListenerLoop account (it works for 7 days):\n${link}\n`);
      return back(reply, session, user.id, sent ? { ok: true, message: `Reset link emailed to ${user.email}. You can also share it yourself:`, link } : { ok: true, message: 'Share this reset link with them:', link });
    }),
  );

  // ---------------------------------------------------------------- public: accept an invite or reset link
  const publicPage = page;

  for (const kind of ['invite', 'reset'] as const) {
    const lookup = (token: string) => {
      const row = repo.findInvite(sha256hex(token));
      if (!row || row.kind !== kind) return null;
      if (kind === 'reset') {
        const user = row.user_id ? repo.getUser(row.user_id) : undefined;
        return user && !user.disabled_at ? { row, user } : null;
      }
      return repo.getUserByEmail(row.email) ? null : { row, user: null };
    };

    app.get(`/${kind}/:token`, (req, reply) => {
      const { token } = req.params as { token: string };
      const found = lookup(token);
      return found ? publicPage(reply, acceptPage(kind, token, found.row.email)) : publicPage(reply, linkProblemPage(), 410);
    });

    app.post(`/${kind}/:token`, async (req, reply) => {
      if (!sameOrigin(req)) return reply.code(403).type('text/plain').send('Forbidden');
      const { token } = req.params as { token: string };
      if (linkThrottle.blocked(req.ip)) return publicPage(reply, linkProblemPage(), 429);
      const found = lookup(token);
      if (!found) {
        linkThrottle.fail(req.ip);
        return publicPage(reply, linkProblemPage(), 410);
      }
      const password = field(req.body, 'password');
      const again = (message: string) => publicPage(reply, acceptPage(kind, token, found.row.email, message), 400);
      if (password.length < MIN_PASSWORD) return again(`Use a password of at least ${MIN_PASSWORD} characters.`);
      if (password !== field(req.body, 'confirm')) return again('The passwords did not match.');
      const passwordHash = await hash(password);
      if (kind === 'invite') {
        const role = (found.row.role ?? 'viewer') as Role;
        const user = repo.createUser({ email: found.row.email, name: field(req.body, 'name').trim().slice(0, 80), passwordHash, role, showIds: JSON.parse(found.row.show_ids) as string[] });
        repo.markInviteUsed(found.row.id);
        repo.updateUser(user.id, { last_login_at: new Date().toISOString() });
        startSession(ctx, reply, user.id);
        return reply.redirect('/');
      }
      repo.updateUser(found.user!.id, { password_hash: passwordHash });
      repo.deleteUserSessions(found.user!.id);
      repo.markInviteUsed(found.row.id);
      return reply.redirect('/login');
    });
  }

  // ---------------------------------------------------------------- account
  const accountView = async (
    session: AdminSession,
    extra: { notice?: { section: 'name' | 'password' | 'totp'; ok: boolean; message: string }; codes?: string[]; enrolling?: boolean } = {},
  ): Promise<string> => {
    const user = repo.getUser(session.userId)!;
    let enroll: { qr: string; secret: string } | undefined;
    if (extra.enrolling && user.totp_secret && !user.totp_enabled) {
      enroll = { qr: await QRCode.toDataURL(otpauthUrl(user.totp_secret, user.email), { margin: 1, width: 200 }), secret: user.totp_secret };
    }
    return accountPage({ csrf: session.csrf, role: session.role, user, recoveryLeft: repo.unusedRecoveryCodes(user.id), enroll, ...extra });
  };
  const accountPageReply = async (reply: FastifyReply, session: AdminSession, extra: Parameters<typeof accountView>[1] = {}, status = 200): Promise<FastifyReply> =>
    page(reply, await accountView(session, extra), status);

  app.get('/account', authed(async (_req, reply, session) => {
    const user = repo.getUser(session.userId)!;
    return accountPageReply(reply, session, { enrolling: !!user.totp_secret && !user.totp_enabled });
  }));

  app.post(
    '/account/name',
    mutating(async (req, reply, session) => {
      repo.updateUser(session.userId, { name: field(req.body, 'name').trim().slice(0, 80) });
      return accountPageReply(reply, { ...session, name: field(req.body, 'name').trim() }, { notice: { section: 'name', ok: true, message: 'Saved.' } });
    }),
  );

  /** Re-checks the signed-in user's password; counts failures against the throttle. */
  const passwordOk = async (req: FastifyRequest, session: AdminSession, supplied: string): Promise<boolean> => {
    if (pwThrottle.blocked(req.ip)) return false;
    let ok = false;
    try {
      ok = await verify(repo.getUser(session.userId)!.password_hash, supplied);
    } catch {
      ok = false;
    }
    if (ok) pwThrottle.clear(req.ip);
    else pwThrottle.fail(req.ip);
    return ok;
  };

  app.post(
    '/account/password',
    mutating(async (req, reply, session) => {
      const fail = (message: string, status = 400) => accountPageReply(reply, session, { notice: { section: 'password', ok: false, message } }, status);
      const current = field(req.body, 'current');
      const next = field(req.body, 'next');
      if (!(await passwordOk(req, session, current))) return fail(pwThrottle.blocked(req.ip) ? 'Too many attempts. Please wait a few minutes and try again.' : 'The current password is not right.', 401);
      if (next.length < MIN_PASSWORD) return fail(`Use a new password of at least ${MIN_PASSWORD} characters.`);
      if (next !== field(req.body, 'confirm')) return fail('The new passwords did not match.');
      if (next === current) return fail('Choose a password that is different from the current one.');
      repo.updateUser(session.userId, { password_hash: await hash(next) });
      repo.deleteUserSessions(session.userId, session.tokenHash);
      return accountPageReply(reply, session, { notice: { section: 'password', ok: true, message: 'Password changed. Your other sessions were signed out.' } });
    }),
  );

  app.post(
    '/account/totp/start',
    mutating(async (_req, reply, session) => {
      const user = repo.getUser(session.userId)!;
      if (!user.totp_enabled) repo.updateUser(user.id, { totp_secret: newSecret(), totp_last_step: null });
      return accountPageReply(reply, session, { enrolling: true });
    }),
  );

  app.post(
    '/account/totp/confirm',
    mutating(async (req, reply, session) => {
      const user = repo.getUser(session.userId)!;
      if (!user.totp_secret || user.totp_enabled) return accountPageReply(reply, session);
      const step = verifyTotp(user.totp_secret, field(req.body, 'code'), null);
      if (step === null) return accountPageReply(reply, session, { enrolling: true, notice: { section: 'totp', ok: false, message: 'That code did not match. Check the time on your phone and try again.' } }, 400);
      const codes = newRecoveryCodes();
      repo.updateUser(user.id, { totp_enabled: 1, totp_last_step: step });
      repo.replaceRecoveryCodes(user.id, codes.map(hashRecoveryCode));
      return accountPageReply(reply, session, { codes, notice: { section: 'totp', ok: true, message: 'Two-step sign-in is on.' } });
    }),
  );

  app.post(
    '/account/totp/recovery',
    mutating(async (req, reply, session) => {
      const user = repo.getUser(session.userId)!;
      if (!user.totp_enabled) return accountPageReply(reply, session);
      if (!(await passwordOk(req, session, field(req.body, 'password')))) return accountPageReply(reply, session, { notice: { section: 'totp', ok: false, message: 'The password is not right.' } }, 401);
      const codes = newRecoveryCodes();
      repo.replaceRecoveryCodes(user.id, codes.map(hashRecoveryCode));
      return accountPageReply(reply, session, { codes, notice: { section: 'totp', ok: true, message: 'New recovery codes made. The old ones no longer work.' } });
    }),
  );

  app.post(
    '/account/totp/disable',
    mutating(async (req, reply, session) => {
      if (!(await passwordOk(req, session, field(req.body, 'password')))) return accountPageReply(reply, session, { notice: { section: 'totp', ok: false, message: 'The password is not right.' } }, 401);
      repo.updateUser(session.userId, { totp_enabled: 0, totp_secret: null, totp_last_step: null });
      repo.replaceRecoveryCodes(session.userId, []);
      return accountPageReply(reply, session, { notice: { section: 'totp', ok: true, message: 'Two-step sign-in is off.' } });
    }),
  );
}

