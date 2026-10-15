import { createHmac, randomInt, randomUUID } from 'node:crypto';
import {
  EmailChangeRequestSchema, EmailChangeVerifySchema, OtpRequestSchema, OtpSignupSchema, OtpVerifySchema, ProfileUpdateSchema
} from '@zarghamflow/shared';
import { config } from './config.js';
import { dbAll, dbGet, dbRun, dbTransaction, isPostgres, type DatabaseSession } from './db/index.js';
import { sendMail } from './mail.js';
import { hashIp, randomToken, safeEqual, sha256 } from './security.js';
import type { ApiApp, ApiReply, ApiRequest } from './http-types.js';

const SESSION_COOKIE = 'zf_session';
const CSRF_COOKIE = 'zf_csrf';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const OTP_LIFETIME_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const SEND_WINDOW_MS = 60 * 60 * 1000;
const VERIFY_WINDOW_MS = 15 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const SEND_LIMITS = { windowMs: SEND_WINDOW_MS, ipLimit: 20, emailLimit: 5 };
const VERIFY_LIMITS = { windowMs: VERIFY_WINDOW_MS, ipLimit: 20, emailLimit: 10 };
const iso = (date: Date): string => date.toISOString();

type UserRow = { id: string; email: string; timezone: string; locale: string; settings_json: string; role: 'admin'|'user'; active: number; first_name: string; last_name: string };
type SessionRow = { id: string; user_id: string; token_hash: string; expires_at: string; email: string; role: 'admin'|'user'; active: number; first_name: string; last_name: string };
type RateLimitResult = { limited: boolean; retryAfterSeconds: number };
type RatePolicy = { windowMs: number; ipLimit: number; emailLimit: number };
type OtpIssueResult = RateLimitResult & { kind?: 'account_exists' | 'account_not_found' | 'account_disabled' };
type OtpVerifyResult =
  | { kind: 'verified'; user: { email: string; role: 'admin' | 'user'; firstName: string; lastName: string }; rawSession: string }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'account_exists' }
  | { kind: 'account_not_found' }
  | { kind: 'account_disabled' }
  | { kind: 'too_many_attempts'; retryAfterSeconds: number }
  | { kind: 'rate_limited'; retryAfterSeconds: number };

function cookieOptions(secure: boolean) {
  return { path: '/', httpOnly: true, secure, sameSite: 'lax' as const };
}

function hashOtp(email: string, code: string): string {
  return createHmac('sha256', config.LOGIN_SECRET).update(`${email}:${code}`).digest('hex');
}

function retryAfterSeconds(oldest: string | null | undefined, now: Date, windowMs: number): number {
  return Math.max(1, Math.ceil((windowMs - (now.getTime() - Date.parse(oldest ?? now.toISOString()))) / 1000));
}

async function lockRateKeys(database: DatabaseSession, kind: 'signup' | 'verify', ipHash: string, emailHash?: string): Promise<void> {
  if (!isPostgres) return;
  await database.get('SELECT pg_advisory_xact_lock(hashtext(?)) AS locked', [`auth:${kind}:ip:${ipHash}`]);
  if (emailHash) await database.get('SELECT pg_advisory_xact_lock(hashtext(?)) AS locked', [`auth:${kind}:email:${emailHash}`]);
}

async function checkRate(
  database: DatabaseSession,
  kind: 'signup' | 'verify',
  ipHash: string,
  emailHash: string | undefined,
  now: Date,
  policy: RatePolicy
): Promise<RateLimitResult> {
  const since = iso(new Date(now.getTime() - policy.windowMs));
  const byIp = await database.get<{ count: number | string; oldest: string | null }>(
    'SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM auth_rate_limits WHERE kind=? AND ip_hash=? AND created_at>?',
    [kind, ipHash, since]
  );
  const byEmail = emailHash
    ? await database.get<{ count: number | string; oldest: string | null }>(
      'SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM auth_rate_limits WHERE kind=? AND email_hash=? AND created_at>?',
      [kind, emailHash, since]
    )
    : undefined;
  const waits: number[] = [];
  if (Number(byIp?.count ?? 0) >= policy.ipLimit) waits.push(retryAfterSeconds(byIp?.oldest, now, policy.windowMs));
  if (Number(byEmail?.count ?? 0) >= policy.emailLimit) waits.push(retryAfterSeconds(byEmail?.oldest, now, policy.windowMs));
  return waits.length
    ? { limited: true, retryAfterSeconds: Math.max(...waits) }
    : { limited: false, retryAfterSeconds: 0 };
}

