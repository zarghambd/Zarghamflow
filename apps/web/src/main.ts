import { openDB, type DBSchema } from 'idb';
import { DateTime } from 'luxon';
import { meetingInputSchema, taskInputSchema, type ReminderPrefs } from '@zarghamflow/shared';
import './style.css';

type Meeting = { id: string; title: string; date: string; start: string; end: string; client: string; contacts: string; type: string; location: string; notes: string; outcome: string; status: string; followUpDate: string | null; version: number; updatedAt: string };
type Task = { id: string; title: string; dueDate: string; dueTime: string | null; priority: string; status: string; category: string; client: string; meetingId: string | null; notes: string; version: number; updatedAt: string };
type Page<T> = { items: T[]; total: number; limit: number; offset: number };
type OutboxItem = { id: string; method: 'POST' | 'PATCH' | 'DELETE'; url: string; body?: unknown; recordId: string; entity: 'meeting' | 'task'; createdAt: string; baseVersion?: number };
type CachedRecord = (Meeting & { kind: 'meeting' }) | (Task & { kind: 'task' });
type ConflictItem = OutboxItem;
interface OfflineDb extends DBSchema {
  records: { key: string; value: CachedRecord; indexes: { 'by-type': string } };
  outbox: { key: string; value: OutboxItem; indexes: { 'by-created': string } };
  conflicts: { key: string; value: ConflictItem; indexes: { 'by-created': string } };
}

const app = document.querySelector<HTMLDivElement>('#app')!;
const toastEl = document.querySelector<HTMLDivElement>('#toast')!;
const offlineDbPromise = openDB<OfflineDb>('zarghamflow-offline-v1', 1, {
  upgrade(db, oldVersion) {
    if (oldVersion < 1) {
      const records = db.createObjectStore('records', { keyPath: 'id' });
      records.createIndex('by-type', 'kind');
      db.createObjectStore('outbox', { keyPath: 'id' }).createIndex('by-created', 'createdAt');
    }
    if (oldVersion < 2) {
      db.createObjectStore('conflicts', { keyPath: 'id' }).createIndex('by-created', 'createdAt');
    }
  }
});
const state = { view: 'dashboard', user: '', role: 'user', adminUsers: [] as Array<Record<string, unknown>>, meetings: [] as Meeting[], tasks: [] as Task[], search: '', date: DateTime.local().toISODate() ?? '', range: 'all', status: 'all', client: '', type: '', priority: '', category: '', csrf: '', prefs: null as ReminderPrefs | null, sessions: [] as Array<Record<string, unknown>>, reminders: [] as Array<Record<string, unknown>>, online: navigator.onLine, pending: 0, installPrompt: null as BeforeInstallPromptEvent | null, updateAvailable: false, conflicts: [] as string[] };
type BeforeInstallPromptEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
let waitingWorker: ServiceWorker | null = null;

const escapeHtml = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
const toLocalRecord = <T extends Record<string, unknown>>(row: T): T => {
  const names: Record<string, string> = { user_id: 'userId', follow_up_date: 'followUpDate', due_date: 'dueDate', due_time: 'dueTime', meeting_id: 'meetingId', completed_at: 'completedAt', created_at: 'createdAt', updated_at: 'updatedAt', deleted_at: 'deletedAt', reminder_lead_json: 'reminderLeadMinutes', reminderLeadJson: 'reminderLeadMinutes' };
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const converted = names[key] ?? key;
    result[converted] = key === 'reminder_lead_json' || key === 'reminderLeadJson' ? (typeof value === 'string' ? JSON.parse(value) : value) : value;
  }
  return result as T;
};
function notify(message: string): void { toastEl.textContent = message; window.setTimeout(() => { toastEl.textContent = ''; }, 3200); }

async function csrf(): Promise<string> {
  if (!state.csrf) {
    const response = await fetch('/api/v1/auth/csrf', { credentials: 'same-origin' });
    const result = await response.json() as { csrfToken: string };
    state.csrf = result.csrfToken;
  }
  return state.csrf;
}
async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase())) headers.set('x-csrf-token', await csrf());
  const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
  if (response.status === 204) return undefined as T;
  const data = await response.json() as T & { error?: { message?: string; code?: string } };
  if (!response.ok) {
    const error = new Error(data.error?.message ?? `Request failed (${response.status})`);
    (error as Error & { status?: number; code?: string }).status = response.status;
    if (data.error?.code) (error as Error & { status?: number; code?: string }).code = data.error.code;
    throw error;
  }
  return data;
}

async function cacheRecords(): Promise<void> {
  const db = await offlineDbPromise;
  const tx = db.transaction('records', 'readwrite');
  await tx.store.clear();
  for (const item of state.meetings) await tx.store.put({ ...item, kind: 'meeting' });
  for (const item of state.tasks) await tx.store.put({ ...item, kind: 'task' });
  await tx.done;
}
async function loadOffline(): Promise<void> {
  const db = await offlineDbPromise;
  const all = await db.getAll('records');
  state.meetings = all.filter((row) => row.kind === 'meeting') as Meeting[];
  state.tasks = all.filter((row) => row.kind === 'task') as Task[];
  state.pending = await db.count('outbox');
}
async function loadAllRecords(resource: 'meetings'|'tasks'): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let offset = 0, total = 0;
  do {
    const page = await api<Page<Record<string, unknown>>>(`/api/v1/${resource}?limit=100&offset=${offset}`);
    items.push(...page.items);
    total = page.total;
    offset += page.items.length;
  } while (offset < total && offset > 0);
  return items;
}
async function queueOffline(item: OutboxItem, record: Meeting | Task): Promise<void> {
  const db = await offlineDbPromise;
  const tx = db.transaction(['records', 'outbox'], 'readwrite');
  await tx.objectStore('records').put({ ...record, kind: item.entity } as CachedRecord);
  await tx.objectStore('outbox').put(item);
  await tx.done;
  state.pending = await db.count('outbox');
  render();
}
async function refreshData(): Promise<void> {
  if (!navigator.onLine) { await loadOffline(); render(); return; }
  try {
    const [meetingRows, taskRows, dashboard] = await Promise.all([
      loadAllRecords('meetings'),
      loadAllRecords('tasks'),
      api<Record<string, unknown>>('/api/v1/dashboard')
    ]);
    state.meetings = meetingRows.map((row) => toLocalRecord(row) as unknown as Meeting);
    state.tasks = taskRows.map((row) => toLocalRecord(row) as unknown as Task);
    await cacheRecords();
    state.pending = await (await offlineDbPromise).count('outbox');
    render(dashboard);
  } catch (error) {
    if (!navigator.onLine) { await loadOffline(); render(); return; }
    throw error;
  }
}
async function queueOfflineDelete(kind: 'meeting'|'task', id: string): Promise<void> {
  const db = await offlineDbPromise;
  const record = existingRecord(kind, id);
  const item: OutboxItem = { id: crypto.randomUUID(), method: 'DELETE', url: `/api/v1/${kind === 'meeting' ? 'meetings' : 'tasks'}/${id}`, recordId: id, entity: kind, createdAt: new Date().toISOString(), ...(record ? { baseVersion: record.version } : {}) };
  const tx = db.transaction(['records', 'outbox'], 'readwrite');
  await tx.objectStore('records').delete(id);
  await tx.objectStore('outbox').put(item);
  await tx.done;
  if (kind === 'meeting') state.meetings = state.meetings.filter((item) => item.id !== id);
  else state.tasks = state.tasks.filter((item) => item.id !== id);
  state.pending = await db.count('outbox');
  render();
  notify('Delete queued until connection returns.');
}

