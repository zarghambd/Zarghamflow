'use client';

import { useEffect } from 'react';

export default function PlannerClient() {
  useEffect(() => {
    void import('../src/main').catch((error: unknown) => {
      console.error('Planner client failed to load.', error);
    });
  }, []);

  return (
    <>
      <div id="app" aria-live="polite" />
      <div id="toast" role="status" aria-live="polite" />
    </>
  );
}