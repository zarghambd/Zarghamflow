import { NextResponse } from 'next/server';
import { getAuthUserFromSession, getSessionCookieValue, SESSION_COOKIE, SESSION_MS, cookieOptions } from '@/lib/auth';
import { sqlite } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET() {
  const rawSession = getSessionCookieValue();
  const user = getAuthUserFromSession();

  if (!user || !rawSession) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required.' } }, { status: 401 });
  }

  const rows = sqlite.prepare('SELECT id,device,created_at,last_seen_at,expires_at FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC')
    .all(user.id) as Array<{ id: string; device: string; created_at: string; last_seen_at: string; expires_at: string }>;
  const response = NextResponse.json({ items: rows.map((row) => ({ ...row, current: row.id === user.sessionId })) });
  response.cookies.set(SESSION_COOKIE, rawSession, {
    ...cookieOptions(process.env.NODE_ENV === 'production'),
    maxAge: SESSION_MS / 1000,
  });
  return response;
}