async function recordAuthAttempt(
  kind: 'signup' | 'verify',
  ipHash: string,
  emailHash: string | undefined,
  policy: RatePolicy
): Promise<RateLimitResult> {
  const now = new Date();
  return dbTransaction(async (database) => {
    await lockRateKeys(database, kind, ipHash, emailHash);
    const rate = await checkRate(database, kind, ipHash, emailHash, now, policy);
    if (rate.limited) return rate;
    await database.run('INSERT INTO auth_rate_limits (id,kind,ip_hash,email_hash,created_at) VALUES (?,?,?,?,?)',
      [randomUUID(), kind, ipHash, emailHash ?? null, iso(now)]);
    await database.run('DELETE FROM auth_rate_limits WHERE created_at<?', [iso(new Date(now.getTime() - 24 * 60 * 60 * 1000))]);
    return rate;
  });
}

export async function cleanupExpiredOtps(): Promise<void> {
  const now = new Date();
  await dbRun('DELETE FROM auth_otps WHERE expires_at<? OR (consumed_at IS NOT NULL AND created_at<?)',
    [iso(now), iso(new Date(now.getTime() - OTP_LIFETIME_MS))]);
  await dbRun('DELETE FROM email_change_otps WHERE expires_at<? OR (consumed_at IS NOT NULL AND created_at<?)',
    [iso(new Date(now.getTime() - SEND_WINDOW_MS)), iso(new Date(now.getTime() - SEND_WINDOW_MS))]);
}

export async function requestOtp(
  email: string,
  ipHash: string,
  flow: 'signup' | 'login' = 'signup',
  firstName = '',
  lastName = ''
): Promise<OtpIssueResult> {
  const normalizedEmail = email.trim().toLowerCase();
  const now = new Date();
  const emailHash = hashIp(normalizedEmail);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const id = randomUUID();
  await cleanupExpiredOtps();
  const issue = await dbTransaction<OtpIssueResult>(async (database) => {
    await lockRateKeys(database, 'signup', ipHash, emailHash);
    const rate = await checkRate(database, 'signup', ipHash, emailHash, now, SEND_LIMITS);
    if (rate.limited) return rate;
    await database.run('INSERT INTO auth_rate_limits (id,kind,ip_hash,email_hash,created_at) VALUES (?,?,?,?,?)',
      [randomUUID(), 'signup', ipHash, emailHash, iso(now)]);
    const existing = await database.get<{ id: string; active: number }>('SELECT id,active FROM users WHERE lower(email)=lower(?)', [normalizedEmail]);
    if (flow === 'signup' && existing) return { limited: false, retryAfterSeconds: 0, kind: 'account_exists' as const };
    if (flow === 'login' && !existing) return { limited: false, retryAfterSeconds: 0, kind: 'account_not_found' as const };
    if (flow === 'login' && existing && !existing.active) return { limited: false, retryAfterSeconds: 0, kind: 'account_disabled' as const };
    const lastOtp = await database.get<{ created_at: string }>(
      'SELECT created_at FROM auth_otps WHERE email=? ORDER BY created_at DESC LIMIT 1', [normalizedEmail]);
    if (lastOtp && now.getTime() - Date.parse(lastOtp.created_at) < OTP_RESEND_COOLDOWN_MS) {
      return {
        limited: true,
        retryAfterSeconds: Math.max(1, Math.ceil((OTP_RESEND_COOLDOWN_MS - (now.getTime() - Date.parse(lastOtp.created_at))) / 1000))
      };
    }
    await database.run('UPDATE auth_otps SET consumed_at=? WHERE email=? AND consumed_at IS NULL', [iso(now), normalizedEmail]);
    await database.run(
      'INSERT INTO auth_otps (id,email,code_hash,expires_at,attempts,consumed_at,created_at,ip_hash,flow,first_name,last_name) VALUES (?,?,?,?,0,NULL,?,?,?,?,?)',
      [id, normalizedEmail, hashOtp(normalizedEmail, code), iso(new Date(now.getTime() + OTP_LIFETIME_MS)), iso(now), ipHash, flow, firstName.trim(), lastName.trim()]
    );
    await database.run('DELETE FROM auth_rate_limits WHERE created_at<?', [iso(new Date(now.getTime() - 24 * 60 * 60 * 1000))]);
    return { limited: false, retryAfterSeconds: 0 };
  });
  if (issue.limited || issue.kind) return issue;

  const text = `Your ZarghamFlow code is ${code}. It expires in 10 minutes. If you didn't request it, ignore this email.`;
  const html = `<p>Your ZarghamFlow code is <strong>${code}</strong>. It expires in 10 minutes.</p><p>If you didn't request it, ignore this email.</p>`;
  try {
    await sendMail(normalizedEmail, 'Your ZarghamFlow sign-in code', text, html);
  } catch (error) {
    console.error('OTP email delivery failed.', error);
    if (config.NODE_ENV === 'development') console.info(`Development OTP for ${normalizedEmail}: ${code}`);
  }
  return { limited: false, retryAfterSeconds: 0 };
}

