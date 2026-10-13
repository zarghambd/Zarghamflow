import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getAuthRequestIp, hashIp, isValidEmail, makeGenericResponse, randomToken, sha256, validateCsrfRequest } from '@/lib/auth';
import { sqlite } from '@/lib/db';
import { sendMagicLinkEmail } from '@/lib/mailer';

export const runtime = 'nodejs';

const TEN_MINUTES = 10 * 60 * 1000;

export async function POST(request: Request) {
  const csrfError = validateCsrfRequest(request);
  if (csrfError) return csrfError;

  const data = await request.json().catch(() => ({}));
  const email = String(data.email ?? '').trim().toLowerCase();

  if (!email || !isValidEmail(email)) {
    return NextResponse.json({ ok: true, message: 'If the address is eligible, a sign-in link will arrive shortly.' });
  }

  const ipHash = hashIp(getAuthRequestIp(request));
  const nowIso = new Date().toISOString();
  const generic = { ok: true, message: 'If the address is eligible, a sign-in link will arrive shortly.' };

  const recentByIp = sqlite.prepare("SELECT COUNT(*) AS count FROM login_tokens WHERE ip_hash = ? AND kind = 'magic_link' AND created_at > ?").get(ipHash, new Date(Date.now() - 15 * 60_000).toISOString()) as { count: number };
  const recentByAccount = sqlite.prepare("SELECT COUNT(*) AS count FROM login_tokens WHERE email = ? COLLATE NOCASE AND kind = 'magic_link' AND created_at > ?").get(email, new Date(Date.now() - 15 * 60_000).toISOString()) as { count: number };
  const existing = sqlite.prepare('SELECT active FROM users WHERE email = ? COLLATE NOCASE').get(email) as { active: number } | undefined;

  if (recentByIp.count >= 5 || recentByAccount.count >= 5 || existing?.active === 0) {
    return NextResponse.json(generic);
  }

  const rawToken = randomToken(32);
  const tokenHash = sha256(rawToken);
  sqlite.prepare('DELETE FROM login_tokens WHERE expires_at < ? OR consumed_at IS NOT NULL').run(nowIso);
  sqlite.prepare('INSERT INTO login_tokens (id,email,token_hash,kind,expires_at,created_at,ip_hash) VALUES (?,?,?,?,?,?,?)')
    .run(randomUUID(), email, tokenHash, 'magic_link', new Date(Date.now() + TEN_MINUTES).toISOString(), nowIso, ipHash);

  const url = new URL('/signin', process.env.APP_URL ?? 'http://localhost:5173');
  url.searchParams.set('token', rawToken);
  await sendMagicLinkEmail(email, url.toString());

  return NextResponse.json(generic);
}

export async function GET() {
  return makeGenericResponse();
}
