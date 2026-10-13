import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="page-shell">
      <section className="hero card">
        <p className="eyebrow">Migration in progress</p>
        <h1>ZarghamFlow</h1>
        <p>
          This is the first step of the App Router migration. The legacy Fastify backend remains
          in place while the frontend is being migrated to a Next.js structure.
        </p>
        <div className="actions">
          <Link href="/admin" className="primary-btn">Open admin dashboard</Link>
          <a href="http://127.0.0.1:3000/health" className="secondary-btn" target="_blank" rel="noreferrer">
            Check API health
          </a>
        </div>
      </section>

      <section className="grid">
        <article className="card">
          <h2>Current status</h2>
          <ul>
            <li>Fastify server preserved</li>
            <li>SQLite + Drizzle retained</li>
            <li>Magic-link auth retained</li>
            <li>Next.js App Router bootstrapped</li>
          </ul>
        </article>

        <article className="card">
          <h2>Next migration targets</h2>
          <ul>
            <li>Route handlers for auth</li>
            <li>Role-based admin routes</li>
            <li>Session middleware</li>
            <li>Client-side dashboard migration</li>
          </ul>
        </article>
      </section>
    </main>
  );
}
