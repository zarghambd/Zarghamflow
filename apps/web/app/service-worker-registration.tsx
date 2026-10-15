'use client';

import { useEffect } from 'react';

export default function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const url = new URL('/service-worker.js', window.location.origin);
    url.searchParams.set('build', process.env.NEXT_PUBLIC_BUILD_ID ?? 'development');
    void navigator.serviceWorker.register(url).catch((error: unknown) => {
      console.error('Service worker registration failed', error);
    });
  }, []);

  return null;
}
