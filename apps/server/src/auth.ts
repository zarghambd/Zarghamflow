import { randomUUID } from 'node:crypto';
import { loginRequestSchema, loginVerifySchema } from '@zarghamflow/shared';
import { config } from './config.js';
import { dbAll, dbGet, dbRun, dbTransaction, isPostgres } from './db/index.js';
import { sendMail } from './mail.js';
import { hashIp, randomToken, safeEqual, sha256 } from './security.js';
import type { ApiApp, ApiReply, ApiRequest } from './http-types.js';

const SESSION_COOKIE = 'zf_session';
const CSRF_COOKIE = 'zf_csrf';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;
const AUTH_RATE_WINDOW_MS = 15 * 60 * 1000;
const AUTH_RATE_LIMIT = 5;
const iso = (date: Date): string => date.toISOString();

type UserRow = { id: string; email: string; timezone: string; locale: string; settings_json: string; role: 'admin'|'user'; active: number };
type SessionRow = { id: string; user_id: string; token_hash: string; expires_at: string; email: string; role: 'admin'|'user'; active: number };

function cookieOptions(secure: boolean) {
  return { path: '/', httpOnly: true, secure, sameSite: 'lax' as const };
}

async function recordAuthAttempt(kind: 'signup' | 'verify', ipHash: string, emailHash?: string): Promise<{ limited: boolean; id?: string }> {
  const now = new Date();
  const since = iso(new Date(now.getTime() - AUTH_RATE_WINDOW_MS));
  return dbTransaction(async (database) => {
    if (isPostgres) {
      await database.get('SELECT pg_advisory_xact_lock(hashtext(?)) AS locked', [`auth:${kind}:ip:${ipHash}`]);
      if (emailHash) await database.get('SELECT pg_advisory_xact_lock(hashtext(?)) AS locked', [`auth:${kind}:email:${emailHash}`]);
    }
    const recentByIp = await database.get<{ count: number | string }>(
      'SELECT COUNT(*) AS count FROM auth_rate_limits WHERE kind=? AND ip_hash=? AND created_at>?',
      [kind, ipHash, since]
    );
    const recentByEmail = emailHash
      ? await database.get<{ count: number | string }>(
        'SELECT COUNT(*) AS count FROM auth_rate_limits WHERE kind=? AND email_hash=? AND created_at>?',
        [kind, emailHash, since]
      )
      : undefined;
    if (Number(recentByIp?.count ?? 0) >= AUTH_RATE_LIMIT || Number(recentByEmail?.count ?? 0) >= AUTH_RATE_LIMIT) {
      return { limited: true };
    }
    const id = randomUUID();
    await database.run(
      'INSERT INTO auth_rate_limits (id,kind,ip_hash,email_hash,created_at) VALUES (?,?,?,?,?)',
      [id, kind, ipHash, emailHash ?? null, iso(now)]
    );
    await database.run('DELETE FROM auth_rate_limits WHERE created_at<?', [iso(new Date(now.getTime() - 24 * 60 * 60 * 1000))]);
    return { limited: false, id };
  });
}

async function attachVerifyEmail(attemptId: string, emailHash: string): Promise<boolean> {
  const since = iso(new Date(Date.now() - AUTH_RATE_WINDOW_MS));
  return dbTransaction(async (database) => {
    if (isPostgres) {
      await database.get('SELECT pg_advisory_xact_lock(hashtext(?)) AS locked', [`auth:verify:email:${emailHash}`]);
    }
    await database.run('UPDATE auth_rate_limits SET email_hash=? WHERE id=?', [emailHash, attemptId]);
    const recent = await database.get<{ count: number | string }>(
      'SELECT COUNT(*) AS count FROM auth_rate_limits WHERE kind=? AND email_hash=? AND created_at>?',
      ['verify', emailHash, since]
    );
    return Number(recent?.count ?? 0) > AUTH_RATE_LIMIT;
  });
}

