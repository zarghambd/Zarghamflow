'use client';

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
      data?.error?.message ?? 'The sign-in service is temporarily unavailable. Please try again.',
      response.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined
    );
  }
  if (!data) throw new Error('The sign-in service returned an invalid response. Please try again.');
  return data;
}

async function getCsrfToken(): Promise<string> {
  const response = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
  const data = await readApiResponse(response);
  if (typeof data.csrfToken !== 'string') throw new Error('Unable to start a secure sign-in request. Refresh and try again.');
  return data.csrfToken;
}

export default function SignInPage() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const verificationInFlight = useRef(false);

  useEffect(() => {
    if (step !== 'code' || resendCooldown <= 0) return;
    const timer = window.setInterval(() => setResendCooldown((remaining) => Math.max(0, remaining - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [step, resendCooldown > 0]);

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
    if (submitting) return;
    setSubmitting(true);
    setError('');
    setMessage('');
    try {
      const normalizedEmail = email.trim().toLowerCase();
      await postAuth('/api/auth/signup', { email: normalizedEmail });
      setEmail(normalizedEmail);
      setCode('');
      setStep('code');
      setResendCooldown(60);
      setMessage(`If the address is eligible, a sign-in code will arrive shortly.`);
    } catch (requestError) {
      setError((requestError as Error).message);
      if (requestError instanceof ApiResponseError && requestError.status === 429 && requestError.retryAfterSeconds) {
        setResendCooldown(requestError.retryAfterSeconds);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function verifyCode(value: string) {
    if (verificationInFlight.current || value.length !== 6) return;
    verificationInFlight.current = true;
    setSubmitting(true);
    setError('');
    setMessage('');
    try {
      const data = await postAuth('/api/auth/verify', { email, code: value });
      window.location.replace(typeof data.redirect === 'string' ? data.redirect : '/planner');
    } catch (verificationError) {
      const apiError = verificationError as Error;
      setError(apiError.message);
      if (verificationError instanceof ApiResponseError && verificationError.status === 429 && verificationError.retryAfterSeconds) {
        setResendCooldown(verificationError.retryAfterSeconds);
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
    setStep('email');
    setCode('');
    setError('');
    setMessage('');
    setResendCooldown(0);
  }

  return (
    <main className="page-shell signin-shell">
      <section className="card signin-panel">
        <p className="eyebrow">Taskora / Secure access</p>
        <h1>{step === 'email' ? 'Sign in or create an account' : 'Enter your sign-in code'}</h1>
        <p className="signin-copy">
          {step === 'email'
            ? 'Enter your email and we’ll send a 6-digit sign-in code.'
            : <>Enter the 6-digit code sent to <strong>{email}</strong>.</>}
        </p>
        {error && <p id="signin-error" className="admin-alert" role="alert" aria-live="polite">{error}</p>}
        {message && <p className="admin-notice" role="status" aria-live="polite">{message}</p>}
        {step === 'email' ? (
          <form className="signin-form" onSubmit={(event) => void sendCode(event)}>
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
            <button className="primary-btn" type="submit" disabled={submitting}>
              {submitting ? 'Sending…' : 'Send me a sign-in code'}
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
                disabled={submitting}
              />
              <button className="primary-btn" type="submit" disabled={submitting || code.length !== 6}>
                {submitting ? 'Verifying…' : 'Verify code'}
              </button>
            </form>
            <div className="signin-form">
              <button className="primary-btn" type="button" onClick={() => void sendCode()} disabled={submitting || resendCooldown > 0}>
                {resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : 'Resend code'}
              </button>
              <button className="primary-btn" type="button" onClick={changeEmail} disabled={submitting}>
                Change email
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