async function syncOutbox(): Promise<void> {
  if (!navigator.onLine) return;
  const db = await offlineDbPromise;
  const queue = await db.getAllFromIndex('outbox', 'by-created');
  for (const item of queue) {
    try {
      await api(item.url, { method: item.method, ...(item.body ? { body: JSON.stringify(item.body) } : {}), headers: item.baseVersion ? { 'if-match': String(item.baseVersion) } : {} });
      await db.delete('outbox', item.id);
    } catch (error) {
      if ((error as Error & { status?: number }).status === 409) {
        state.conflicts.push(`${item.entity} ${item.recordId}`);
        await db.put('conflicts', item);
        await db.delete('outbox', item.id);
        continue;
      }
      break;
    }
  }
  state.pending = await db.count('outbox');
  if (state.pending === 0) await refreshData(); else render();
}

async function reapplyConflicts(): Promise<void> {
  if (!navigator.onLine) return;
  await refreshData();
  const db = await offlineDbPromise, conflicts = await db.getAllFromIndex('conflicts', 'by-created');
  for (const conflict of conflicts) {
    const current = existingRecord(conflict.entity, conflict.recordId);
    if (!current) continue;
    await db.put('outbox', { ...conflict, id: crypto.randomUUID(), baseVersion: current.version, createdAt: new Date().toISOString() });
    await db.delete('conflicts', conflict.id);
  }
  state.conflicts = [];
  await syncOutbox();
}