export async function verifyOtp(
  email: string,
  code: string,
  ipHash: string,
  previousSessionToken = '',
  device = 'Unknown device'
): Promise<OtpVerifyResult> {
  const normalizedEmail = email.trim().toLowerCase();
  const emailHash = hashIp(normalizedEmail);
  const rate = await recordAuthAttempt('verify', ipHash, emailHash, VERIFY_LIMITS);
  if (rate.limited) return { kind: 'rate_limited', retryAfterSeconds: rate.retryAfterSeconds };

  const now = new Date();
  const nowIso = iso(now);
  const rawSession = randomToken(48);
  const sessionId = randomUUID();
  const expiresAt = iso(new Date(now.getTime() + SESSION_MS));
  const result = await dbTransaction(async (database) => {
    const otp = await database.get<{
      id: string; code_hash: string; expires_at: string; attempts: number; consumed_at: string | null; created_at: string;
      flow: 'signup' | 'login'; first_name: string; last_name: string
    }>(
      `SELECT id,code_hash,expires_at,attempts,consumed_at,created_at,flow,first_name,last_name FROM auth_otps WHERE email=? ORDER BY created_at DESC LIMIT 1${isPostgres ? ' FOR UPDATE' : ''}`,
      [normalizedEmail]
    );
    if (!otp) return { kind: 'invalid' } as const;
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      return {
        kind: 'too_many_attempts',
        retryAfterSeconds: Math.max(1, Math.ceil((OTP_RESEND_COOLDOWN_MS - (now.getTime() - Date.parse(otp.created_at))) / 1000))
      } as const;
    }
    if (otp.consumed_at) return { kind: 'invalid' } as const;
    if (otp.expires_at <= nowIso) {
      await database.run('UPDATE auth_otps SET consumed_at=? WHERE id=? AND consumed_at IS NULL', [nowIso, otp.id]);
      return { kind: 'expired' } as const;
    }
    if (!safeEqual(otp.code_hash, hashOtp(normalizedEmail, code))) {
      const attempts = otp.attempts + 1;
      await database.run('UPDATE auth_otps SET attempts=?,consumed_at=? WHERE id=? AND consumed_at IS NULL',
        [attempts, attempts >= OTP_MAX_ATTEMPTS ? nowIso : null, otp.id]);
      if (attempts >= OTP_MAX_ATTEMPTS) {
        return {
          kind: 'too_many_attempts',
          retryAfterSeconds: Math.max(1, Math.ceil((OTP_RESEND_COOLDOWN_MS - (now.getTime() - Date.parse(otp.created_at))) / 1000))
        } as const;
      }
      return { kind: 'invalid' } as const;
    }
    const consumed = await database.run('UPDATE auth_otps SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND expires_at>?',
      [nowIso, otp.id, nowIso]);
    if (!consumed.changes) return { kind: 'invalid' } as const;

    const current = await database.get<UserRow>(
      'SELECT id,email,timezone,locale,settings_json,role,active,first_name,last_name FROM users WHERE lower(email)=lower(?)', [normalizedEmail]
    );
    if (current && !current.active) return { kind: 'account_disabled' } as const;
    if (otp.flow === 'signup' && current) return { kind: 'account_exists' } as const;
    if (otp.flow === 'login' && !current) return { kind: 'account_not_found' } as const;

    const configuredAdmin = config.ADMIN_EMAIL?.trim().toLowerCase();
    const allowFirstUserAdmin = config.NODE_ENV === 'development' || config.NODE_ENV === 'test';
    const adminCount = await database.get<{ count: number | string }>("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND active=1");
    const hasAdmin = Number(adminCount?.count ?? 0) > 0;
    let user: UserRow;
    if (current) {
      if ((allowFirstUserAdmin && !hasAdmin && !configuredAdmin) || (configuredAdmin && current.email.toLowerCase() === configuredAdmin)) {
        await database.run("UPDATE users SET role='admin',updated_at=? WHERE id=?", [nowIso, current.id]);
        current.role = 'admin';
      }
      user = current;
    } else {
      const role = configuredAdmin
        ? (normalizedEmail === configuredAdmin ? 'admin' : 'user')
        : (allowFirstUserAdmin && !hasAdmin ? 'admin' : 'user');
      user = { id: randomUUID(), email: normalizedEmail, timezone: 'UTC', locale: 'en-GB', settings_json: '{}', role, active: 1, first_name: otp.first_name, last_name: otp.last_name };
      await database.run('INSERT INTO users (id,email,timezone,locale,settings_json,role,active,created_at,updated_at,first_name,last_name) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [user.id, user.email, user.timezone, user.locale, user.settings_json, user.role, user.active, nowIso, nowIso, user.first_name, user.last_name]);
      await database.run('INSERT INTO reminder_prefs (user_id,prefs_json,updated_at) VALUES (?,?,?)', [user.id, JSON.stringify({}), nowIso]);
    }

    if (previousSessionToken) {
      await database.run('UPDATE sessions SET revoked_at=? WHERE user_id=? AND token_hash=? AND revoked_at IS NULL',
        [nowIso, user.id, sha256(previousSessionToken)]);
    }
    await database.run('INSERT INTO sessions (id,user_id,token_hash,device,ip_hash,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,?,?,?,?)',
      [sessionId, user.id, sha256(rawSession), device, ipHash, nowIso, nowIso, expiresAt]);
    await database.run('INSERT INTO audit_log (id,user_id,event,details_json,ip_hash,created_at) VALUES (?,?,?,?,?,?)',
      [randomUUID(), user.id, 'sign_in', JSON.stringify({ device }), ipHash, nowIso]);
    return { kind: 'verified', user: { email: user.email, role: user.role, firstName: user.first_name, lastName: user.last_name }, rawSession } as const;
  });
  return result;
}

