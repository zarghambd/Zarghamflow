'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useRef, useState } from 'react';

class ApiResponseError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterSeconds?: number) {
    super(message);
  }
}

async function readApiResponse(response: Response) {
  const data = await response.json().catch(() => null) as {
    error?: { message?: string };
    [key: string]: unknown;
  } | null;

  if (!response.ok) {
    const retryAfter = Number(response.headers.get('retry-after'));
    throw new ApiResponseError(
      data?.error?.message ?? 'The authentication service is temporarily unavailable. Please try again.',
      response.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined
    );
  }
  if (!data) throw new Error('The authentication service returned an invalid response. Please try again.');
  return data;
}

async function getCsrfToken(): Promise<string> {
  const response = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
  const data = await readApiResponse(response);
  if (typeof data.csrfToken !== 'string') throw new Error('Unable to start a secure authentication request. Refresh and try again.');
  return data.csrfToken;
}

type AuthMode = 'signup' | 'login';

function formatWait(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) return `${remainingSeconds} second${remainingSeconds === 1 ? '' : 's'}`;
  if (remainingSeconds === 0) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `${minutes} minute${minutes === 1 ? '' : 's'} ${remainingSeconds} second${remainingSeconds === 1 ? '' : 's'}`;
}

export default function AuthForm({ mode }: { mode: AuthMode }) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'details' | 'code'>('details');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [verificationCooldown, setVerificationCooldown] = useState(0);
  const [rateLimited, setRateLimited] = useState(false);
  const [verificationRateLimited, setVerificationRateLimited] = useState(false);
  const verificationInFlight = useRef(false);
  const isSignup = mode === 'signup';

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('error') === 'disabled') {
      setError('Your account has been disabled. Please contact the admin to have your account enabled.');
    }
  }, []);

  useEffect(() => {
    if (resendCooldown <= 0 && verificationCooldown <= 0) return;
    const timer = window.setInterval(() => {
      setResendCooldown((remaining) => Math.max(0, remaining - 1));
      setVerificationCooldown((remaining) => Math.max(0, remaining - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendCooldown > 0, verificationCooldown > 0]);

  async function postAuth(path: string, payload: Record<string, string>) {
    const csrfToken = await getCsrfToken();
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify(payload),
    });
    return readApiResponse(response);
  }

  async function sendCode(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (submitting || resendCooldown > 0) return;
    setSubmitting(true);
    setError('');
    setMessage('');
    setRateLimited(false);
    try {
      const normalizedEmail = email.trim().toLowerCase();
      const payload: Record<string, string> = isSignup
        ? { firstName: firstName.trim(), lastName: lastName.trim(), email: normalizedEmail }
        : { email: normalizedEmail };
      await postAuth(isSignup ? '/api/auth/signup' : '/api/auth/login', payload);
      setEmail(normalizedEmail);
      setCode('');
      setStep('code');
      setResendCooldown(60);
      setMessage(`Enter the verification code sent to ${normalizedEmail}.`);
    } catch (requestError) {
      setError((requestError as Error).message);
      if (requestError instanceof ApiResponseError && requestError.status === 429 && requestError.retryAfterSeconds) {
        setResendCooldown(requestError.retryAfterSeconds);
        setRateLimited(true);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function verifyCode(value: string) {
    if (verificationInFlight.current || verificationCooldown > 0 || value.length !== 6) return;
    verificationInFlight.current = true;
    setSubmitting(true);
    setError('');
    setMessage('');
    setVerificationRateLimited(false);
    try {
      const data = await postAuth('/api/auth/verify', { email, code: value });
      window.location.replace(typeof data.redirect === 'string' ? data.redirect : '/planner');
    } catch (verificationError) {
      setError((verificationError as Error).message);
      if (verificationError instanceof ApiResponseError && verificationError.status === 429 && verificationError.retryAfterSeconds) {
        setVerificationCooldown(verificationError.retryAfterSeconds);
        setVerificationRateLimited(true);
      }
    } finally {
      verificationInFlight.current = false;
      setSubmitting(false);
    }
  }

  function updateCode(value: string) {
    const digits = value.replace(/\D/g, '').slice(0, 6);
    setCode(digits);
    setError('');
    if (digits.length === 6) void verifyCode(digits);
  }

  function changeEmail() {
    setStep('details');
    setCode('');
    setError('');
    setMessage('');
  }

  return (
    <main className="page-shell signin-shell">
      <section className="card signin-panel">
        <p className="eyebrow">Taskora / Secure access</p>
        <h1>{step === 'details' ? (isSignup ? 'Create your account' : 'Sign in') : 'Enter your verification code'}</h1>
        <p className="signin-copy">
          {step === 'details'
            ? isSignup ? 'Enter your name and email to get started.' : 'Enter your account email and we’ll send a 6-digit sign-in code.'
            : <>Enter the 6-digit code sent to <strong>{email}</strong>.</>}
        </p>
        {error && <p id="signin-error" className="admin-alert" role="alert" aria-live="polite">
          {rateLimited && resendCooldown > 0
            ? `Please wait ${formatWait(resendCooldown)} before requesting another code.`
            : verificationRateLimited && verificationCooldown > 0
              ? `Please wait ${formatWait(verificationCooldown)} before trying the code again.`
              : error}
        </p>}
        {message && <p className="admin-notice" role="status" aria-live="polite">{message}</p>}
        {step === 'details' ? (
          <form className="signin-form" onSubmit={(event) => void sendCode(event)}>
            {isSignup && <>
              <label htmlFor="signup-first-name">First name</label>
              <input id="signup-first-name" name="firstName" autoComplete="given-name" value={firstName} onChange={(event) => setFirstName(event.target.value)} required maxLength={100} disabled={submitting} />
              <label htmlFor="signup-last-name">Last name</label>
              <input id="signup-last-name" name="lastName" autoComplete="family-name" value={lastName} onChange={(event) => setLastName(event.target.value)} required maxLength={100} disabled={submitting} />
            </>}
            <label htmlFor="signin-email">Email address</label>
            <input
              id="signin-email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              maxLength={254}
              disabled={submitting}
            />
            <button className="primary-btn" type="submit" disabled={submitting || resendCooldown > 0}>
              {submitting ? 'Sending…' : resendCooldown > 0 ? `Try again in ${formatWait(resendCooldown)}` : isSignup ? 'Sign Up' : 'Send me a sign-in code'}
            </button>
          </form>
        ) : (
          <>
            <form className="signin-form" onSubmit={(event) => { event.preventDefault(); void verifyCode(code); }}>
              <label htmlFor="signin-code">6-digit code</label>
              <input
                id="signin-code"
                name="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                pattern="[0-9]{6}"
                value={code}
                onChange={(event) => updateCode(event.target.value)}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'signin-error' : undefined}
                required
                disabled={submitting || verificationCooldown > 0}
              />
              <button className="primary-btn" type="submit" disabled={submitting || verificationCooldown > 0 || code.length !== 6}>
                {submitting ? 'Verifying…' : verificationCooldown > 0 ? `Try again in ${formatWait(verificationCooldown)}` : 'Verify code'}
              </button>
            </form>
            <div className="signin-form">
              <button className="primary-btn" type="button" onClick={() => void sendCode()} disabled={submitting || resendCooldown > 0}>
                {resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : 'Resend code'}
              </button>
              <button className="secondary-btn" type="button" onClick={changeEmail} disabled={submitting}>Change email</button>
            </div>
          </>
        )}
        <p className="signin-copy">
          {isSignup ? <>Already registered? <Link href="/login">Sign in</Link></> : <>New to Taskora? <Link href="/signup">Create an account</Link></>}
        </p>
      </section>
    </main>
  );
}
