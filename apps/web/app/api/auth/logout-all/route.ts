import { NextResponse } from 'next/server';
import { clearSessionCookie, getSessionCookieValue, iso, sha256, validateCsrfRequest } from '@/lib/auth';
import { sqlite } from '@/lib/db';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const csrfError = validateCsrfRequest(request);
  if (csrfError) return csrfError;

  const rawSession = getSessionCookieValue();
  if (rawSession) {
    const session = sqlite.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND revoked_at IS NULL').get(sha256(rawSession)) as { user_id: string } | undefined;
    if (session) sqlite.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(iso(new Date()), session.user_id);
  }

  const response = NextResponse.json({ ok: true });
  clearSessionCookie();
  response.cookies.set('zf_session', '', { path: '/', maxAge: 0, httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
  return response;
}