export function registerAuth(app: ApiApp): void {
  const secure = config.NODE_ENV === 'production';

  app.get('/api/v1/auth/csrf', async (_request, reply) => {
    const token = randomToken(24);
    reply.setCookie(CSRF_COOKIE, token, { ...cookieOptions(secure), httpOnly: false, maxAge: 60 * 60 });
    return { csrfToken: token };
  });

  const requestOtpHandler = async (request: ApiRequest, reply: ApiReply) => {
    const ipHash = hashIp(request.ip);
    const parsed = OtpRequestSchema.safeParse(request.body);
    const issue: OtpIssueResult = parsed.success
      ? await requestOtp(parsed.data.email, ipHash, 'signup')
      : await recordAuthAttempt('signup', ipHash, undefined, SEND_LIMITS);
    if (issue.limited) {
      reply.header('retry-after', String(issue.retryAfterSeconds));
      return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Please wait before requesting another code.' } });
    }
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Enter a valid email address.' } });
    if (issue.kind === 'account_exists') return reply.code(409).send({ error: { code: 'ACCOUNT_EXISTS', message: 'An account with this email already exists. Sign in instead.' } });
    return reply.code(200).send({ ok: true, message: 'A verification code was sent to your email.' });
  };
  const signupOtpHandler = async (request: ApiRequest, reply: ApiReply) => {
    const ipHash = hashIp(request.ip);
    const parsed = OtpSignupSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Enter your first name, last name, and a valid email address.' } });
    const issue = await requestOtp(parsed.data.email, ipHash, 'signup', parsed.data.firstName, parsed.data.lastName);
    if (issue.limited) {
      reply.header('retry-after', String(issue.retryAfterSeconds));
      return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Please wait before requesting another code.' } });
    }
    if (issue.kind === 'account_exists') return reply.code(409).send({ error: { code: 'ACCOUNT_EXISTS', message: 'An account with this email already exists. Sign in instead.' } });
    return reply.code(200).send({ ok: true, message: 'A verification code was sent to your email.' });
  };
  const loginOtpHandler = async (request: ApiRequest, reply: ApiReply) => {
    const ipHash = hashIp(request.ip);
    const parsed = OtpRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Enter a valid email address.' } });
    const issue = await requestOtp(parsed.data.email, ipHash, 'login');
    if (issue.limited) {
      reply.header('retry-after', String(issue.retryAfterSeconds));
      return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Please wait before requesting another code.' } });
    }
    if (issue.kind === 'account_not_found') return reply.code(404).send({ error: { code: 'ACCOUNT_NOT_FOUND', message: 'No account was found for this email. Sign up first.' } });
    if (issue.kind === 'account_disabled') return reply.code(403).send({ error: { code: 'ACCOUNT_DISABLED', message: 'Your account has been disabled. Please contact the admin to have your account enabled.' } });
    return reply.code(200).send({ ok: true, message: 'A sign-in code was sent to your email.' });
  };
  app.post('/api/v1/auth/request', requestOtpHandler);
  app.post('/api/v1/auth/signup', signupOtpHandler);
  app.post('/api/v1/auth/login', loginOtpHandler);

  app.post('/api/v1/auth/verify', async (request, reply) => {
    const ipHash = hashIp(request.ip);
    const parsed = OtpVerifySchema.safeParse(request.body);
    if (!parsed.success) {
      const rate = await recordAuthAttempt('verify', ipHash, undefined, VERIFY_LIMITS);
      if (rate.limited) {
        reply.header('retry-after', String(rate.retryAfterSeconds));
        return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Please wait before trying again.' } });
      }
      return reply.code(400).send({ error: { code: 'INVALID_CODE', message: 'Enter the 6-digit code sent to your email.' } });
    }
    const result = await verifyOtp(
      parsed.data.email,
      parsed.data.code,
      ipHash,
      request.cookies[SESSION_COOKIE] ?? '',
      String(request.headers['user-agent'] ?? 'Unknown device').slice(0, 200)
    );
    if (result.kind === 'rate_limited' || result.kind === 'too_many_attempts') {
      reply.header('retry-after', String(result.retryAfterSeconds));
      const code = result.kind === 'too_many_attempts' ? 'TOO_MANY_ATTEMPTS' : 'RATE_LIMITED';
      const message = result.kind === 'too_many_attempts'
        ? 'Too many incorrect codes. Request a new code after the resend cooldown.'
        : 'Please wait before trying again.';
      return reply.code(429).send({ error: { code, message } });
    }
    if (result.kind === 'expired') {
      return reply.code(400).send({ error: { code: 'EXPIRED_CODE', message: 'This code expired. Request a new one.' } });
    }
    if (result.kind === 'invalid') {
      return reply.code(400).send({ error: { code: 'INVALID_CODE', message: 'This code is invalid or expired. Request a new one.' } });
    }
    if (result.kind === 'account_exists') {
      return reply.code(409).send({ error: { code: 'ACCOUNT_EXISTS', message: 'An account with this email already exists. Sign in instead.' } });
    }
    if (result.kind === 'account_not_found') {
      return reply.code(404).send({ error: { code: 'ACCOUNT_NOT_FOUND', message: 'No account was found for this email. Sign up first.' } });
    }
    if (result.kind === 'account_disabled') {
      return reply.code(403).send({ error: { code: 'ACCOUNT_DISABLED', message: 'Your account has been disabled. Please contact the admin to have your account enabled.' } });
    }
    reply.setCookie(SESSION_COOKIE, result.rawSession, { ...cookieOptions(secure), maxAge: SESSION_MS / 1000 });
    return reply.send({
      ok: true,
      user: result.user,
      redirect: result.user.role === 'admin' ? '/admin' : '/planner'
    });
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
    if (request.url.startsWith('/api/v1/auth/request') || request.url.startsWith('/api/v1/auth/signup') || request.url.startsWith('/api/v1/auth/login') || request.url.startsWith('/api/v1/auth/verify') || request.url.startsWith('/api/v1/auth/actions/')) return;
    const rawSession = request.cookies[SESSION_COOKIE];
    if (!rawSession) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Sign in required.' } });
    const session = await dbGet<SessionRow & { revoked_at: string | null }>(`SELECT sessions.id,sessions.user_id,sessions.token_hash,sessions.expires_at,sessions.revoked_at,users.email,users.role,users.active,users.first_name,users.last_name
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?`, [sha256(rawSession)]);
    if (session && !session.active) {
      await dbRun('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [iso(new Date()), session.id]);
      reply.clearCookie(SESSION_COOKIE, cookieOptions(secure));
      return reply.code(403).send({ error: { code: 'ACCOUNT_DISABLED', message: 'Your account has been disabled. Please contact the admin to have your account enabled.' } });
    }
    if (!session || session.revoked_at || session.expires_at <= iso(new Date())) {
      if (session && !session.revoked_at) await dbRun('UPDATE sessions SET revoked_at = ? WHERE id = ?', [iso(new Date()), session.id]);
      reply.clearCookie(SESSION_COOKIE, cookieOptions(secure));
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Sign in required.' } });
    }
    const nextExpiry = iso(new Date(Date.now() + SESSION_MS));
    await dbRun('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', [iso(new Date()), nextExpiry, session.id]);
    reply.setCookie(SESSION_COOKIE, rawSession, { ...cookieOptions(secure), maxAge: SESSION_MS / 1000 });
    request.owner = { id: session.user_id, email: session.email, role: session.role, sessionId: session.id, firstName: session.first_name, lastName: session.last_name };
    const csrfToken = request.cookies[CSRF_COOKIE];
    if (csrfToken) request.csrfToken = csrfToken;
  });

  app.get('/api/v1/auth/me', async (request) => ({
    user: {
      email: request.owner?.email,
      role: request.owner?.role,
      firstName: request.owner?.firstName,
      lastName: request.owner?.lastName
    }
  }));

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

  app.patch('/api/v1/auth/profile', async (request, reply) => {
    const parsed = ProfileUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Enter your first and last name.' } });
    const now = iso(new Date());
    await dbRun('UPDATE users SET first_name=?,last_name=?,updated_at=? WHERE id=?',
      [parsed.data.firstName, parsed.data.lastName, now, request.owner!.id]);
    return { user: { ...request.owner!, firstName: parsed.data.firstName, lastName: parsed.data.lastName } };
  });

  app.post('/api/v1/auth/email-change/request', async (request, reply) => {
    const parsed = EmailChangeRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Enter a valid email address.' } });
    const user = request.owner!;
    const email = parsed.data.email;
    if (email === user.email.toLowerCase()) return reply.code(400).send({ error: { code: 'EMAIL_UNCHANGED', message: 'Enter a different email address.' } });
    const now = new Date();
    const nowIso = iso(now);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const issue = await dbTransaction(async (database) => {
      if (isPostgres) await database.get('SELECT pg_advisory_xact_lock(hashtext(?)) AS locked', [`email-change:${email}`]);
      const existing = await database.get<{ id: string }>('SELECT id FROM users WHERE lower(email)=lower(?)', [email]);
      if (existing) return { kind: 'exists' as const };
      const last = await database.get<{ created_at: string }>(
        'SELECT created_at FROM email_change_otps WHERE user_id=? ORDER BY created_at DESC LIMIT 1', [user.id]
      );
      if (last && now.getTime() - Date.parse(last.created_at) < OTP_RESEND_COOLDOWN_MS) {
        return { kind: 'limited' as const, retryAfterSeconds: Math.max(1, Math.ceil((OTP_RESEND_COOLDOWN_MS - (now.getTime() - Date.parse(last.created_at))) / 1000)) };
      }
      const windowStart = iso(new Date(now.getTime() - SEND_WINDOW_MS));
      const sends = await database.get<{ count: number | string; oldest: string | null }>(
        'SELECT COUNT(*) AS count,MIN(created_at) AS oldest FROM email_change_otps WHERE user_id=? AND created_at>?',
        [user.id, windowStart]
      );
      if (Number(sends?.count ?? 0) >= 5) {
        return {
          kind: 'limited' as const,
          retryAfterSeconds: Math.max(1, Math.ceil((SEND_WINDOW_MS - (now.getTime() - Date.parse(sends?.oldest ?? nowIso))) / 1000))
        };
      }
      await database.run('UPDATE email_change_otps SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL', [nowIso, user.id]);
      await database.run(
        'INSERT INTO email_change_otps (id,user_id,email,code_hash,expires_at,attempts,consumed_at,created_at,ip_hash) VALUES (?,?,?,?,?,0,NULL,?,?)',
        [randomUUID(), user.id, email, hashOtp(email, code), iso(new Date(now.getTime() + OTP_LIFETIME_MS)), nowIso, hashIp(request.ip)]
      );
      return { kind: 'sent' as const };
    });
    if (issue.kind === 'exists') return reply.code(409).send({ error: { code: 'EMAIL_IN_USE', message: 'That email address is already associated with an account.' } });
    if (issue.kind === 'limited') {
      reply.header('retry-after', String(issue.retryAfterSeconds));
      return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Please wait before requesting another code.' } });
    }
    const text = `Your ZarghamFlow email change code is ${code}. It expires in 10 minutes. If you didn't request it, ignore this email.`;
    const html = `<p>Your ZarghamFlow email change code is <strong>${code}</strong>. It expires in 10 minutes.</p><p>If you didn't request it, ignore this email.</p>`;
    try {
      await sendMail(email, 'Verify your new ZarghamFlow email', text, html);
    } catch (error) {
      console.error('Email change code delivery failed.', error);
      if (config.NODE_ENV === 'development') console.info(`Development email change OTP for ${email}: ${code}`);
    }
    return { ok: true, message: 'A verification code was sent to your new email address.' };
  });

  app.post('/api/v1/auth/email-change/verify', async (request, reply) => {
    const parsed = EmailChangeVerifySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_CODE', message: 'Enter the 6-digit code sent to your new email address.' } });
    const user = request.owner!;
    const email = parsed.data.email;
    const now = new Date();
    const nowIso = iso(now);
    const result = await dbTransaction(async (database) => {
      const otp = await database.get<{
        id: string; code_hash: string; expires_at: string; attempts: number; consumed_at: string | null
      }>(
        `SELECT id,code_hash,expires_at,attempts,consumed_at FROM email_change_otps
         WHERE user_id=? AND email=? ORDER BY created_at DESC LIMIT 1${isPostgres ? ' FOR UPDATE' : ''}`,
        [user.id, email]
      );
      if (!otp || otp.consumed_at) return { kind: 'invalid' as const };
      if (otp.expires_at <= nowIso) {
        await database.run('UPDATE email_change_otps SET consumed_at=? WHERE id=?', [nowIso, otp.id]);
        return { kind: 'expired' as const };
      }
      if (otp.attempts >= OTP_MAX_ATTEMPTS) return { kind: 'locked' as const };
      if (!safeEqual(otp.code_hash, hashOtp(email, parsed.data.code))) {
        const attempts = otp.attempts + 1;
        await database.run('UPDATE email_change_otps SET attempts=?,consumed_at=? WHERE id=?',
          [attempts, attempts >= OTP_MAX_ATTEMPTS ? nowIso : null, otp.id]);
        return { kind: attempts >= OTP_MAX_ATTEMPTS ? 'locked' as const : 'invalid' as const };
      }
      if (isPostgres) await database.get('SELECT pg_advisory_xact_lock(hashtext(?)) AS locked', [`email-change:${email}`]);
      const collision = await database.get<{ id: string }>('SELECT id FROM users WHERE lower(email)=lower(?) AND id<>?', [email, user.id]);
      if (collision) return { kind: 'exists' as const };
      const consumed = await database.run('UPDATE email_change_otps SET consumed_at=? WHERE id=? AND consumed_at IS NULL', [nowIso, otp.id]);
      if (!consumed.changes) return { kind: 'invalid' as const };
      const updated = await database.run('UPDATE users SET email=?,updated_at=? WHERE id=? AND lower(email)=lower(?)',
        [email, nowIso, user.id, user.email]);
      if (!updated.changes) return { kind: 'invalid' as const };
      await database.run('UPDATE sessions SET last_seen_at=? WHERE user_id=? AND revoked_at IS NULL', [nowIso, user.id]);
      await database.run('INSERT INTO audit_log(id,user_id,event,details_json,ip_hash,created_at) VALUES(?,?,?,?,?,?)',
        [randomUUID(), user.id, 'email_changed', JSON.stringify({ previousEmail: user.email, email }), hashIp(request.ip), nowIso]);
      return { kind: 'verified' as const };
    });
    if (result.kind === 'exists') return reply.code(409).send({ error: { code: 'EMAIL_IN_USE', message: 'That email address is already associated with an account.' } });
    if (result.kind === 'expired') return reply.code(400).send({ error: { code: 'EXPIRED_CODE', message: 'This code expired. Request a new one.' } });
    if (result.kind === 'locked') return reply.code(429).send({ error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many incorrect codes. Request a new code.' } });
    if (result.kind === 'invalid') return reply.code(400).send({ error: { code: 'INVALID_CODE', message: 'This code is invalid or expired. Request a new one.' } });
    return { ok: true, user: { ...user, email } };
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
