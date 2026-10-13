'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';

async function getCsrfToken(): Promise<string> {
  const response = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
  if (!response.ok) throw new Error('Unable to start a secure sign-in request. Refresh and try again.');
  const data = await response.json();
  return data.csrfToken as string;
}

export default function SignInPage() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'checking' | 'form' | 'verifying'>('checking');
  const [submitting, setSubmitting] = useState(false);
  const verificationStarted = useRef(false);

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) {
      setMode('form');
      return;
    }
    if (verificationStarted.current) return;
    verificationStarted.current = true;
    setMode('verifying');

    void (async () => {
      try {
        const csrfToken = await getCsrfToken();
        const response = await fetch('/api/auth/verify', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
          body: JSON.stringify({ token }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message ?? 'This sign-in link is invalid or expired.');
        window.location.replace('/admin');
      } catch (verificationError) {
        window.history.replaceState(null, '', '/signin');
        setError((verificationError as Error).message);
        setMode('form');
      }
    })();
  }, []);

  async function requestLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    setMessage('');
    try {
      const csrfToken = await getCsrfToken();
      const response = await fetch('/api/auth/request', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ email }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? 'Unable to request a sign-in link.');
      setMessage(data.message ?? 'If the address is eligible, a sign-in link will arrive shortly.');
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="page-shell signin-shell">
      <section className="card signin-panel">
        <p className="eyebrow">ZarghamFlow / Secure access</p>
        <h1>{mode === 'verifying' ? 'Verifying your link' : 'Sign in or create an account'}</h1>
        {mode === 'verifying' ? (
          <p className="signin-copy">Checking your one-time sign-in link…</p>
        ) : (
          <>
            <p className="signin-copy">Enter your email and we’ll send a one-time link to continue.</p>
            {error && <p className="admin-alert" role="alert">{error}</p>}
            {message && <p className="admin-notice" role="status">{message}</p>}
            <form className="signin-form" onSubmit={requestLink}>
              <label htmlFor="signin-email">Email address</label>
              <input
                id="signin-email"
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
              <button className="primary-btn" type="submit" disabled={submitting}>
                {submitting ? 'Sending…' : 'Email me a secure link'}
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}