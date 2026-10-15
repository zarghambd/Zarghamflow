import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { sqlite } from './db';

export const SESSION_COOKIE = 'zf_session';
export const CSRF_COOKIE = 'zf_csrf';
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export const iso = (date: Date): string => date.toISOString();
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
export const hashIp = (ip: string): string => createHmac('sha256', process.env.LOGIN_SECRET ?? 'development-login-secret').update(ip).digest('hex');

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validateCsrfRequest(request: Request): NextResponse | null {
  const cookieHeader = request.headers.get('cookie') ?? '';
  const csrfCookie = cookieHeader
    .split(';')
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${CSRF_COOKIE}=`))
    ?.slice(CSRF_COOKIE.length + 1);
  const headerToken = request.headers.get('x-csrf-token') ?? '';

  if (csrfCookie && headerToken && safeEqual(csrfCookie, headerToken)) {
    return null;
  }

  return NextResponse.json(
    { error: { code: 'CSRF_INVALID', message: 'Request verification failed. Refresh and retry.' } },
    { status: 403 }
  );
}

export function cookieOptions(secure: boolean) {
  return { path: '/', httpOnly: true, secure, sameSite: 'lax' as const };
}

export function getSessionCookieValue() {
  const cookieStore = cookies();
  return cookieStore.get(SESSION_COOKIE)?.value ?? '';
}

export function setSessionCookie(value: string) {
  const secure = process.env.NODE_ENV === 'production';
  const cookieStore = cookies();
  cookieStore.set(SESSION_COOKIE, value, { ...cookieOptions(secure), maxAge: SESSION_MS / 1000 });
}

export function clearSessionCookie() {
  const secure = process.env.NODE_ENV === 'production';
  const cookieStore = cookies();
  cookieStore.set(SESSION_COOKIE, '', { ...cookieOptions(secure), maxAge: 0 });
}

export function setCsrfCookie(value: string) {
  const secure = process.env.NODE_ENV === 'production';
  const cookieStore = cookies();
  cookieStore.set(CSRF_COOKIE, value, { path: '/', httpOnly: false, secure, sameSite: 'lax' as const, maxAge: 60 * 60 });
}

export function clearCsrfCookie() {
  const secure = process.env.NODE_ENV === 'production';
  const cookieStore = cookies();
  cookieStore.set(CSRF_COOKIE, '', { path: '/', httpOnly: false, secure, sameSite: 'lax' as const, maxAge: 0 });
}

export function makeGenericResponse() {
  return NextResponse.json({ ok: true, message: 'If the address is eligible, a sign-in code will arrive shortly.' });
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function getAuthRequestIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  return xff ? xff.split(',')[0]?.trim() || 'unknown' : request.headers.get('x-real-ip') || 'unknown';
}

export function getAuthUserFromSession() {
  const rawSession = getSessionCookieValue();
  if (!rawSession) return null;

  const now = iso(new Date());
  const row = sqlite.prepare(`SELECT sessions.id, sessions.user_id, sessions.token_hash, sessions.expires_at, users.email, users.role, users.active
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.revoked_at IS NULL`).get(sha256(rawSession)) as {
      id: string; user_id: string; token_hash: string; expires_at: string; email: string; role: 'admin' | 'user'; active: number;
    } | undefined;

  if (!row || !row.active || row.expires_at <= now) {
    if (row) sqlite.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(now, row.id);
    return null;
  }

  sqlite.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(now, iso(new Date(Date.now() + SESSION_MS)), row.id);
  return { id: row.user_id, email: row.email, role: row.role, sessionId: row.id };
}
