'use client';

import { FormEvent, useEffect, useState } from 'react';

type AdminUser = {
  id: string;
  email: string;
  role: 'admin' | 'user';
  active: number;
  created_at: string;
  updated_at: string;
};

type UserList = {
  items: AdminUser[];
  total: number;
  activeAdmins: number;
  currentUserId: string;
};

type Filters = { q: string; role: string; active: string };

async function fetchUsers(filters: Filters): Promise<UserList> {
  const query = new URLSearchParams();
  if (filters.q) query.set('q', filters.q);
  if (filters.role) query.set('role', filters.role);
  if (filters.active) query.set('active', filters.active);

  const response = await fetch(`/api/admin/users?${query.toString()}`, { credentials: 'same-origin' });
  const data = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(data.error?.message ?? `Request failed (${response.status})`), {
      status: response.status,
      code: data.error?.code,
    });
  }
  return data as UserList;
}

export default function AdminPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [currentUserId, setCurrentUserId] = useState('');
  const [activeAdmins, setActiveAdmins] = useState(0);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState<Filters>({ q: '', role: '', active: '' });
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [activeFilter, setActiveFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [accessStatus, setAccessStatus] = useState<'loading' | 'allowed' | 'unauthorized' | 'forbidden' | 'disabled'>('loading');

  async function loadUsers(nextFilters = filters) {
    setLoading(true);
    setError('');
    try {
      const data = await fetchUsers(nextFilters);
      setUsers(data.items);
      setCurrentUserId(data.currentUserId);
      setActiveAdmins(data.activeAdmins);
      setTotal(data.total);
      setFilters(nextFilters);
      setAccessStatus('allowed');
    } catch (loadError) {
      const status = (loadError as Error & { status?: number }).status;
      const code = (loadError as Error & { code?: string }).code;
      setAccessStatus(code === 'ACCOUNT_DISABLED' ? 'disabled' : status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'allowed');
      setError((loadError as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadUsers({ q: '', role: '', active: '' });
  }, []);

  async function updateUser(user: AdminUser, changes: { role?: 'admin' | 'user'; active?: boolean }) {
    setSavingId(user.id);
    setError('');
    setNotice('');
    try {
      const csrfResponse = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
      const { csrfToken } = await csrfResponse.json();
      const response = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify(changes),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? `Request failed (${response.status})`);
      setNotice(`${user.email} was updated.`);
      await loadUsers(filters);
    } catch (updateError) {
      setError((updateError as Error).message);
    } finally {
      setSavingId('');
    }
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void loadUsers({ q: search.trim(), role: roleFilter, active: activeFilter });
  }

  const accessMessage = accessStatus === 'unauthorized'
    ? 'Sign in with an administrator account to manage users.'
    : accessStatus === 'disabled'
      ? 'Your account has been disabled. Please contact the admin to have your account enabled.'
      : accessStatus === 'forbidden'
        ? 'Your account does not have administrator access.'
      : '';

  return (
    <main className="page-shell admin-shell">
      <header className="admin-heading">
        <div>
          <p className="eyebrow">Taskora / Administration</p>
          <h1>User management</h1>
        </div>
        {accessStatus === 'allowed' && (
          <div className="row">
            <a className="secondary-btn" href="/planner">Open Tasks and Meetings</a>
            <div className="admin-count"><strong>{total}</strong><span>accounts</span></div>
          </div>
        )}
      </header>

      {accessMessage ? (
        <section className="card admin-message" role="status">
          <h2>{accessStatus === 'unauthorized' ? 'Administrator sign-in required' : accessStatus === 'disabled' ? 'Account disabled' : 'Access denied'}</h2>
          <p>{accessMessage}</p>
          <a className="secondary-btn" href="/signin">Go to sign in</a>
        </section>
      ) : (
        <>
          {error && <p className="admin-alert" role="alert">{error}</p>}
          {notice && <p className="admin-notice" role="status">{notice}</p>}

          <section className="card admin-panel" aria-labelledby="accounts-heading">
            <div className="admin-section-heading">
              <div>
                <h2 id="accounts-heading">Accounts</h2>
                <p>{activeAdmins} active administrator{activeAdmins === 1 ? '' : 's'}</p>
              </div>
              <button className="secondary-btn admin-refresh" type="button" onClick={() => void loadUsers()} disabled={loading}>
                {loading ? 'Loading…' : 'Refresh'}
              </button>
            </div>

            <form className="admin-filters" onSubmit={applyFilters}>
              <label className="admin-search">
                <span>Search email</span>
                <input value={search} onChange={(event) => setSearch(event.target.value)} type="search" placeholder="name@example.com" />
              </label>
              <label>
                <span>Role</span>
                <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}>
                  <option value="">All roles</option>
                  <option value="admin">Administrator</option>
                  <option value="user">User</option>
                </select>
              </label>
              <label>
                <span>Status</span>
                <select value={activeFilter} onChange={(event) => setActiveFilter(event.target.value)}>
                  <option value="">All statuses</option>
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </select>
              </label>
              <button className="primary-btn" type="submit" disabled={loading}>Apply filters</button>
            </form>

            <div className="admin-list" aria-live="polite">
              {loading ? <p className="admin-empty">Loading accounts…</p> : users.length === 0 ? (
                <p className="admin-empty">No accounts match these filters.</p>
              ) : users.map((user) => {
                const isActive = user.active === 1;
                const isCurrent = user.id === currentUserId;
                const isLastAdmin = user.role === 'admin' && isActive && activeAdmins <= 1;
                const busy = savingId === user.id;
                return (
                  <article className="admin-user" key={user.id}>
                    <div className="admin-user-info">
                      <div className="admin-user-email">{user.email}{isCurrent && <span className="admin-you">You</span>}</div>
                      <div className="admin-user-meta">
                        <span className={`admin-tag ${user.role === 'admin' ? 'admin-tag-role' : ''}`}>{user.role === 'admin' ? 'Administrator' : 'User'}</span>
                        <span className={`admin-tag ${isActive ? 'admin-tag-active' : 'admin-tag-disabled'}`}>{isActive ? 'Enabled' : 'Disabled'}</span>
                        <span>Joined {new Date(user.created_at).toLocaleDateString()}</span>
                      </div>
                    </div>
                    <div className="admin-user-actions">
                      <button className="secondary-btn" type="button" disabled={busy || isLastAdmin} onClick={() => void updateUser(user, { role: user.role === 'admin' ? 'user' : 'admin' })}>
                        {busy ? 'Saving…' : user.role === 'admin' ? 'Make user' : 'Make admin'}
                      </button>
                      <button className={`secondary-btn ${isActive ? 'admin-danger' : ''}`} type="button" disabled={busy || (isCurrent && isActive) || isLastAdmin} onClick={() => void updateUser(user, { active: !isActive })}>
                        {isActive ? 'Disable' : 'Enable'}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