export function registerAuth(app: ApiApp): void {
  const secure = config.NODE_ENV === 'production';

  app.get('/api/v1/auth/csrf', async (_request, reply) => {
    const token = randomToken(24);
    reply.setCookie(CSRF_COOKIE, token, { ...cookieOptions(secure), httpOnly: false, maxAge: 60 * 60 });
    return { csrfToken: token };
  });

  const requestLink = async (request: ApiRequest, reply: ApiReply) => {
    const ip = hashIp(request.ip);
    const generic = { ok: true, message: 'If the address is eligible, a sign-in link will arrive shortly.' };
    const parsed = loginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      await recordAuthAttempt('signup', ip);
      return reply.code(200).send(generic);
    }
    const email = parsed.data.email.trim().toLowerCase();
    const limited = await recordAuthAttempt('signup', ip, hashIp(email));
    if (limited.limited) return reply.send(generic);
    const existing = await dbGet<{ active: number }>('SELECT active FROM users WHERE lower(email)=lower(?)', [email]);
    if (existing?.active === 0) return reply.send(generic);

    const now = new Date();
    const loginTokenId = randomUUID();
    const rawToken = randomToken(32);
    const tokenHash = sha256(rawToken);
    await dbRun('DELETE FROM login_tokens WHERE expires_at < ? OR consumed_at IS NOT NULL', [iso(now)]);
    await dbRun('INSERT INTO login_tokens (id,email,token_hash,kind,expires_at,created_at,ip_hash) VALUES (?,?,?,?,?,?,?)',
      [loginTokenId, email, tokenHash, 'magic_link', iso(new Date(now.getTime() + TEN_MINUTES)), iso(now), ip]);
    const url = new URL('/signin', config.APP_URL);
    url.searchParams.set('token', rawToken);
    try {
      await sendMail(email, 'Your ZarghamFlow sign-in link', `Use this one-time link within 10 minutes to sign in or finish creating your account:\n\n${url.toString()}\n\nIf you did not request it, ignore this message.`,
        `<p>Use this one-time link within 10 minutes to sign in or finish creating your account:</p><p><a href="${url.toString()}">Continue to ZarghamFlow</a></p><p>If you did not request it, ignore this message.</p>`);
    } catch (error) {
      await dbRun('DELETE FROM login_tokens WHERE id=?', [loginTokenId]);
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
    const ipHash = hashIp(request.ip);
    const attempt = await recordAuthAttempt('verify', ipHash);
    if (attempt.limited || !attempt.id) {
      return reply.code(400).send({ error: { code: 'INVALID_TOKEN', message: 'Sign-in link is invalid or expired.' } });
    }
    const parsed = loginVerifySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_TOKEN', message: 'Sign-in link is invalid or expired.' } });
    const now = iso(new Date());
    const tokenHash = sha256(parsed.data.token);
    const token = await dbGet<{ id: string; email: string; token_hash: string; consumed_at: string | null }>("SELECT id,email,token_hash,consumed_at FROM login_tokens WHERE token_hash = ? AND kind = 'magic_link' AND expires_at > ?", [tokenHash, now]);
    if (!token || !safeEqual(token.token_hash, tokenHash)) {
      return reply.code(400).send({ error: { code: 'INVALID_TOKEN', message: 'Sign-in link is invalid or expired.' } });
    }
    if (await attachVerifyEmail(attempt.id, hashIp(token.email.trim().toLowerCase()))) {
      return reply.code(400).send({ error: { code: 'INVALID_TOKEN', message: 'Sign-in link is invalid or expired.' } });
    }
    if (token.consumed_at) {
      const rawSession = request.cookies[SESSION_COOKIE] ?? '';
      const session = rawSession
        ? await dbGet<{ email: string; role: 'admin'|'user' }>(`SELECT users.email,users.role FROM sessions
            JOIN users ON users.id=sessions.user_id
            WHERE sessions.token_hash=? AND sessions.revoked_at IS NULL AND sessions.expires_at>? AND users.active=1`,
          [sha256(rawSession), now])
        : undefined;
      if (!session || session.email.toLowerCase() !== token.email.toLowerCase()) {
        return reply.code(400).send({ error: { code: 'INVALID_TOKEN', message: 'Sign-in link is invalid or expired.' } });
      }
      return reply.send({ ok: true, user: { email: session.email, role: session.role }, redirect: session.role === 'admin' ? '/admin' : '/planner' });
    }
    const rawSession = randomToken(48);
    const sessionId = randomUUID();
    const expiresAt = iso(new Date(Date.now() + SESSION_MS));
    const userAgent = String(request.headers['user-agent'] ?? 'Unknown device').slice(0, 200);
    const result = await dbTransaction(async (database) => {
      const current = await database.get<UserRow>('SELECT id,email,timezone,locale,settings_json,role,active FROM users WHERE lower(email) = lower(?)', [token.email]);
      if (current && !current.active) return undefined;
      const claimed = await database.run("UPDATE login_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?", [now, token.id, now]);
      if (!claimed.changes) return undefined;
      const configuredAdmin = config.ADMIN_EMAIL?.trim().toLowerCase();
      const allowFirstUserAdmin = config.NODE_ENV === 'development' || config.NODE_ENV === 'test';
      const adminCount = await database.get<{ count: number | string }>("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND active=1");
      const hasAdmin = Number(adminCount?.count ?? 0) > 0;
      let user: UserRow;
      if (current) {
        if ((allowFirstUserAdmin && !hasAdmin && !configuredAdmin) || (configuredAdmin && current.email.toLowerCase() === configuredAdmin)) {
          await database.run("UPDATE users SET role='admin',updated_at=? WHERE id=?", [now, current.id]);
          current.role='admin';
        }
        user = current;
      } else {
        const role = configuredAdmin
          ? (token.email.toLowerCase() === configuredAdmin ? 'admin' : 'user')
          : (allowFirstUserAdmin && !hasAdmin ? 'admin' : 'user');
        user = { id: randomUUID(), email: token.email.toLowerCase(), timezone: 'UTC', locale: 'en-GB', settings_json: '{}', role, active: 1 };
        await database.run('INSERT INTO users (id,email,timezone,locale,settings_json,role,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
          [user.id, user.email, user.timezone, user.locale, user.settings_json, user.role, user.active, now, now]);
        await database.run('INSERT INTO reminder_prefs (user_id,prefs_json,updated_at) VALUES (?,?,?)', [user.id, JSON.stringify({}), now]);
      }
      await database.run('INSERT INTO sessions (id,user_id,token_hash,device,ip_hash,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,?,?,?,?)',
        [sessionId, user.id, sha256(rawSession), userAgent, hashIp(request.ip), now, now, expiresAt]);
      await database.run('INSERT INTO audit_log (id,user_id,event,details_json,ip_hash,created_at) VALUES (?,?,?,?,?,?)',
        [randomUUID(), user.id, 'sign_in', JSON.stringify({ device: userAgent }), hashIp(request.ip), now]);
      return { user };
    });
    const user = result?.user;
    if (!user) return reply.code(400).send({ error: { code: 'INVALID_TOKEN', message: 'Sign-in link is invalid or expired.' } });
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
    const session = await dbGet<SessionRow>(`SELECT sessions.id,sessions.user_id,sessions.token_hash,sessions.expires_at,users.email,users.role,users.active
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.revoked_at IS NULL`, [sha256(rawSession)]);
    if (!session || !session.active || session.expires_at <= iso(new Date())) {
      if (session) await dbRun('UPDATE sessions SET revoked_at = ? WHERE id = ?', [iso(new Date()), session.id]);
      reply.clearCookie(SESSION_COOKIE, cookieOptions(secure));
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Sign in required.' } });
    }
    const nextExpiry = iso(new Date(Date.now() + SESSION_MS));
    await dbRun('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', [iso(new Date()), nextExpiry, session.id]);
    reply.setCookie(SESSION_COOKIE, rawSession, { ...cookieOptions(secure), maxAge: SESSION_MS / 1000 });
    request.owner = { id: session.user_id, email: session.email, role: session.role, sessionId: session.id };
    const csrfToken = request.cookies[CSRF_COOKIE];
    if (csrfToken) request.csrfToken = csrfToken;
  });

  app.get('/api/v1/auth/me', async (request) => ({ user: { email: request.owner?.email, role: request.owner?.role } }));

  app.post('/api/v1/auth/logout', async (request, reply) => {
    if (request.owner) await dbRun('UPDATE sessions SET revoked_at = ? WHERE id = ?', [iso(new Date()), request.owner.sessionId]);
    reply.clearCookie(SESSION_COOKIE, cookieOptions(secure));
    return { ok: true };
  });

  app.post('/api/v1/auth/logout-all', async (request, reply) => {
    const owner = request.owner;
    if (owner) await dbRun('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [iso(new Date()), owner.id]);
    reply.clearCookie(SESSION_COOKIE, cookieOptions(secure));
    return { ok: true };
  });

  app.get('/api/v1/auth/sessions', async (request) => {
    const owner = request.owner;
    if (!owner) return { items: [] };
    const rows = await dbAll<{ id: string; device: string; created_at: string; last_seen_at: string; expires_at: string }>('SELECT id,device,created_at,last_seen_at,expires_at FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC', [owner.id]);
    return { items: rows.map((row) => ({ ...row, current: row.id === owner.sessionId })) };
  });
}

export function addCsrfHeaders(request: ApiRequest, reply: ApiReply): void {
  if (request.csrfToken) reply.header('x-csrf-token', request.csrfToken);
}