function shell(content: string): string {
  const status = !state.online ? 'Offline' : state.pending ? `${state.pending} syncing` : 'Synced';
  const conflictBanner = state.conflicts.length
    ? `<div class="banner" role="alert">A record changed on another device while you were offline. Reapply your local edits after reviewing: ${escapeHtml(state.conflicts.join(', '))}<button class="btn" data-action="retry-conflicts">Reapply edits</button><button class="btn" data-action="clear-conflicts">Dismiss</button></div>`
    : '';
  const navItems = [['dashboard','Dashboard'],['meetings','Meetings'],['tasks','Tasks'],...(state.role==='admin'?[['admin','Users']]:[])];
  return `<header class="topbar"><div class="shell"><div class="topbar-row"><div class="brand"><span class="logo">Z</span> ZarghamFlow</div><div class="row top-actions"><span class="offline ${state.pending || !state.online ? 'pending' : ''}" aria-live="polite">${status}</span><button class="btn primary" data-action="new-meeting">＋ <span class="wide">Meeting</span></button><button class="btn primary" data-action="new-task">＋ <span class="wide">Task</span></button><button class="btn" data-action="settings">Settings</button><button class="icon" data-action="theme" aria-label="Toggle light or dark theme">◐</button><button class="btn ghost" data-action="logout">Sign out</button></div></div><nav class="nav" aria-label="Main navigation">${navItems.map(([id,label])=>`<button class="${state.view===id?'active':''}" data-view="${id}">${label}</button>`).join('')}</nav></div></header><main class="shell">${conflictBanner}${content}</main>${state.installPrompt ? '<button class="btn" data-action="install" style="position:fixed;right:16px;bottom:16px">Install app</button>' : ''}<dialog id="dialog" aria-labelledby="dialog-title"></dialog>`;
}
/*
  await tx.objectStore('outbox').put(item);
  await tx.done;
  if (kind === 'meeting') state.meetings = state.meetings.filter((item) => item.id !== id);
  else state.tasks = state.tasks.filter((item) => item.id !== id);
  state.pending = await db.count('outbox');
  render();
  notify('Delete queued until connection returns.');
}

async function reapplyConflicts(): Promise<void> {
  if (!navigator.onLine) return;
  await refreshData();
  const db = await offlineDbPromise, conflicts = await db.getAllFromIndex('conflicts', 'by-created');
  for (const conflict of conflicts) {
    const current = existingRecord(conflict.entity, conflict.recordId);
    if (!current) continue;
    await db.put('outbox', { ...conflict, id: crypto.randomUUID(), baseVersion: current.version, createdAt: new Date().toISOString() });
    await db.delete('conflicts', conflict.id);
  }
  state.conflicts = [];
  await syncOutbox();
}

function shell(content: string): string {
  const status = !state.online ? 'Offline' : state.pending ? `${state.pending} syncing` : 'Synced';
  const conflictBanner = state.conflicts.length
    ? `<div class="banner" role="alert">A record changed on another device while you were offline. Reapply your local edits after reviewing: ${escapeHtml(state.conflicts.join(', '))}<button class="btn" data-action="retry-conflicts">Reapply edits</button><button class="btn" data-action="clear-conflicts">Dismiss</button></div>`
    : '';
  return `<header class="topbar"><div class="shell"><div class="topbar-row"><div class="brand"><span class="logo">Z</span> ZarghamFlow</div><div class="row top-actions"><span class="offline ${state.pending || !state.online ? 'pending' : ''}" aria-live="polite">${status}</span><button class="btn primary" data-action="new-meeting">＋ <span class="wide">Meeting</span></button><button class="btn primary" data-action="new-task">＋ <span class="wide">Task</span></button><button class="btn" data-action="settings">Settings</button><button class="icon" data-action="theme" aria-label="Toggle light or dark theme">◐</button><button class="btn ghost" data-action="logout">Sign out</button></div></div><nav class="nav" aria-label="Main navigation">${[['dashboard','Dashboard'],['meetings','Meetings'],['tasks','Tasks']].map(([id,label])=>`<button class="${state.view===id?'active':''}" data-view="${id}">${label}</button>`).join('')}</nav></div></header><main class="shell">${conflictBanner}${content}</main>${state.installPrompt ? '<button class="btn" data-action="install" style="position:fixed;right:16px;bottom:16px">Install app</button>' : ''}<dialog id="dialog" aria-labelledby="dialog-title"></dialog>`;
  await tx.objectStore('outbox').put(item);
  await tx.done;
  state.pending = await db.count('outbox');
  state.online = navigator.onLine;
  render();
}
async function syncOutbox(): Promise<void> {
  if (!navigator.onLine) return;
  const db = await offlineDbPromise;
  const queue = await db.getAllFromIndex('outbox', 'by-created');
  if (queue.length) { state.pending = queue.length; render(); }
  for (const item of queue) {
    try {
      await api(item.url, { method: item.method, ...(item.body ? { body: JSON.stringify(item.body) } : {}), headers: item.baseVersion ? { 'if-match': String(item.baseVersion) } : {} });
      await db.delete('outbox', item.id);
    } catch (error) {
      if ((error as Error & { status?: number }).status === 409) {
        state.conflicts.push(`${item.entity} ${item.recordId}`);
        await db.put('conflicts', item);
        await db.delete('outbox', item.id);
          const db = await offlineDbPromise;
          const item: OutboxItem = {
            id: crypto.randomUUID(),
            method: 'DELETE',
            url: `/api/v1/${kind === 'meeting' ? 'meetings' : 'tasks'}/${id}`,
            recordId: id,
            entity: kind,
            createdAt: new Date().toISOString(),
            ...(existingRecord(kind, id) ? { baseVersion: existingRecord(kind, id)!.version } : {})
          };
          const tx = db.transaction(['records', 'outbox'], 'readwrite');
          await tx.objectStore('records').delete(id);
          await tx.objectStore('outbox').put(item);
          await tx.done;
          if (kind === 'meeting') state.meetings = state.meetings.filter((item) => item.id !== id);
          else state.tasks = state.tasks.filter((item) => item.id !== id);
          state.pending = await db.count('outbox');
          render();
          notify('Delete queued until connection returns.');
        }
        async function reapplyConflicts(): Promise<void> {
          if (!navigator.onLine) return;
          await refreshData();
          const db = await offlineDbPromise, conflicts = await db.getAllFromIndex('conflicts', 'by-created');
          for (const conflict of conflicts) {
            const current = existingRecord(conflict.entity, conflict.recordId);
            if (!current) continue;
            await db.put('outbox', { ...conflict, id: crypto.randomUUID(), baseVersion: current.version, createdAt: new Date().toISOString() });
            await db.delete('conflicts', conflict.id);
          }
          state.conflicts = [];
          await syncOutbox();
        }
        continue;
      }
      break;
    }
  }
  state.pending = await db.count('outbox');
  if (state.pending === 0) await refreshData(); else render();
}

function shell(content: string): string {
  const status = !state.online ? 'Offline' : state.pending ? `${state.pending} syncing` : 'Synced';
  const conflictBanner = state.conflicts.length
    ? `<div class="banner" role="alert">A record changed on another device while you were offline. Reapply your local edits after reviewing: ${escapeHtml(state.conflicts.join(', '))}<button class="btn" data-action="retry-conflicts">Reapply edits</button><button class="btn" data-action="clear-conflicts">Dismiss</button></div>`
    : '';
  return `<header class="topbar"><div class="shell"><div class="topbar-row"><div class="brand"><span class="logo">Z</span> ZarghamFlow</div><div class="row top-actions"><span class="offline ${state.pending || !state.online ? 'pending' : ''}" aria-live="polite">${status}</span><button class="btn primary" data-action="new-meeting">＋ <span class="wide">Meeting</span></button><button class="btn primary" data-action="new-task">＋ <span class="wide">Task</span></button><button class="btn" data-action="settings">Settings</button><button class="icon" data-action="theme" aria-label="Toggle light or dark theme">◐</button><button class="btn ghost" data-action="logout">Sign out</button></div></div><nav class="nav" aria-label="Main navigation">${[['dashboard','Dashboard'],['meetings','Meetings'],['tasks','Tasks']].map(([id,label])=>`<button class="${state.view===id?'active':''}" data-view="${id}">${label}</button>`).join('')}</nav></div></header><main class="shell">${conflictBanner}${content}</main>${state.installPrompt ? '<button class="btn" data-action="install" style="position:fixed;right:16px;bottom:16px">Install app</button>' : ''}<dialog id="dialog" aria-labelledby="dialog-title"></dialog>`;
}
*/
function fmtDate(date: string): string { return DateTime.fromISO(date).toLocaleString({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); }
function itemMeeting(m: Meeting): string {
  const overlaps = state.meetings.filter((other) => other.id !== m.id && other.date === m.date && ['Scheduled','Completed'].includes(other.status) && m.start < other.end && other.start < m.end);
  const warning = overlaps.length ? `<div class="banner">Overlaps with ${overlaps.map((item) => escapeHtml(`${item.start} ${item.title}`)).join(', ')}</div>` : '';
  const venue = m.location ? `<span>${escapeHtml(m.location)}</span>` : '';
  return `<article class="item ${m.date===DateTime.local().toISODate()?'today':''}"><div class="time">${escapeHtml(m.start)}<small>– ${escapeHtml(m.end)}</small></div><div class="item-content"><div class="item-title">${escapeHtml(m.title)} <span class="badge blue">${escapeHtml(m.status)}</span> <span class="badge">${escapeHtml(m.type)}</span></div><div class="meta"><span>${escapeHtml(m.client)}</span><span>${escapeHtml(m.contacts)}</span>${venue}<span>${fmtDate(m.date)}</span></div>${warning}${m.notes?`<p>${escapeHtml(m.notes)}</p>`:''}<div class="actions"><button class="btn" data-action="edit-meeting" data-id="${m.id}">Edit</button><button class="btn" data-action="duplicate" data-id="${m.id}">Duplicate</button><button class="btn" data-action="delete-meeting" data-id="${m.id}">Delete</button><a class="btn" href="/api/v1/export.ics">Export ICS</a></div></div></article>`;
}
function itemTask(t: Task): string {
  const today = DateTime.local().toISODate() ?? '';
  const overdue = t.status !== 'Done' && (t.dueDate < today || (t.dueDate === today && !!t.dueTime && t.dueTime < DateTime.local().toFormat('HH:mm')));
  const meeting = state.meetings.find((item) => item.id === t.meetingId);
  return `<article class="item ${overdue?'overdue':''} ${t.status==='Done'?'done':''}"><input type="checkbox" aria-label="Mark ${escapeHtml(t.title)} done" data-action="done" data-id="${t.id}" ${t.status==='Done'?'checked':''}><div class="item-content"><div class="item-title">${escapeHtml(t.title)} <span class="badge ${t.priority==='High'?'red':''}">${escapeHtml(t.priority)}</span><span class="badge">${escapeHtml(t.category)}</span><span class="badge ${t.status==='Done'?'green':''}">${escapeHtml(t.status)}</span></div><div class="meta"><span>${overdue?'Overdue · ':''}${fmtDate(t.dueDate)}${t.dueTime?` ${escapeHtml(t.dueTime)}`:''}</span><span>${escapeHtml(t.client)}</span>${meeting?`<span>Meeting: ${escapeHtml(meeting.title)}</span>`:''}</div>${t.notes?`<p>${escapeHtml(t.notes)}</p>`:''}<div class="actions"><button class="btn" data-action="edit-task" data-id="${t.id}">Edit</button><button class="btn" data-action="delete-task" data-id="${t.id}">Delete</button></div></div></article>`;
}
function quickAdd(): string { return `<form class="quick" data-form="quick"><input name="text" maxlength="500" placeholder="Send proposal to Acme tomorrow 14:00 !high #proposal" aria-label="Quick add task"><button class="btn primary">Add task</button></form>`; }
function parseQuickOffline(input: string): Record<string, unknown> {
  let title=input, dueDate=DateTime.local().toISODate()??'', dueTime:string|null=null, priority='Medium', category='Other';
  title=title.replace(/\s!(high|h|medium|med|m|low|l)\b/i,(_all,raw:string)=>{priority=/^h/i.test(raw)?'High':/^l/i.test(raw)?'Low':'Medium';return '';});
  title=title.replace(/\s#([a-z-]+)\b/i,(_all,raw:string)=>{const match=['Prospecting','Proposal','Follow-up','Admin','Other'].find((item)=>item.toLowerCase().replace(/[^a-z]/g,'').startsWith(raw.toLowerCase().replace(/[^a-z]/g,'')));if(match)category=match;return match?'':_all;});
  const today=DateTime.local();
  title=title.replace(/\bin\s+(\d{1,3})\s+days?\b/i,(_all,count:string)=>{dueDate=today.plus({days:Number(count)}).toISODate()??dueDate;return '';});
  title=title.replace(/\b(today|tomorrow|tmr|tmrw)\b/i,(raw)=>{dueDate=today.plus({days:/^today$/i.test(raw)?0:1}).toISODate()??dueDate;return '';});
  title=title.replace(/\b(\d{4}-\d{2}-\d{2})\b/,(raw)=>{if(DateTime.fromISO(raw).isValid)dueDate=raw;return '';});
  title=title.replace(/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{4}))?\b/,(_all,day:string,month:string,year:string|undefined)=>{let parsed=DateTime.fromObject({year:Number(year??today.year),month:Number(month),day:Number(day)});if(parsed.isValid&&!year&&parsed<today.startOf('day'))parsed=parsed.plus({years:1});if(parsed.isValid)dueDate=parsed.toISODate()??dueDate;return '';});
  const weekdayMap:Record<string,number>={sun:7,sunday:7,mon:1,monday:1,tue:2,tues:2,tuesday:2,wed:3,wednesday:3,thu:4,thur:4,thurs:4,thursday:4,fri:5,friday:5,sat:6,saturday:6};
  title=title.replace(/\b(?:next\s+)?(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/i,(_all,day:string)=>{let diff=(weekdayMap[day.toLowerCase()]!-today.weekday+7)%7;if(!diff)diff=7;dueDate=today.plus({days:diff}).toISODate()??dueDate;return '';});
  title=title.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/,(_all,h:string,m:string)=>{dueTime=`${h.padStart(2,'0')}:${m}`;return '';}).replace(/\s+/g,' ').trim();
  return {title,dueDate,dueTime,priority,status:'To Do',category,client:'',meetingId:null,notes:''};
}
function dashboard(data?: Record<string, unknown>): string {
  const counters = (data?.counters ?? {}) as Record<string, number>;
  const today = DateTime.local().toISODate();
  const selected = state.date;
  const meetings = state.meetings.filter((item) => item.date === selected).sort((a,b)=>a.start.localeCompare(b.start));
  const tasks = state.tasks.filter((item) => item.dueDate === selected).sort((a,b)=>(a.dueTime??'99:99').localeCompare(b.dueTime??'99:99'));
  const currentWeek = DateTime.fromISO(selected).startOf('week').toISODate() ?? '';
  const week = [...Array(7)].map((_,index)=>DateTime.fromISO(currentWeek).plus({days:index}).toISODate() ?? '');
  const overdue = (data?.overdue as Record<string, unknown>[] | undefined)?.map((item)=>toLocalRecord(item) as unknown as Task) ?? state.tasks.filter((item)=>item.status!=='Done'&&item.dueDate<today!);
  return `<div class="page-head"><h1>Dashboard</h1><div class="row"><button class="btn" data-action="day-prev" aria-label="Previous day">‹</button><span class="badge">${selected===today?'Today':fmtDate(selected)}</span><button class="btn" data-action="day-next" aria-label="Next day">›</button><button class="btn" data-action="day-today" ${selected===today?'disabled':''}>Today</button><input type="date" data-role="jump-date" value="${selected}" aria-label="Jump to date" style="width:auto"></div></div><section class="grid"><div class="stat"><strong>${counters.meetingsThisWeek ?? state.meetings.length}</strong><span>Meetings this week</span></div><div class="stat"><strong>${counters.openTasks ?? state.tasks.filter(t=>t.status!=='Done').length}</strong><span>Open tasks</span></div><div class="stat ${counters.overdue?'alert':''}"><strong>${counters.overdue ?? overdue.length}</strong><span>Overdue</span></div><div class="stat"><strong>${counters.completedThisWeek ?? 0}</strong><span>Completed this week</span></div></section><div style="height:15px"></div>${quickAdd()}${overdue.length?`<section class="panel"><div class="section-head"><h2>Overdue tasks</h2></div><div class="items">${overdue.map(itemTask).join('')}</div></section>`:''}<section class="grid two"><div class="panel"><div class="section-head"><h2>Meetings</h2><button class="btn" data-action="new-meeting">＋ Add</button></div><div class="items">${meetings.length?meetings.map(itemMeeting).join(''):'<div class="empty">No meetings on this date</div>'}</div></div><div class="panel"><div class="section-head"><h2>Tasks due</h2><button class="btn" data-action="new-task">＋ Add</button></div><div class="items">${tasks.length?tasks.map(itemTask).join(''):'<div class="empty">No tasks due on this date</div>'}</div></div></section><section class="panel"><div class="section-head"><h2>Week at a glance</h2><button class="btn" data-action="week-prev" aria-label="Previous week">‹</button><button class="btn" data-action="week-next" aria-label="Next week">›</button></div><div class="week">${week.map((date)=>`<div class="week-day ${date===today?'today':''} ${date===selected?'selected':''}" data-date="${date}" role="button" tabindex="0"><strong>${DateTime.fromISO(date).toFormat('ccc d')}</strong><small>${state.meetings.filter(m=>m.date===date).length} meetings</small><small>${state.tasks.filter(t=>t.dueDate===date&&t.status!=='Done').length} tasks due</small></div>`).join('')}</div></section>`;
}
function listView(kind: 'meetings'|'tasks'): string {
  const isMeetings = kind==='meetings';
  const q = state.search.toLowerCase();
  const today = DateTime.local().toISODate() ?? '';
  const weekStart = DateTime.local().startOf('week').toISODate() ?? today;
  const inRange = (date: string, overdue = false): boolean => {
    if (state.range === 'today') return date === today;
    if (state.range === 'upcoming') return date >= today;
    if (state.range === 'past') return date < today;
    if (state.range === 'week') return date >= weekStart && date <= DateTime.fromISO(weekStart).plus({ days: 6 }).toISODate()!;
    if (state.range === 'overdue') return overdue;
    return true;
  };
  const clients = [...new Set([...state.meetings.map((item) => item.client), ...state.tasks.map((item) => item.client)].filter(Boolean))].sort();
  const meetings = state.meetings.filter((m) => {
    const matchesText = `${m.title} ${m.client} ${m.contacts} ${m.location} ${m.notes} ${m.outcome}`.toLowerCase().includes(q);
    return matchesText && (!state.client || m.client === state.client) && (!state.status || state.status === 'all' || m.status === state.status) && (!state.type || m.type === state.type) && inRange(m.date);
  }).sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start));
  const tasks = state.tasks.filter((t) => {
    const overdue = t.status !== 'Done' && (t.dueDate < today || (t.dueDate === today && !!t.dueTime && t.dueTime < DateTime.local().toFormat('HH:mm')));
    const matchesText = `${t.title} ${t.client} ${t.notes}`.toLowerCase().includes(q);
    const matchesStatus = !state.status || state.status === 'all' || (state.status === 'open' ? t.status !== 'Done' : t.status === state.status);
    return matchesText && matchesStatus && (!state.client || t.client === state.client) && (!state.priority || t.priority === state.priority) && (!state.category || t.category === state.category) && inRange(t.dueDate, overdue);
  }).sort((a,b)=>a.dueDate.localeCompare(b.dueDate)||(a.dueTime??'99:99').localeCompare(b.dueTime??'99:99'));
  const rangeOptions = [['all','All dates'],['upcoming','Upcoming'],['today','Today'],['week','This week'],['past','Past'],...(!isMeetings?[['overdue','Overdue']]:[])];
  const statusOptions = isMeetings ? ['all','Scheduled','Completed','Cancelled','Rescheduled'] : ['all','open','To Do','In Progress','Done'];
  const modeFilters = isMeetings
    ? `<select id="type-filter" aria-label="Filter by meeting type"><option value="">All types</option>${['Call','Video','In-person','Lunch','Conference'].map((item)=>`<option value="${item}" ${state.type===item?'selected':''}>${item}</option>`).join('')}</select>`
    : `<select id="priority-filter" aria-label="Filter by priority"><option value="">All priorities</option>${['High','Medium','Low'].map((item)=>`<option value="${item}" ${state.priority===item?'selected':''}>${item}</option>`).join('')}</select><select id="category-filter" aria-label="Filter by category"><option value="">All categories</option>${['Prospecting','Proposal','Follow-up','Admin','Other'].map((item)=>`<option value="${item}" ${state.category===item?'selected':''}>${item}</option>`).join('')}</select>`;
  const list = isMeetings ? meetings : tasks;
  const renderedItems = isMeetings ? meetings.map(itemMeeting).join('') : tasks.map(itemTask).join('');
  return `<div class="page-head"><h1>${isMeetings?'Meetings':'Tasks'}</h1><button class="btn primary" data-action="new-${isMeetings?'meeting':'task'}">＋ New ${isMeetings?'meeting':'task'}</button></div>${!isMeetings?quickAdd():''}<div class="filters"><input class="search" id="search" value="${escapeHtml(state.search)}" placeholder="Search title, client, notes…" aria-label="Search ${kind}"><select id="range" aria-label="Filter by date">${rangeOptions.map(([value,label])=>`<option value="${value}" ${state.range===value?'selected':''}>${label}</option>`).join('')}</select><select id="status" aria-label="Filter by status">${statusOptions.map((value)=>`<option value="${value}" ${state.status===value?'selected':''}>${value==='all'?'All statuses':value==='open'?'Open':value}</option>`).join('')}</select><select id="client-filter" aria-label="Filter by client"><option value="">All clients</option>${clients.map((client)=>`<option value="${escapeHtml(client)}" ${state.client===client?'selected':''}>${escapeHtml(client)}</option>`).join('')}</select>${modeFilters}<button class="btn" data-action="export-json">Export JSON</button><button class="btn" data-action="reset-filters">Reset filters</button></div><div class="meta" style="margin-bottom:10px">${list.length} ${kind}</div><div class="items">${renderedItems||`<div class="empty">No ${kind} match these filters.</div>`}</div>`;
}
function render(dashboardData?: Record<string, unknown>): void {
  if (!state.user) { renderSignIn(); return; }
  app.innerHTML = shell(state.view==='dashboard'?dashboard(dashboardData):state.view==='settings'?settingsView():state.view==='admin'&&state.role==='admin'?adminView():listView(state.view as 'meetings'|'tasks'));
  if (state.updateAvailable) {
    const banner = document.createElement('div');
    banner.className = 'banner row';
    banner.setAttribute('role', 'status');
    banner.innerHTML = '<span>New version available.</span><button class="btn" data-action="refresh-app">Refresh</button>';
    app.querySelector('main')?.prepend(banner);
  }
  document.documentElement.dataset.theme = localStorage.getItem('zf-theme') ?? 'light';
  const dialog = document.querySelector<HTMLDialogElement>('#dialog');
  if (dialog && !dialog.open) dialog.addEventListener('close', () => { document.body.style.overflow = ''; });
}
function renderSignIn(message = ''): void {
  app.innerHTML = `<main class="shell"><section class="panel signin"><div class="brand"><span class="logo">Z</span> ZarghamFlow</div><h1>Sign in or create account</h1><p>Enter your email and we’ll send a one-time link to verify it and continue.</p>${message?`<div class="banner">${escapeHtml(message)}</div>`:''}<form data-form="signin"><div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required><button class="btn primary" style="margin-top:10px">Email me a secure link</button></div></form></section></main>`;
}
function adminView(): string {
  const query=state.search.trim().toLowerCase();
  const users=state.adminUsers.filter((item)=>String(item.email).toLowerCase().includes(query));
  const activeAdmins=state.adminUsers.filter((item)=>item.role==='admin'&&item.active===1).length;
  return `<div class="page-head"><h1>User administration</h1><span class="badge">${state.adminUsers.length} accounts</span></div><section class="panel"><div class="section-head"><h2>Accounts</h2><span class="meta">${activeAdmins} active administrator${activeAdmins===1?'':'s'}</span></div><input class="search" id="admin-search" value="${escapeHtml(state.search)}" placeholder="Search email…" aria-label="Search users"><div class="items" style="margin-top:12px">${users.map((user)=>`<article class="item"><div class="item-content"><div class="item-title">${escapeHtml(user.email)} ${user.id===state.adminUsers.find((row)=>row.email===state.user)?.id?'<span class="badge blue">You</span>':''}</div><div class="meta"><span class="badge">${escapeHtml(user.role)}</span><span class="badge ${user.active===1?'green':'red'}">${user.active===1?'Active':'Disabled'}</span><span>Joined ${escapeHtml(String(user.created_at??'').slice(0,10))}</span></div></div><div class="actions"><button class="btn" data-action="user-role" data-id="${escapeHtml(user.id)}" data-role="${user.role==='admin'?'user':'admin'}">Make ${user.role==='admin'?'user':'admin'}</button><button class="btn ${user.active===1?'danger':''}" data-action="user-active" data-id="${escapeHtml(user.id)}" data-active="${user.active===1?'false':'true'}">${user.active===1?'Disable':'Enable'}</button></div></article>`).join('')||'<div class="empty">No accounts match this search.</div>'}</div></section>`;
}
async function loadAdminUsers():Promise<void>{const response=await api<{items:Array<Record<string,unknown>>}>('/api/v1/admin/users');state.adminUsers=response.items;}
function settingsView(): string {
  return `<div class="page-head"><h1>Settings</h1><button class="btn" data-action="test-reminder">Send test reminder</button></div><section class="panel"><div class="section-head"><h2>Reminder delivery</h2></div><p class="meta">Email destination: ${escapeHtml(state.user)} · timezone ${escapeHtml(Intl.DateTimeFormat().resolvedOptions().timeZone)}</p><div class="divider"></div><form data-form="prefs" class="fields"><div class="field"><label>Task lead times (minutes, comma separated)</label><input name="taskLeadMinutes" value="${escapeHtml(state.prefs?.taskLeadMinutes.join(',')??'1440,60')}"></div><div class="field"><label>Meeting lead times (minutes)</label><input name="meetingLeadMinutes" value="${escapeHtml(state.prefs?.meetingLeadMinutes.join(',')??'60,15')}"></div><div class="field"><label>Quiet hours start</label><input name="quietStart" type="time" value="${escapeHtml(state.prefs?.quietStart??'')}"></div><div class="field"><label>Quiet hours end</label><input name="quietEnd" type="time" value="${escapeHtml(state.prefs?.quietEnd??'')}"></div><label><input type="checkbox" name="emailEnabled" ${state.prefs?.emailEnabled!==false?'checked':''}> Email reminders</label><label><input type="checkbox" name="pushEnabled" ${state.prefs?.pushEnabled!==false?'checked':''}> Push reminders</label><label><input type="checkbox" name="overdueEnabled" ${state.prefs?.overdueEnabled!==false?'checked':''}> Overdue nudges</label><label><input type="checkbox" name="digestEnabled" ${state.prefs?.digestEnabled?'checked':''}> Morning digest</label><div class="field"><label>Digest time</label><input name="digestTime" type="time" value="${escapeHtml(state.prefs?.digestTime??'08:00')}"></div><div class="field full"><button class="btn primary">Save reminder settings</button></div></form></section><section class="panel"><div class="section-head"><h2>Install and sync</h2><button class="btn" data-action="install">Install app</button></div><div class="row"><button class="btn" data-action="enable-push">Enable push notifications</button><button class="btn" data-action="export-json">Export JSON backup</button><button class="btn" data-action="import-json">Import backup</button><button class="btn" data-action="export-csv">Export CSV</button><button class="btn" data-action="export-ics">Export ICS</button></div><div class="divider"></div><h3>Active devices</h3><div class="items">${state.sessions.map((row)=>`<div class="item"><div class="item-content">${escapeHtml(row.device)} · last used ${escapeHtml(row.last_seen_at)}</div>${row.current?'Current':''}</div>`).join('')}</div><button class="btn danger" data-action="logout-all">Sign out everywhere</button></section><section class="panel"><div class="section-head"><h2>Reminder log</h2></div><div class="items">${state.reminders.slice(0,30).map((row)=>`<div class="item"><div class="item-content">${escapeHtml(row.target_type)} · ${escapeHtml(row.state)} · ${escapeHtml(row.fire_at)} ${row.last_error?`· ${escapeHtml(row.last_error)}`:''}</div></div>`).join('')||'<div class="empty">No reminders logged yet</div>'}</div></section><input id="backup-file" type="file" accept="application/json" hidden></section>`;
}

