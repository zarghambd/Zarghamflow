import Link from 'next/link';
import type { ReactNode } from 'react';
import './landing.css';

const iconProps = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function CalendarIcon() {
  return <svg {...iconProps}><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>;
}

function TasksIcon() {
  return <svg {...iconProps}><path d="M4 7l2 2 3-4M4 17l2 2 3-4M13 8h7M13 18h7" /></svg>;
}

function ProgressIcon() {
  return <svg {...iconProps}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>;
}

function TeamIcon() {
  return <svg {...iconProps}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.5 3-6 6.5-6s6.5 2.5 6.5 6M16 5a3.5 3.5 0 010 7M18 14c2.5.6 3.5 3 3.5 6" /></svg>;
}

const features: { title: string; text: string; icon: ReactNode }[] = [
  { title: 'Daily Meetings', text: 'Schedule, organize, and review meetings in one place.', icon: <CalendarIcon /> },
  { title: 'Task Management', text: 'Track priorities, deadlines, and progress without the clutter.', icon: <TasksIcon /> },
  { title: 'Daily Progress', text: 'See completed work and outstanding tasks at a glance.', icon: <ProgressIcon /> },
  { title: 'Team Alignment', text: 'Keep meetings, action items, and owners connected.', icon: <TeamIcon /> },
];

const steps = [
  { title: 'Meet', text: 'Schedule your daily meeting and capture decisions as they happen.' },
  { title: 'Assign', text: 'Turn action items into tasks with an owner, a priority and a deadline.' },
  { title: 'Review', text: 'Check daily progress and carry anything unfinished into the next meeting.' },
];

const teamPoints = [
  { initials: 'AK', color: undefined, text: 'Shared workspaces for every team' },
  { initials: 'MR', color: 'var(--tk-av-2)', text: 'Owners and assignees on every task' },
  { initials: 'SL', color: '#5c7dd6', text: 'Meeting notes linked to action items' },
];

function Avatars({ list }: { list: string[] }) {
  return <span className="tk-avatars">{list.map((initials) => <span key={initials} className="tk-avatar">{initials}</span>)}</span>;
}

export default function HomePage() {
  return (
    <>
      <header className="tk-wrap tk-header">
        <Link href="/" className="tk-logo" aria-label="Taskora home">
          <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="9" fill="#0e7c66" />
            <path d="M9 17l5 5 9-12" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Taskora
        </Link>
        <nav className="tk-nav" aria-label="Main navigation">
          <a href="#features">Features</a>
          <a href="#teams">For teams</a>
          <a href="#flow">How it works</a>
        </nav>
        <div className="tk-header-actions">
          <Link href="/signin" className="tk-btn tk-btn--secondary tk-btn--sm">Log in</Link>
          <Link href="/signin" className="tk-btn tk-btn--primary tk-btn--sm">Get started</Link>
        </div>
      </header>

      <main>
        <section className="tk-wrap tk-hero">
          <div className="tk-hero-copy">
            <span className="tk-tag tk-tag--primary">Task tracking for teams</span>
            <h1>Turn plans into progress.</h1>
            <p>Taskora connects your daily meetings, tasks and owners in one shared workspace, so everyone knows what was decided and what is done.</p>
            <div className="tk-cta-row">
              <Link href="/signin" className="tk-btn tk-btn--primary">Start free</Link>
              <a href="#flow" className="tk-btn tk-btn--secondary">See how it works</a>
            </div>
          </div>

          <div className="tk-card tk-preview" aria-label="Product preview">
            <div className="tk-preview-head"><b>Today</b><span className="tk-tag tk-tag--warn">3 of 5 done</span></div>
            <div className="tk-progress tk-progress--spaced"><span style={{ width: '60%' }} /></div>
            <div className="tk-task tk-task--done"><span className="tk-check tk-check--done" /><span>Review sprint goals</span><Avatars list={['AK']} /></div>
            <div className="tk-task tk-task--done"><span className="tk-check tk-check--done" /><span>Send client update</span><Avatars list={['MR']} /></div>
            <div className="tk-task"><span className="tk-check" /><span>Finalize launch checklist</span><span className="tk-tag tk-tag--danger">Due today</span></div>
            <div className="tk-task"><span className="tk-check" /><span>Prep design review</span><Avatars list={['SL']} /></div>
            <div className="tk-meeting">
              <span className="tk-meeting-icon"><CalendarIcon /></span>
              <div><b>Daily stand-up</b><small>10:00 · 3 action items</small></div>
              <Avatars list={['AK', 'MR', 'SL']} />
            </div>
          </div>
        </section>

        <section id="features" className="tk-band">
          <div className="tk-wrap tk-band-content">
            <h2 className="tk-h2">Everything your team needs to stay on track</h2>
            <p className="tk-lead">Four tools that work together, so nothing falls between meetings and to-do lists.</p>
            <div className="tk-grid">
              {features.map((feature) => (
                <article key={feature.title} className="tk-card tk-card--flat tk-feature">
                  <div className="tk-icon-box">{feature.icon}</div>
                  <h3>{feature.title}</h3>
                  <p>{feature.text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="flow" className="tk-wrap tk-steps">
          <h2 className="tk-h2">From meeting to done, in three steps</h2>
          <div className="tk-grid">
            {steps.map((step, index) => (
              <article key={step.title} className="tk-step"><b>{index + 1}</b><h3>{step.title}</h3><p>{step.text}</p></article>
            ))}
          </div>
        </section>

        <div className="tk-wrap" id="teams">
          <section className="tk-team">
            <div>
              <h2 className="tk-h2">Built for the whole team</h2>
              <p>Invite teammates to a shared workspace. Everyone sees the same meetings, tasks and progress, and every task has a clear owner.</p>
            </div>
            <div className="tk-team-list">
              {teamPoints.map((teamPoint) => (
                <div key={teamPoint.initials} className="tk-team-item">
                  <span className="tk-avatars"><span className="tk-avatar" style={teamPoint.color ? { background: teamPoint.color } : undefined}>{teamPoint.initials}</span></span>
                  {teamPoint.text}
                </div>
              ))}
            </div>
          </section>
        </div>

        <section className="tk-wrap tk-final">
          <h2>Ready to turn plans into progress?</h2>
          <p>Create your team workspace in minutes.</p>
          <Link href="/signin" className="tk-btn tk-btn--primary">Get started with Taskora</Link>
        </section>
      </main>

      <footer className="tk-footer">© Taskora. Turn plans into progress.</footer>
    </>
  );
}
