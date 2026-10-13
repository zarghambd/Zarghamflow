import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { cookieOptions, getAuthRequestIp, getAuthUserFromSession, getSessionCookieValue, hashIp, SESSION_COOKIE, SESSION_MS, validateCsrfRequest } from '@/lib/auth';
import { sqlite } from '@/lib/db';

export const runtime = 'nodejs';

type UpdateResult =
  | { error: 'NOT_FOUND' | 'LAST_ADMIN' | 'SELF_DEACTIVATION' }
  | { item: { id: string; email: string; role: 'admin' | 'user'; active: boolean; updatedAt: string } };

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const csrfError = validateCsrfRequest(request);
  if (csrfError) return csrfError;

  const actor = getAuthUserFromSession();
  if (!actor) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required.' } }, { status: 401 });
  }
  if (actor.role !== 'admin') {
    return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'Administrator access required.' } }, { status: 403 });
  }

  const body = await request.json().catch(() => null) as { role?: unknown; active?: unknown } | null;
  if (!body || (body.role !== undefined && body.role !== 'admin' && body.role !== 'user') ||
    (body.active !== undefined && typeof body.active !== 'boolean') ||
    (body.role === undefined && body.active === undefined)) {
    return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'Provide a valid role and/or active status.' } }, { status: 400 });
  }

  const now = new Date().toISOString();
  const result = sqlite.transaction((): UpdateResult => {
    const target = sqlite.prepare('SELECT id,email,role,active FROM users WHERE id = ?').get(params.id) as {
      id: string; email: string; role: 'admin' | 'user'; active: number;
    } | undefined;
    if (!target) return { error: 'NOT_FOUND' };

    const nextRole = (body.role ?? target.role) as 'admin' | 'user';
    const nextActive: boolean = body.active === undefined ? target.active === 1 : body.active as boolean;
    const wouldRemoveAdmin = target.role === 'admin' && target.active === 1 && (nextRole !== 'admin' || !nextActive);
    const activeAdmins = (sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND active=1").get() as { count: number }).count;
    if (wouldRemoveAdmin && activeAdmins <= 1) return { error: 'LAST_ADMIN' };
    if (target.id === actor.id && !nextActive) return { error: 'SELF_DEACTIVATION' };

    sqlite.prepare('UPDATE users SET role = ?, active = ?, updated_at = ? WHERE id = ?')
      .run(nextRole, nextActive ? 1 : 0, now, params.id);
    if (!nextActive) {
      sqlite.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, params.id);
    }
    sqlite.prepare('INSERT INTO audit_log (id,user_id,event,details_json,ip_hash,created_at) VALUES (?,?,?,?,?,?)')
      .run(randomUUID(), actor.id, 'admin_user_updated', JSON.stringify({ targetUserId: params.id, role: nextRole, active: nextActive }), hashIp(getAuthRequestIp(request)), now);

    return { item: { id: params.id, email: target.email, role: nextRole, active: nextActive, updatedAt: now } };
  })();

  if ('error' in result) {
    const errors = {
      NOT_FOUND: { status: 404, message: 'User not found.' },
      LAST_ADMIN: { status: 409, message: 'At least one active administrator must remain.' },
      SELF_DEACTIVATION: { status: 409, message: 'You cannot deactivate your own account.' },
    } as const;
    const detail = errors[result.error];
    return NextResponse.json({ error: { code: result.error, message: detail.message } }, { status: detail.status });
  }

  const response = NextResponse.json(result);
  const rawSession = getSessionCookieValue();
  if (rawSession) {
    response.cookies.set(SESSION_COOKIE, rawSession, {
      ...cookieOptions(process.env.NODE_ENV === 'production'),
      maxAge: SESSION_MS / 1000,
    });
  }
  return response;
}