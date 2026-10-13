import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getAuthRequestIp, hashIp, iso, randomToken, sha256, SESSION_COOKIE, SESSION_MS, cookieOptions, validateCsrfRequest } from '@/lib/auth';
import { sqlite } from '@/lib/db';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const csrfError = validateCsrfRequest(request);
  if (csrfError) return csrfError;

  const data = await request.json().catch(() => ({}));
  const token = typeof data.token === 'string' ? data.token : '';

  if (!token) {
    return NextResponse.json({ error: { code: 'INVALID_TOKEN', message: 'Sign-in link is invalid or expired.' } }, { status: 400 });
  }

  const tokenHash = sha256(token);
  const now = iso(new Date());
  const row = sqlite.prepare("SELECT id,email FROM login_tokens WHERE token_hash = ? AND kind = 'magic_link' AND consumed_at IS NULL AND expires_at > ?")
    .get(tokenHash, now) as { id: string; email: string } | undefined;

  if (!row) {
    return NextResponse.json({ error: { code: 'INVALID_TOKEN', message: 'Sign-in link is invalid or expired.' } }, { status: 400 });
  }

  const rawSession = randomToken(48);
  const sessionId = randomUUID();
  const expiresAt = iso(new Date(Date.now() + SESSION_MS));
  const userAgent = (request.headers.get('user-agent') ?? 'Unknown device').slice(0, 200);
  const ipHash = hashIp(getAuthRequestIp(request));

  const user = sqlite.transaction(() => {
    const current = sqlite.prepare('SELECT id,email,timezone,locale,settings_json,role,active FROM users WHERE email = ? COLLATE NOCASE').get(row.email) as {
      id: string; email: string; timezone: string; locale: string; settings_json: string; role: 'admin' | 'user'; active: number;
    } | undefined;
    if (current && !current.active) return null;

    const consumed = sqlite.prepare('UPDATE login_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?').run(now, row.id, now);
    if (consumed.changes !== 1) return null;

    const hasAdmin = (sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND active=1").get() as { count: number }).count > 0;
    const configuredAdmin = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    let user: { id: string; email: string; role: 'admin' | 'user' };

    if (current) {
      if ((!hasAdmin && !configuredAdmin) || (configuredAdmin && current.email.toLowerCase() === configuredAdmin)) {
        sqlite.prepare("UPDATE users SET role='admin',updated_at=? WHERE id=?").run(now, current.id);
        current.role = 'admin';
      }
      user = current;
    } else {
      const role: 'admin' | 'user' = configuredAdmin ? (row.email.toLowerCase() === configuredAdmin ? 'admin' : 'user') : (!hasAdmin ? 'admin' : 'user');
      const created = {
        id: randomUUID(),
        email: row.email.toLowerCase(),
        timezone: 'UTC',
        locale: 'en-GB',
        settings_json: '{}',
        role,
        active: 1,
        created_at: now,
        updated_at: now
      };

      sqlite.prepare('INSERT INTO users (id,email,timezone,locale,settings_json,role,active,created_at,updated_at) VALUES (@id,@email,@timezone,@locale,@settings_json,@role,@active,@created_at,@updated_at)').run(created);
      sqlite.prepare('INSERT INTO reminder_prefs (user_id,prefs_json,updated_at) VALUES (?,?,?)').run(created.id, JSON.stringify({}), now);
      user = created;
    }

    sqlite.prepare('INSERT INTO sessions (id,user_id,token_hash,device,ip_hash,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(sessionId, user.id, sha256(rawSession), userAgent, ipHash, now, now, expiresAt);
    sqlite.prepare('INSERT INTO audit_log (id,user_id,event,details_json,ip_hash,created_at) VALUES (?,?,?,?,?,?)')
      .run(randomUUID(), user.id, 'sign_in', JSON.stringify({ device: userAgent }), ipHash, now);
    return user;
  })();

  if (!user) {
    return NextResponse.json({ error: { code: 'INVALID_TOKEN', message: 'Sign-in link is invalid or expired.' } }, { status: 400 });
  }

  const response = NextResponse.json({ ok: true, user: { email: user.email, role: user.role }, redirect: '/' });
  const secure = process.env.NODE_ENV === 'production';
  response.cookies.set(SESSION_COOKIE, rawSession, { ...cookieOptions(secure), maxAge: SESSION_MS / 1000 });
  return response;
}