async function openForm(kind: 'meeting'|'task', existing?: Meeting|Task): Promise<void> {
  const dialog = document.querySelector<HTMLDialogElement>('#dialog');
  if (!dialog) return;
  const meeting = kind==='meeting', record = existing as Meeting & Task;
  const defaults = meeting ? { title:'', date:state.date, start:'09:00', end:'10:00', client:'', contacts:'', type:'Video', location:'', notes:'', outcome:'', status:'Scheduled', followUpDate:null } : { title:'', dueDate:state.date, dueTime:null, priority:'Medium', status:'To Do', category:'Other', client:'', meetingId:null, notes:'' };
  const value = { ...defaults, ...record } as Record<string, unknown>;
  const fields = meeting ? `<div class="field full"><label>Title</label><input name="title" required maxlength="200" value="${escapeHtml(value.title)}"></div><div class="field"><label>Date</label><input name="date" type="date" required value="${escapeHtml(value.date)}"></div><div class="field"><label>Start (24-hour)</label><input name="start" type="time" required value="${escapeHtml(value.start)}"></div><div class="field"><label>End</label><input name="end" type="time" required value="${escapeHtml(value.end)}"></div><div class="field"><label>Client</label><input name="client" value="${escapeHtml(value.client)}"></div><div class="field"><label>Contacts</label><input name="contacts" value="${escapeHtml(value.contacts)}"></div><div class="field"><label>Type</label><select name="type">${['Call','Video','In-person','Lunch','Conference'].map((item)=>`<option ${value.type===item?'selected':''}>${item}</option>`).join('')}</select></div><div class="field"><label>Status</label><select name="status">${['Scheduled','Completed','Cancelled','Rescheduled'].map((item)=>`<option ${value.status===item?'selected':''}>${item}</option>`).join('')}</select></div><div class="field full"><label>Location / link</label><input name="location" value="${escapeHtml(value.location)}"></div><div class="field full"><label>Agenda / notes</label><textarea name="notes">${escapeHtml(value.notes)}</textarea></div><div class="field full"><label>Outcome / next steps</label><textarea name="outcome">${escapeHtml(value.outcome)}</textarea></div><div class="field"><label>Follow-up</label><input name="followUpDate" type="date" value="${escapeHtml(value.followUpDate)}"></div>` : `<div class="field full"><label>Title</label><input name="title" required maxlength="200" value="${escapeHtml(value.title)}"></div><div class="field"><label>Due date</label><input name="dueDate" type="date" required value="${escapeHtml(value.dueDate)}"></div><div class="field"><label>Due time</label><input name="dueTime" type="time" value="${escapeHtml(value.dueTime)}"></div><div class="field"><label>Priority</label><select name="priority">${['High','Medium','Low'].map((item)=>`<option ${value.priority===item?'selected':''}>${item}</option>`).join('')}</select></div><div class="field"><label>Status</label><select name="status">${['To Do','In Progress','Done'].map((item)=>`<option ${value.status===item?'selected':''}>${item}</option>`).join('')}</select></div><div class="field"><label>Category</label><select name="category">${['Prospecting','Proposal','Follow-up','Admin','Other'].map((item)=>`<option ${value.category===item?'selected':''}>${item}</option>`).join('')}</select></div><div class="field"><label>Client</label><input name="client" value="${escapeHtml(value.client)}"></div><div class="field"><label>Related meeting</label><select name="meetingId"><option value="">None</option>${state.meetings.map((item)=>`<option value="${item.id}" ${value.meetingId===item.id?'selected':''}>${escapeHtml(`${item.date} ${item.start} · ${item.title}`)}</option>`).join('')}</select></div><div class="field full"><label>Notes</label><textarea name="notes">${escapeHtml(value.notes)}</textarea></div>`;
  dialog.innerHTML = `<div class="dialog-head"><h2 id="dialog-title">${existing?'Edit':'New'} ${meeting?'meeting':'task'}</h2><button class="icon" type="button" data-action="close-dialog" aria-label="Close">×</button></div><form class="dialog-body" data-form="record"><div class="fields">${fields}</div><div class="dialog-actions"><button class="btn" type="button" data-action="close-dialog">Cancel</button><button class="btn primary">${existing?'Save changes':'Create'}</button></div></form>`;
  dialog.dataset.kind=kind; dialog.dataset.id=existing?.id??'';
  const override = value.reminderLeadMinutes;
  const overrideValue = override === null ? 'none' : Array.isArray(override) ? (override as number[]).join(',') : 'default';
  const reminderField = document.createElement('div');
  reminderField.className = 'field full';
  const standardLeads = ['default','none','15','30','60','1440','60,15','1440,60'];
  const choices = standardLeads.includes(overrideValue) ? standardLeads : [...standardLeads, overrideValue];
  reminderField.innerHTML = `<label for="reminder-override">Reminders</label><select id="reminder-override" name="reminderOverride">${choices.map((choice)=>`<option value="${choice}" ${overrideValue===choice?'selected':''}>${choice==='default'?'Use account defaults':choice==='none'?'No reminders':`${choice.split(',').map((minutes)=>`${Number(minutes)>=60?`${Number(minutes)/60}h`:`${minutes}m`}`).join(' and ')} before`}</option>`).join('')}</select>`;
  dialog.querySelector('.fields')?.append(reminderField);
  if (meeting) {
    const hint = document.createElement('div');
    hint.className = 'field full';
    hint.id = 'overlap-hint';
    dialog.querySelector('.fields')?.append(hint);
    const updateOverlap = (): void => {
      const form = dialog.querySelector<HTMLFormElement>('form');
      const date = form?.querySelector<HTMLInputElement>('[name="date"]')?.value ?? '';
      const start = form?.querySelector<HTMLInputElement>('[name="start"]')?.value ?? '';
      const end = form?.querySelector<HTMLInputElement>('[name="end"]')?.value ?? '';
      const status = form?.querySelector<HTMLSelectElement>('[name="status"]')?.value ?? 'Scheduled';
      const overlaps = state.meetings.filter((item)=>item.id!==existing?.id&&item.date===date&&['Scheduled','Completed'].includes(item.status)&&['Scheduled','Completed'].includes(status)&&start<item.end&&item.start<end);
      hint.innerHTML = overlaps.length ? `<div class="banner" role="alert">Overlaps with ${overlaps.map((item)=>`${escapeHtml(item.start)} ${escapeHtml(item.title)}`).join(', ')}</div>` : '';
    };
    dialog.querySelector('form')?.addEventListener('input',updateOverlap);
    dialog.querySelector('form')?.addEventListener('change',updateOverlap);
    updateOverlap();
  }
  dialog.showModal(); dialog.querySelector<HTMLInputElement>('input[name="title"]')?.focus();
}
function existingRecord(kind: 'meeting'|'task', id: string): Meeting|Task|undefined {
  return kind==='meeting' ? state.meetings.find((item)=>item.id===id) : state.tasks.find((item)=>item.id===id);
}
function formData(form: HTMLFormElement): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of new FormData(form).entries()) {
    if (key === 'reminderOverride') {
      if (value === 'none') result.reminderLeadMinutes = null;
      else if (value !== 'default') result.reminderLeadMinutes = String(value).split(',').map(Number);
      continue;
    }
    result[key] = value || null;
  }
  for (const checkbox of form.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) result[checkbox.name] = checkbox.checked;
  return result;
}
async function saveRecord(kind: 'meeting'|'task', id: string, input: Record<string, unknown>): Promise<void> {
  const schema = kind==='meeting'?meetingInputSchema:taskInputSchema;
  const clean = schema.safeParse(input);
  if (!clean.success) { notify(clean.error.issues[0]?.message ?? 'Please check the form.'); return; }
  const url = `/api/v1/${kind==='meeting'?'meetings':'tasks'}${id?`/${id}`:''}`;
  const method = id?'PATCH':'POST';
  if (!navigator.onLine) {
    const now = new Date().toISOString(), record = { ...input, id:id||crypto.randomUUID(), createdAt:now, updatedAt:now, version:1 } as unknown as Meeting|Task;
    const item: OutboxItem = { id:crypto.randomUUID(), method, url, body:clean.data, recordId:record.id, entity:kind, createdAt:now, ...(id ? {baseVersion:(existingRecord(kind,id)?.version??1)} : {}) };
    await queueOffline(item,record); notify('Saved offline. It will sync when you reconnect.'); return;
  }
  try { await api(url,{method,body:JSON.stringify(clean.data)}); notify(`${kind==='meeting'?'Meeting':'Task'} saved.`); await refreshData(); }
  catch (error) { notify((error as Error).message); }
}
async function handleAction(element: HTMLElement): Promise<void> {
  const action=element.dataset.action,id=element.dataset.id;
  if(action==='new-meeting') return openForm('meeting');
  if(action==='new-task') return openForm('task');
  if(action==='edit-meeting'&&id){const row=state.meetings.find(x=>x.id===id);if(row)return openForm('meeting',row);}
  if(action==='edit-task'&&id){const row=state.tasks.find(x=>x.id===id);if(row)return openForm('task',row);}
  if(action==='close-dialog'){document.querySelector<HTMLDialogElement>('#dialog')?.close();return;}
  if(action==='theme'){const theme=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=theme;localStorage.setItem('zf-theme',theme);return;}
  if(action==='day-prev'){state.date=DateTime.fromISO(state.date).minus({days:1}).toISODate()??state.date;render();return;}
  if(action==='day-next'){state.date=DateTime.fromISO(state.date).plus({days:1}).toISODate()??state.date;render();return;}
  if(action==='day-today'){state.date=DateTime.local().toISODate()??state.date;render();return;}
  if(action==='week-prev'){state.date=DateTime.fromISO(state.date).minus({weeks:1}).toISODate()??state.date;render();return;}
  if(action==='week-next'){state.date=DateTime.fromISO(state.date).plus({weeks:1}).toISODate()??state.date;render();return;}
  if(action==='pick-day'&&element.dataset.date){state.date=element.dataset.date;render();return;}
  if(action==='refresh-app'){if(waitingWorker)waitingWorker.postMessage({type:'SKIP_WAITING'});else location.reload();return;}
  if(action==='reset-filters'){state.search='';state.range='all';state.status='all';state.client='';state.type='';state.priority='';state.category='';render();return;}
  if(action==='clear-conflicts'){state.conflicts=[];render();return;}
  if(action==='retry-conflicts'){await reapplyConflicts();return;}
  if(action==='logout'||action==='logout-all'){await api(`/api/v1/auth/${action==='logout'?'logout':'logout-all'}`,{method:'POST',body:'{}'});state.user='';renderSignIn('Signed out.');return;}
  if(action==='delete-meeting'&&id||action==='delete-task'&&id){if(!confirm('Delete this item?'))return;const kind=action==='delete-meeting'?'meeting':'task';if(!navigator.onLine){await queueOfflineDelete(kind,id);return;}try{await api(`/api/v1/${kind==='meeting'?'meetings':'tasks'}/${id}`,{method:'DELETE'});await refreshData();}catch(error){notify((error as Error).message);}return;}
  if(action==='duplicate'&&id){try{await api(`/api/v1/meetings/${id}/duplicate`,{method:'POST',body:'{}'});await refreshData();notify('Meeting duplicated.');}catch(error){notify((error as Error).message);}return;}
  if(action==='done'&&id){const task=state.tasks.find((row)=>row.id===id);if(task)await saveRecord('task',id,{title:task.title,dueDate:task.dueDate,dueTime:task.dueTime,priority:task.priority,status:task.status==='Done'?'To Do':'Done',category:task.category,client:task.client,meetingId:task.meetingId,notes:task.notes,completedAt:task.status==='Done'?null:new Date().toISOString()});return;}
  if(action==='settings'){state.view='settings';try{const [prefs,sessions,reminders]=await Promise.all([api<{prefs:ReminderPrefs}>('/api/v1/reminder-preferences'),api<{items:Array<Record<string,unknown>>}>('/api/v1/auth/sessions'),api<{items:Array<Record<string,unknown>>}>('/api/v1/reminders')]);state.prefs=prefs.prefs;state.sessions=sessions.items;state.reminders=reminders.items;}catch(error){notify((error as Error).message);}render();return;}
  if(action==='user-role'&&id&&state.role==='admin'){try{await api(`/api/v1/admin/users/${id}`,{method:'PATCH',body:JSON.stringify({role:element.dataset.role})});await loadAdminUsers();render();notify('User role updated.');}catch(error){notify((error as Error).message);}return;}
  if(action==='user-active'&&id&&state.role==='admin'){try{await api(`/api/v1/admin/users/${id}`,{method:'PATCH',body:JSON.stringify({active:element.dataset.active==='true'})});await loadAdminUsers();render();notify('User status updated.');}catch(error){notify((error as Error).message);}return;}
  if(action==='test-reminder'){try{await api('/api/v1/reminders/test',{method:'POST',body:'{}'});notify('Test reminder sent.');}catch(error){notify((error as Error).message);}return;}
  if(action==='enable-push'){await enablePush();return;}
  if(action==='export-json'){if(!navigator.onLine){download('zarghamflow-backup.json',JSON.stringify({app:'zarghamflow',version:1,exportedAt:new Date().toISOString(),meetings:state.meetings,tasks:state.tasks},null,2),'application/json');return;}const result=await api<unknown>('/api/v1/export.json');download('zarghamflow-backup.json',JSON.stringify(result,null,2),'application/json');return;}
  if(action==='export-csv'){const kind=state.view==='tasks'?'tasks':state.view==='meetings'?'meetings':(prompt('Export meetings or tasks as CSV?','meetings')??'').trim().toLowerCase();if(kind!=='meetings'&&kind!=='tasks')return;if(navigator.onLine){window.location.href=`/api/v1/export.csv?kind=${kind}`;return;}exportOfflineCsv(kind);return;}
  if(action==='export-ics'){if(navigator.onLine){window.location.href='/api/v1/export.ics';return;}exportOfflineIcs();return;}
  if(action==='import-json'){document.querySelector<HTMLInputElement>('#backup-file')?.click();return;}
  if(action==='install'&&state.installPrompt){await state.installPrompt.prompt();state.installPrompt=null;render();}
}
function download(name:string,data:string,mime:string):void{const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([data],{type:mime}));link.download=name;link.click();URL.revokeObjectURL(link.href);}
function exportOfflineCsv(kind:'meetings'|'tasks'):void{
  const rows:unknown[][]=kind==='meetings'?[['Title','Date','Start','End','Client','Contacts','Type','Location','Notes','Outcome','Status','Follow-up'],...state.meetings.map((m)=>[m.title,m.date,m.start,m.end,m.client,m.contacts,m.type,m.location,m.notes,m.outcome,m.status,m.followUpDate])]:[['Title','Due date','Due time','Priority','Status','Category','Client','Meeting','Notes'],...state.tasks.map((t)=>[t.title,t.dueDate,t.dueTime,t.priority,t.status,t.category,t.client,state.meetings.find((m)=>m.id===t.meetingId)?.title??'',t.notes])];
  const cell=(value:unknown)=>`"${String(value??'').replace(/^[=+\-@\t\r]/,"'").replace(/"/g,'""')}"`;
  download(`zarghamflow-${kind}.csv`,'\uFEFF'+rows.map((row)=>row.map(cell).join(',')).join('\r\n'),'text/csv;charset=utf-8');
}
function exportOfflineIcs():void{
  const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d+Z$/,'Z');
  const esc=(value:string)=>value.replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\r?\n/g,'\\n');
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//ZarghamFlow//EN'];
  state.meetings.filter((m)=>m.status==='Scheduled'&&m.date>=(DateTime.local().toISODate()??'')).forEach((m)=>lines.push('BEGIN:VEVENT',`UID:${m.id}@zarghamflow`,`DTSTAMP:${stamp}`,`DTSTART:${m.date.replace(/-/g,'')}T${m.start.replace(':','')}00`,`DTEND:${m.date.replace(/-/g,'')}T${m.end.replace(':','')}00`,`SUMMARY:${esc(m.title)}`,`LOCATION:${esc(m.location)}`,`DESCRIPTION:${esc(m.notes)}`,'END:VEVENT'));
  lines.push('END:VCALENDAR');download('zarghamflow-meetings.ics',lines.join('\r\n')+'\r\n','text/calendar;charset=utf-8');
}
async function enablePush():Promise<void>{
  if(!('serviceWorker' in navigator)||!('PushManager' in window)){notify('Push notifications are not supported in this browser.');return;}
  try{const key=await api<{publicKey:string}>('/api/v1/push/public-key');const registration=await navigator.serviceWorker.ready;const subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:Uint8Array.from(atob(key.publicKey.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))});await api('/api/v1/push/subscribe',{method:'POST',body:JSON.stringify(subscription)});notify('Push notifications enabled.');}catch(error){notify((error as Error).message);}
}
async function handleSubmit(form:HTMLFormElement):Promise<void>{
  const kind=form.dataset.form;
  if(kind==='signin'){const data=formData(form);await api('/api/v1/auth/signup',{method:'POST',body:JSON.stringify(data)});renderSignIn('If the address is eligible, a sign-in link will arrive shortly.');return;}
  if(kind==='record'){const dialog=document.querySelector<HTMLDialogElement>('#dialog');const record=formData(form);const kind=dialog?.dataset.kind as 'meeting'|'task';const id=dialog?.dataset.id??'';if(!kind)return;await saveRecord(kind,id,record);dialog?.close();render();return;}
  if(kind==='quick'){const text=String(formData(form).text??'').trim();if(!text)return;if(!navigator.onLine){const parsed=parseQuickOffline(text);if(!parsed.title){notify('Please enter a task title.');return;}await saveRecord('task','',parsed);return;}try{await api('/api/v1/tasks/quick-add',{method:'POST',body:JSON.stringify({text})});await refreshData();notify('Task added.');}catch(error){notify((error as Error).message);}return;}
  if(kind==='prefs'){const data=formData(form);const numbers=(value:unknown)=>String(value??'').split(',').map(v=>Number(v.trim())).filter(Number.isFinite);try{const prefs=await api<{prefs:ReminderPrefs}>('/api/v1/reminder-preferences',{method:'PUT',body:JSON.stringify({taskLeadMinutes:numbers(data.taskLeadMinutes),meetingLeadMinutes:numbers(data.meetingLeadMinutes),quietStart:data.quietStart,quietEnd:data.quietEnd,emailEnabled:data.emailEnabled,pushEnabled:data.pushEnabled,overdueEnabled:data.overdueEnabled,digestEnabled:data.digestEnabled,digestTime:data.digestTime,followUpEnabled:true})});state.prefs=prefs.prefs;notify('Reminder settings saved.');render();}catch(error){notify((error as Error).message);}return;}
}
async function importBackup(file:File):Promise<void>{try{const parsed=JSON.parse(await file.text()) as {meetings?:unknown[];tasks?:unknown[]};const mode=confirm('Replace all server records with this backup? Choose Cancel to merge it with your current records.');await api('/api/v1/import',{method:'POST',body:JSON.stringify({mode:mode?'replace':'merge',data:{meetings:parsed.meetings??[],tasks:parsed.tasks??[]}})});await refreshData();notify(mode?'Backup replaced server records.':'Backup merged.');}catch(error){notify((error as Error).message);}}
async function consumeMagicLink():Promise<void>{const token=new URL(location.href).searchParams.get('token');if(!token)return;try{await api('/api/v1/auth/verify',{method:'POST',body:JSON.stringify({token})});history.replaceState({},'',location.pathname);await bootstrap();}catch(error){renderSignIn((error as Error).message);}}
async function bootstrap():Promise<void>{try{await csrf();const me=await api<{user:{email:string;role:'admin'|'user'}}>('/api/v1/auth/me');state.user=me.user.email;state.role=me.user.role;localStorage.setItem('zf-owner-email',state.user);localStorage.setItem('zf-owner-role',state.role);await refreshData();await syncOutbox();void api('/api/v1/settings/timezone',{method:'POST',body:JSON.stringify({timezone:Intl.DateTimeFormat().resolvedOptions().timeZone})}).catch((error:unknown)=>console.error('Timezone sync failed',error));}catch{if(!navigator.onLine&&localStorage.getItem('zf-owner-email')){state.user=localStorage.getItem('zf-owner-email')??'';state.role=(localStorage.getItem('zf-owner-role') as 'admin'|'user')??'user';await loadOffline();render();}else{state.user='';renderSignIn();}}}

