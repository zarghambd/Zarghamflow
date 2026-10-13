import { NextResponse } from 'next/server';
import { cookieOptions, getAuthUserFromSession, getSessionCookieValue, SESSION_COOKIE, SESSION_MS } from '@/lib/auth';

export const runtime = 'nodejs';

export async function GET() {
  const rawSession = getSessionCookieValue();
  const user = getAuthUserFromSession();

  if (!user) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Sign in required.' } },
      { status: 401 }
    );
  }

  const response = NextResponse.json({
    user: { email: user.email, role: user.role },
  });
  response.cookies.set(SESSION_COOKIE, rawSession, {
    ...cookieOptions(process.env.NODE_ENV === 'production'),
    maxAge: SESSION_MS / 1000,
  });
  return response;
}
