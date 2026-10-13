import { NextResponse } from 'next/server';
import { CSRF_COOKIE, randomToken } from '@/lib/auth';

export const runtime = 'nodejs';

export async function GET() {
  const token = randomToken(24);
  const response = NextResponse.json({ csrfToken: token });
  response.cookies.set(CSRF_COOKIE, token, { path: '/', httpOnly: false, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 60 * 60 });
  return response;
}
