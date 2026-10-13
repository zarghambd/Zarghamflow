import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { loginRequestSchema, loginVerifySchema } from '@zarghamflow/shared';
import { config } from './config.js';
import { sqlite } from './db/index.js';
import { sendMail } from './mail.js';
import { hashIp, randomToken, safeEqual, sha256 } from './security.js';

const SESSION_COOKIE = 'zf_session';
const CSRF_COOKIE = 'zf_csrf';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;
const iso = (date: Date): string => date.toISOString();

type UserRow = { id: string; email: string; timezone: string; locale: string; settings_json: string; role: 'admin'|'user'; active: number };
type SessionRow = { id: string; user_id: string; token_hash: string; expires_at: string; email: string; role: 'admin'|'user'; active: number };

function cookieOptions(secure: boolean) {
  return { path: '/', httpOnly: true, secure, sameSite: 'lax' as const };
}

export function registerAuth(app: FastifyInstance): void {
  const secure = config.NODE_ENV === 'production';

  app.get('/api/v1/auth/csrf', async (_request, reply) => {
    const token = randomToken(24);
    reply.setCookie(CSRF_COOKIE, token, { ...cookieOptions(secure), httpOnly: false, maxAge: 60 * 60 });
    return { csrfToken: token };
  });

  const requestLink = async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = loginRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(200).send({ ok: true, message: 'If the address is eligible, a sign-in link will arrive shortly.' });
    const email = parsed.data.email.trim().toLowerCase();
    const ip = hashIp(request.ip);
    const generic = { ok: true, message: 'If the address is eligible, a sign-in link will arrive shortly.' };
    const recentByIp = sqlite.prepare("SELECT COUNT(*) AS count FROM login_tokens WHERE ip_hash = ? AND kind = 'magic_link' AND created_at > ?").get(ip, iso(new Date(Date.now() - 15 * 60_000))) as { count: number };
    const recentByAccount = sqlite.prepare("SELECT COUNT(*) AS count FROM login_tokens WHERE email = ? COLLATE NOCASE AND kind = 'magic_link' AND created_at > ?").get(email, iso(new Date(Date.now() - 15 * 60_000))) as { count: number };
    const existing = sqlite.prepare('SELECT active FROM users WHERE email=? COLLATE NOCASE').get(email) as {active:number}|undefined;
    if (recentByIp.count >= 5 || recentByAccount.count >= 5 || existing?.active === 0) return reply.send(generic);

    const now = new Date();
    const rawToken = randomToken(32);
    const tokenHash = sha256(rawToken);
    sqlite.prepare('DELETE FROM login_tokens WHERE expires_at < ? OR consumed_at IS NOT NULL').run(iso(now));
    sqlite.prepare('INSERT INTO login_tokens (id,email,token_hash,kind,expires_at,created_at,ip_hash) VALUES (?,?,?,?,?,?,?)')
      .run(randomUUID(), email, tokenHash, 'magic_link', iso(new Date(now.getTime() + TEN_MINUTES)), iso(now), ip);
    const url = new URL('/signin', config.APP_URL);
    url.searchParams.set('token', rawToken);
    try {
      await sendMail(email, 'Your ZarghamFlow sign-in link', `Use this one-time link within 10 minutes to sign in or finish creating your account:\n\n${url.toString()}\n\nIf you did not request it, ignore this message.`,
        `<p>Use this one-time link within 10 minutes to sign in or finish creating your account:</p><p><a href="${url.toString()}">Continue to ZarghamFlow</a></p><p>If you did not request it, ignore this message.</p>`);
    } catch (error) {
      if (config.NODE_ENV !== 'development') throw error;
      request.log.error({ err: error }, 'Magic-link email delivery failed; returning a local development link');
      return reply.code(503).send({
        error: { code: 'EMAIL_DELIVERY_FAILED', message: 'Email could not be sent because the local mail server is unavailable.' },
        developmentLink: url.toString()
      });
    }
    return reply.send(generic);
  };
  app.post('/api/v1/auth/request', requestLink);
  app.post('/api/v1/auth/signup', requestLink);

  app.post('/api/v1/auth/verify', async (request, reply) => {
    const parsed = loginVerifySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_TOKEN', message: 'Sign-in link is invalid or expired.' } });
    const now = iso(new Date());
    const tokenHash = sha256(parsed.data.token);
    const token = sqlite.prepare("SELECT id,email,consumed_at FROM login_tokens WHERE token_hash = ? AND kind = 'magic_link' AND expires_at > ?")
      .get(tokenHash, now) as { id: string; email: string; consumed_at: string | null } | undefined;
    if (!token) {
      return reply.code(400).send({ error: { code: 'INVALID_TOKEN', message: 'Sign-in link is invalid or expired.' } });
    }
    if (token.consumed_at) {
      const rawSession = request.cookies[SESSION_COOKIE] ?? '';
      const session = rawSession
        ? sqlite.prepare(`SELECT users.email,users.role FROM sessions
            JOIN users ON users.id=sessions.user_id
            WHERE sessions.token_hash=? AND sessions.revoked_at IS NULL AND sessions.expires_at>? AND users.active=1`)
          .get(sha256(rawSession), now) as { email: string; role: 'admin'|'user' } | undefined
        : undefined;
      if (!session || session.email.toLowerCase() !== token.email.toLowerCase()) {
        return reply.code(400).send({ error: { code: 'INVALID_TOKEN', message: 'Sign-in link is invalid or expired.' } });
      }
      return reply.send({ ok: true, user: { email: session.email, role: session.role }, redirect: session.role === 'admin' ? '/admin' : '/planner' });
    }
    const user = sqlite.transaction(() => {
      const current = sqlite.prepare('SELECT id,email,timezone,locale,settings_json,role,active FROM users WHERE email = ? COLLATE NOCASE').get(token.email) as UserRow | undefined;
      const hasAdmin = (sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND active=1").get() as {count:number}).count > 0;
      const configuredAdmin = config.ADMIN_EMAIL?.trim().toLowerCase();
      if (current) {
        if (!current.active) return undefined;
        if ((!hasAdmin && !configuredAdmin) || (configuredAdmin && current.email.toLowerCase() === configuredAdmin)) {
          sqlite.prepare("UPDATE users SET role='admin',updated_at=? WHERE id=?").run(now,current.id);
          current.role='admin';
        }
        return current;
      }
      const role = configuredAdmin ? (token.email.toLowerCase() === configuredAdmin ? 'admin' : 'user') : (!hasAdmin ? 'admin' : 'user');
      const created = { id: randomUUID(), email: token.email.toLowerCase(), timezone: 'UTC', locale: 'en-GB', settings_json: '{}', role, active: 1, created_at: now, updated_at: now };
      sqlite.prepare('INSERT INTO users (id,email,timezone,locale,settings_json,role,active,created_at,updated_at) VALUES (@id,@email,@timezone,@locale,@settings_json,@role,@active,@created_at,@updated_at)').run(created);
      sqlite.prepare('INSERT INTO reminder_prefs (user_id,prefs_json,updated_at) VALUES (?,?,?)').run(created.id, JSON.stringify({}), now);
      return created;
    })();
    if (!user) return reply.code(400).send({ error: { code: 'INVALID_TOKEN', message: 'Sign-in link is invalid or expired.' } });
    sqlite.prepare('UPDATE login_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(now, token.id);
    const rawSession = randomToken(48);
    const sessionId = randomUUID();
    const expiresAt = iso(new Date(Date.now() + SESSION_MS));
    const userAgent = String(request.headers['user-agent'] ?? 'Unknown device').slice(0, 200);
    sqlite.prepare('INSERT INTO sessions (id,user_id,token_hash,device,ip_hash,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(sessionId, user.id, sha256(rawSession), userAgent, hashIp(request.ip), now, now, expiresAt);
    sqlite.prepare('INSERT INTO audit_log (id,user_id,event,details_json,ip_hash,created_at) VALUES (?,?,?,?,?,?)')
      .run(randomUUID(), user.id, 'sign_in', JSON.stringify({ device: userAgent }), hashIp(request.ip), now);
    reply.setCookie(SESSION_COOKIE, rawSession, { ...cookieOptions(secure), maxAge: SESSION_MS / 1000 });
    return reply.send({ ok: true, user: { email: user.email, role: user.role }, redirect: user.role === 'admin' ? '/admin' : '/planner' });
  });

  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/v1/') || request.url === '/api/v1/auth/csrf') return;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const cookieToken = request.cookies[CSRF_COOKIE] ?? '';
      const headerToken = String(request.headers['x-csrf-token'] ?? '');
      if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) {
        return reply.code(403).send({ error: { code: 'CSRF_INVALID', message: 'Request verification failed. Refresh and retry.' } });
      }
    }
    if (request.url.startsWith('/api/v1/auth/request') || request.url.startsWith('/api/v1/auth/signup') || request.url.startsWith('/api/v1/auth/verify') || request.url.startsWith('/api/v1/auth/actions/')) return;
    const rawSession = request.cookies[SESSION_COOKIE];
    if (!rawSession) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Sign in required.' } });
    const session = sqlite.prepare(`SELECT sessions.id,sessions.user_id,sessions.token_hash,sessions.expires_at,users.email,users.role,users.active
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.revoked_at IS NULL`).get(sha256(rawSession)) as SessionRow | undefined;
    if (!session || !session.active || session.expires_at <= iso(new Date())) {
      if (session) sqlite.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(iso(new Date()), session.id);
      reply.clearCookie(SESSION_COOKIE, cookieOptions(secure));
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Sign in required.' } });
    }
    const nextExpiry = iso(new Date(Date.now() + SESSION_MS));
    sqlite.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(iso(new Date()), nextExpiry, session.id);
    reply.setCookie(SESSION_COOKIE, rawSession, { ...cookieOptions(secure), maxAge: SESSION_MS / 1000 });
    request.owner = { id: session.user_id, email: session.email, role: session.role, sessionId: session.id };
    const csrfToken = request.cookies[CSRF_COOKIE];
    if (csrfToken) request.csrfToken = csrfToken;
  });

  app.get('/api/v1/auth/me', async (request) => ({ user: { email: request.owner?.email, role: request.owner?.role } }));

  app.post('/api/v1/auth/logout', async (request, reply) => {
    if (request.owner) sqlite.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(iso(new Date()), request.owner.sessionId);
    reply.clearCookie(SESSION_COOKIE, cookieOptions(secure));
    return { ok: true };
  });

  app.post('/api/v1/auth/logout-all', async (request, reply) => {
    const owner = request.owner;
    if (owner) sqlite.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(iso(new Date()), owner.id);
    reply.clearCookie(SESSION_COOKIE, cookieOptions(secure));
    return { ok: true };
  });

  app.get('/api/v1/auth/sessions', async (request) => {
    const owner = request.owner;
    if (!owner) return { items: [] };
    const rows = sqlite.prepare('SELECT id,device,created_at,last_seen_at,expires_at FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC').all(owner.id) as Array<{ id: string; device: string; created_at: string; last_seen_at: string; expires_at: string }>;
    return { items: rows.map((row) => ({ ...row, current: row.id === owner.sessionId })) };
  });
}

export function addCsrfHeaders(request: FastifyRequest, reply: FastifyReply): void {
  if (request.csrfToken) reply.header('x-csrf-token', request.csrfToken);
}
