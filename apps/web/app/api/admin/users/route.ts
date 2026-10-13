import { NextResponse } from 'next/server';
import { cookieOptions, getAuthUserFromSession, getSessionCookieValue, SESSION_COOKIE, SESSION_MS } from '@/lib/auth';
import { sqlite } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const actor = getAuthUserFromSession();
  if (!actor) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required.' } }, { status: 401 });
  }
  if (actor.role !== 'admin') {
    return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'Administrator access required.' } }, { status: 403 });
  }

  const query = new URL(request.url).searchParams;
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  const search = query.get('q');
  const role = query.get('role');
  const active = query.get('active');

  if (search) {
    clauses.push('email LIKE ?');
    params.push(`%${search.slice(0, 100)}%`);
  }
  if (role === 'admin' || role === 'user') {
    clauses.push('role = ?');
    params.push(role);
  }
  if (active === 'true' || active === 'false') {
    clauses.push('active = ?');
    params.push(active === 'true' ? 1 : 0);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const items = sqlite.prepare(`SELECT id,email,role,active,timezone,locale,created_at,updated_at FROM users ${where} ORDER BY created_at DESC LIMIT 500`)
    .all(...params);
  const total = (sqlite.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count;
  const activeAdmins = (sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND active=1").get() as { count: number }).count;
  const response = NextResponse.json({ items, total, activeAdmins, currentUserId: actor.id });
  const rawSession = getSessionCookieValue();
  if (rawSession) {
    response.cookies.set(SESSION_COOKIE, rawSession, {
      ...cookieOptions(process.env.NODE_ENV === 'production'),
      maxAge: SESSION_MS / 1000,
    });
  }
  return response;
}