app.addEventListener('click',(event)=>{const target=event.target;if(!(target instanceof Element))return;const button=target.closest<HTMLElement>('[data-action]');if(button)void handleAction(button);const nav=target.closest<HTMLElement>('[data-view]');if(nav){state.view=nav.dataset.view??'dashboard';state.search='';if(state.view==='admin'&&state.role==='admin')void loadAdminUsers().then(()=>render()).catch((error:unknown)=>notify((error as Error).message));else{render();if(state.view!=='settings')void refreshData();}}});
app.addEventListener('submit',(event)=>{if(!(event.target instanceof HTMLFormElement))return;event.preventDefault();void handleSubmit(event.target);});
app.addEventListener('input',(event)=>{const target=event.target;if(target instanceof HTMLInputElement&&(target.id==='search'||target.id==='admin-search')){state.search=target.value;const y=window.scrollY;render();const search=document.querySelector<HTMLInputElement>(`#${target.id}`);if(search){search.focus();search.setSelectionRange(state.search.length,state.search.length);}window.scrollTo(0,y);}});
app.addEventListener('change',(event)=>{const target=event.target;if(target instanceof HTMLInputElement&&target.id==='backup-file'&&target.files?.[0])void importBackup(target.files[0]);if(target instanceof HTMLInputElement&&target.dataset.role==='jump-date'&&target.value){state.date=target.value;render();}if(target instanceof HTMLSelectElement){if(target.id==='range')state.range=target.value;if(target.id==='status')state.status=target.value;if(target.id==='client-filter')state.client=target.value;if(target.id==='type-filter')state.type=target.value;if(target.id==='priority-filter')state.priority=target.value;if(target.id==='category-filter')state.category=target.value;if(['range','status','client-filter','type-filter','priority-filter','category-filter'].includes(target.id))render();}});
app.addEventListener('click',(event)=>{const target=event.target;if(target instanceof Element){const day=target.closest<HTMLElement>('.week-day[data-date]');if(day?.dataset.date){state.date=day.dataset.date;render();}}});
document.addEventListener('keydown',(event)=>{if(event.key==='Escape')document.querySelector<HTMLDialogElement>('#dialog')?.close();const target=event.target;if(target instanceof HTMLElement&&target.matches('.week-day[data-date]')&&(event.key==='Enter'||event.key===' ')){event.preventDefault();state.date=target.dataset.date??state.date;render();return;}if(event.ctrlKey||event.metaKey)return;if(event.key.toLowerCase()==='n'&&!['INPUT','TEXTAREA','SELECT'].includes((event.target as HTMLElement).tagName))void openForm('meeting');if(event.key.toLowerCase()==='t'&&!['INPUT','TEXTAREA','SELECT'].includes((event.target as HTMLElement).tagName))void openForm('task');if(event.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes((event.target as HTMLElement).tagName)){event.preventDefault();document.querySelector<HTMLInputElement>('#search')?.focus();}});
window.addEventListener('online',()=>{state.online=true;void syncOutbox();});window.addEventListener('offline',()=>{state.online=false;render();});
window.addEventListener('beforeinstallprompt',(event)=>{event.preventDefault();state.installPrompt=event as BeforeInstallPromptEvent;render();});
if('serviceWorker'in navigator){
  navigator.serviceWorker.addEventListener('controllerchange',()=>location.reload());
  void navigator.serviceWorker.register('/service-worker.js').then((registration)=>{
    const checkWaiting=()=>{if(registration.waiting&&navigator.serviceWorker.controller){waitingWorker=registration.waiting;state.updateAvailable=true;render();}};
    checkWaiting();
    registration.addEventListener('updatefound',()=>{
      const worker=registration.installing;
      worker?.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)checkWaiting();});
    });
  }).catch((error:unknown)=>console.error('Service worker registration failed',error));
}

async function initializePlanner(): Promise<void> {
  await consumeMagicLink();
  if (!new URL(location.href).searchParams.has('token')) await bootstrap();
}

void initializePlanner();
