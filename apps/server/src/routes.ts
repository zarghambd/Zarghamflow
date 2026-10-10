import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import {
  importSchema, meetingInputSchema, paginationSchema, reminderPrefsSchema, taskInputSchema
} from '@zarghamflow/shared';
import { DateTime } from 'luxon';
import { db, sqlite } from './db/index.js';
import { meetings, tasks, users } from './db/schema.js';
import { schedulerHeartbeat, scheduleEntityReminders } from './reminders/scheduler.js';
import { config } from './config.js';
import { hashIp, randomToken, sha256 } from './security.js';
import { sendMail } from './mail.js';

const nowIso = (): string => new Date().toISOString();
const failure = (code: string, message: string) => ({ error: { code, message } });
function owner(request: FastifyRequest): { id: string; email: string; role: 'admin'|'user' } {
  if (!request.owner) throw Object.assign(new Error('Sign in required.'), { statusCode: 401, code: 'UNAUTHORIZED' });
  return request.owner;
}
function admin(request: FastifyRequest): { id: string; email: string; role: 'admin'|'user' } {
  const user = owner(request);
  if (user.role !== 'admin') throw Object.assign(new Error('Administrator access required.'), { statusCode: 403, code: 'FORBIDDEN' });
  return user;
}
function createMeetingRecord(input: Record<string, unknown>, userId: string) {
  const stamp = nowIso();
  const { reminderLeadMinutes, ...fields } = input;
  return { ...fields, reminderLeadJson: reminderLeadMinutes === undefined ? null : JSON.stringify(reminderLeadMinutes), id: randomUUID(), userId, createdAt: stamp, updatedAt: stamp, deletedAt: null, version: 1 } as typeof meetings.$inferInsert;
}
function createTaskRecord(input: Record<string, unknown>, userId: string) {
  const stamp = nowIso();
  const { reminderLeadMinutes, ...fields } = input;
  return { ...fields, reminderLeadJson: reminderLeadMinutes === undefined ? null : JSON.stringify(reminderLeadMinutes), id: randomUUID(), userId, createdAt: stamp, updatedAt: stamp, deletedAt: null, version: 1 } as typeof tasks.$inferInsert;
}
function ownsMeeting(userId: string, meetingId: string | null | undefined): boolean {
  if (!meetingId) return true;
  return !!sqlite.prepare('SELECT 1 FROM meetings WHERE id=? AND user_id=? AND deleted_at IS NULL').get(meetingId, userId);
}
function parseOldMeeting(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const parsed = meetingInputSchema.safeParse({
    title: row.title, date: row.date, start: row.start, end: row.end, client: row.client ?? '', contacts: row.contacts ?? '',
    type: row.type ?? 'Video', location: row.location ?? '', notes: row.notes ?? '', outcome: row.outcome ?? '',
    status: row.status ?? 'Scheduled', followUpDate: row.followUpDate ?? row.followUp ?? null,
    reminderLeadMinutes: row.reminderLeadMinutes
  });
  return parsed.success ? parsed.data as Record<string, unknown> : null;
}
function parseOldTask(value: unknown, meetingIds: Map<string, string>): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const parsed = taskInputSchema.safeParse({
    title: row.title, dueDate: row.dueDate, dueTime: row.dueTime || null, priority: row.priority ?? 'Medium', status: row.status ?? 'To Do',
    category: row.category ?? 'Other', client: row.client ?? '', meetingId: row.meetingId ? meetingIds.get(String(row.meetingId)) ?? null : null,
    notes: row.notes ?? '', completedAt: row.completedAt || null, reminderLeadMinutes: row.reminderLeadMinutes
  });
  return parsed.success ? parsed.data as Record<string, unknown> : null;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/admin/users', async (request, reply) => {
    const actor = admin(request);
    const query = request.query as {q?:string; role?:string; active?:string};
    const clauses: string[] = [];
    const params: Array<string|number> = [];
    if (query.q) { clauses.push('email LIKE ?'); params.push(`%${query.q.slice(0,100)}%`); }
    if (query.role === 'admin' || query.role === 'user') { clauses.push('role=?'); params.push(query.role); }
    if (query.active === 'true' || query.active === 'false') { clauses.push('active=?'); params.push(query.active === 'true' ? 1 : 0); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const items = sqlite.prepare(`SELECT id,email,role,active,timezone,locale,created_at,updated_at FROM users ${where} ORDER BY created_at DESC LIMIT 500`).all(...params);
    const total = (sqlite.prepare('SELECT COUNT(*) AS count FROM users').get() as {count:number}).count;
    const activeAdmins = (sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND active=1").get() as {count:number}).count;
    return reply.send({items, total, activeAdmins, currentUserId: actor.id});
  });

  app.patch('/api/v1/admin/users/:id', async (request, reply) => {
    const actor = admin(request), {id} = request.params as {id:string};
    const body = request.body as {role?:unknown; active?:unknown};
    if ((body.role !== undefined && body.role !== 'admin' && body.role !== 'user') || (body.active !== undefined && typeof body.active !== 'boolean') || (body.role === undefined && body.active === undefined)) {
      return reply.code(400).send(failure('VALIDATION_ERROR','Provide a valid role and/or active status.'));
    }
    const target = sqlite.prepare('SELECT id,email,role,active FROM users WHERE id=?').get(id) as {id:string;email:string;role:'admin'|'user';active:number}|undefined;
    if (!target) return reply.code(404).send(failure('NOT_FOUND','User not found.'));
    const nextRole = (body.role ?? target.role) as 'admin'|'user';
    const nextActive = body.active === undefined ? target.active === 1 : body.active;
    const wouldRemoveAdmin = target.role==='admin' && target.active===1 && (nextRole!=='admin' || !nextActive);
    const activeAdmins = (sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND active=1").get() as {count:number}).count;
    if (wouldRemoveAdmin && activeAdmins <= 1) return reply.code(409).send(failure('LAST_ADMIN','At least one active administrator must remain.'));
    if (target.id===actor.id && !nextActive) return reply.code(409).send(failure('SELF_DEACTIVATION','You cannot deactivate your own account.'));
    const now=nowIso();
    sqlite.prepare('UPDATE users SET role=?,active=?,updated_at=? WHERE id=?').run(nextRole,nextActive?1:0,now,id);
    if (!nextActive) sqlite.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(now,id);
    sqlite.prepare('INSERT INTO audit_log(id,user_id,event,details_json,ip_hash,created_at) VALUES(?,?,?,?,?,?)')
      .run(randomUUID(),actor.id,'admin_user_updated',JSON.stringify({targetUserId:id,role:nextRole,active:nextActive}),hashIp(request.ip),now);
    return {item:{id,email:target.email,role:nextRole,active:nextActive,updatedAt:now}};
  });

  app.get('/health', async (_request, reply) => {
    const scheduler = schedulerHeartbeat();
    if (!scheduler.healthy) reply.code(503);
    return { status: scheduler.healthy ? 'ok' : 'degraded', scheduler, time: nowIso() };
  });
  app.get('/api/v1/openapi.json', async () => app.swagger());
  app.get('/api/v1/auth/actions/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const row = sqlite.prepare("SELECT login_tokens.id,login_tokens.target_type,login_tokens.target_id,login_tokens.action,users.id AS user_id FROM login_tokens JOIN users ON lower(users.email)=lower(login_tokens.email) AND users.active=1 WHERE login_tokens.token_hash = ? AND login_tokens.kind = 'action' AND login_tokens.consumed_at IS NULL AND login_tokens.expires_at > ?")
      .get(sha256(token), nowIso()) as { id: string; target_type: string; target_id: string; action: string; user_id:string } | undefined;
    if (!row) return reply.code(400).type('text/plain').send('This action link has expired or was already used.');
    sqlite.prepare('UPDATE login_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(nowIso(), row.id);
    if (row.action === 'done' && row.target_type === 'task') {
      const updated=sqlite.prepare("UPDATE tasks SET status='Done', completed_at=?, updated_at=?, version=version+1 WHERE id=? AND user_id=? AND deleted_at IS NULL").run(nowIso(), nowIso(), row.target_id,row.user_id);
      if(!updated.changes)return reply.code(400).type('text/plain').send('This action link has expired or is no longer valid.');
      sqlite.prepare("UPDATE reminders SET state='cancelled',updated_at=? WHERE user_id=? AND target_type='task' AND target_id=? AND state IN ('pending','failed')").run(nowIso(),row.user_id,row.target_id);
      return reply.type('text/html').send('<main><h1>Task marked done</h1><p>You can close this page.</p></main>');
    }
    if (row.action === 'snooze' && row.target_type === 'task') {
      const fireAt = new Date(Date.now() + 60 * 60_000).toISOString();
      const stamp = nowIso();
      for (const channel of ['email', 'push']) sqlite.prepare("INSERT OR IGNORE INTO reminders (id,user_id,target_type,target_id,fire_at,channel,lead,state,attempts,created_at,updated_at,dedupe_key) SELECT ?,user_id,'task',?,?,?,0,'pending',0,?,?,? FROM tasks WHERE id=? AND user_id=? AND deleted_at IS NULL")
        .run(randomUUID(), row.target_id, fireAt, channel, stamp, stamp, `snooze:${row.id}:${channel}`, row.target_id,row.user_id);
      return reply.type('text/html').send('<main><h1>Reminder snoozed for one hour</h1><p>You can close this page.</p></main>');
    }
    return reply.code(400).type('text/plain').send('Unsupported action.');
  });

  app.get('/api/v1/meetings', async (request, reply) => {
    const user = owner(request);
    const paging = paginationSchema.safeParse(request.query);
    if (!paging.success) return reply.code(400).send(failure('INVALID_QUERY', 'Invalid pagination values.'));
    const query = request.query as Record<string, string | undefined>;
    const clauses = ['user_id = ?', 'deleted_at IS NULL'];
    const params: Array<string | number> = [user.id];
    for (const [key, column] of [['from', 'date >= ?'], ['to', 'date <= ?'], ['client', 'client = ?'], ['status', 'status = ?'], ['type', 'type = ?']] as const) {
      if (query[key]) { clauses.push(column); params.push(query[key]!); }
    }
    if (query.q) { clauses.push('(title LIKE ? OR client LIKE ? OR contacts LIKE ? OR notes LIKE ?)'); const needle = `%${query.q.slice(0, 100)}%`; params.push(needle, needle, needle, needle); }
    const where = clauses.join(' AND ');
    const total = (sqlite.prepare(`SELECT COUNT(*) AS count FROM meetings WHERE ${where}`).get(...params) as { count: number }).count;
    const items = sqlite.prepare(`SELECT * FROM meetings WHERE ${where} ORDER BY date,start LIMIT ? OFFSET ?`).all(...params, paging.data.limit, paging.data.offset);
    return { items, total, ...paging.data };
  });

  app.post('/api/v1/meetings', async (request, reply) => {
    const user = owner(request), parsed = meetingInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(failure('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid meeting.'));
    const row = createMeetingRecord(parsed.data as Record<string, unknown>, user.id);
    await db.insert(meetings).values(row);
    const account = db.select().from(users).where(eq(users.id, user.id)).get();
    const prefsRow = sqlite.prepare('SELECT prefs_json FROM reminder_prefs WHERE user_id=?').get(user.id) as { prefs_json: string } | undefined;
    scheduleEntityReminders(user.id, 'meeting', { ...row, reminderLeadMinutes: parsed.data.reminderLeadMinutes }, account?.timezone ?? 'UTC', JSON.parse(prefsRow?.prefs_json ?? '{}') as Record<string, unknown>);
    return reply.code(201).send({ item: row });
  });

  app.get('/api/v1/meetings/:id', async (request, reply) => {
    const user = owner(request), { id } = request.params as { id: string };
    const item = db.select().from(meetings).where(and(eq(meetings.id, id), eq(meetings.userId, user.id), isNull(meetings.deletedAt))).get();
    return item ? { item } : reply.code(404).send(failure('NOT_FOUND', 'Meeting not found.'));
  });

  app.patch('/api/v1/meetings/:id', async (request, reply) => {
    const user = owner(request), { id } = request.params as { id: string };
    const existing = db.select().from(meetings).where(and(eq(meetings.id, id), eq(meetings.userId, user.id), isNull(meetings.deletedAt))).get();
    if (!existing) return reply.code(404).send(failure('NOT_FOUND', 'Meeting not found.'));
    const expectedVersion = Number(request.headers['if-match']);
    if (Number.isInteger(expectedVersion) && expectedVersion !== existing.version) return reply.code(409).send(failure('VERSION_CONFLICT', 'This meeting changed on another device. Refresh before applying your edit.'));
    const parsed = meetingInputSchema.partial().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(failure('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid meeting.'));
    const currentLeads = existing.reminderLeadJson ? JSON.parse(existing.reminderLeadJson) as number[] | null : undefined;
    const leads = Object.hasOwn(parsed.data, 'reminderLeadMinutes') ? parsed.data.reminderLeadMinutes : currentLeads;
    const row = { ...existing, ...parsed.data, reminderLeadMinutes: leads, updatedAt: nowIso(), version: existing.version + 1 };
    const checked = meetingInputSchema.safeParse(row);
    if (!checked.success) return reply.code(400).send(failure('VALIDATION_ERROR', checked.error.issues[0]?.message ?? 'Invalid meeting.'));
    await db.update(meetings).set({ ...checked.data, reminderLeadJson: leads === undefined ? existing.reminderLeadJson : leads === null ? 'null' : JSON.stringify(leads), updatedAt: row.updatedAt, version: row.version }).where(eq(meetings.id, id));
    const account = db.select().from(users).where(eq(users.id, user.id)).get();
    const prefsRow = sqlite.prepare('SELECT prefs_json FROM reminder_prefs WHERE user_id=?').get(user.id) as { prefs_json: string } | undefined;
    scheduleEntityReminders(user.id, 'meeting', row as Record<string, unknown>, account?.timezone ?? 'UTC', JSON.parse(prefsRow?.prefs_json ?? '{}') as Record<string, unknown>);
    return { item: row };
  });

  app.post('/api/v1/meetings/:id/duplicate', async (request, reply) => {
    const user = owner(request), { id } = request.params as { id: string };
    const old = db.select().from(meetings).where(and(eq(meetings.id, id), eq(meetings.userId, user.id), isNull(meetings.deletedAt))).get();
    if (!old) return reply.code(404).send(failure('NOT_FOUND', 'Meeting not found.'));
    const { id: ignoredId, createdAt: ignoredCreated, updatedAt: ignoredUpdated, deletedAt: ignoredDeleted, version: ignoredVersion, ...copy } = old;
    void ignoredId; void ignoredCreated; void ignoredUpdated; void ignoredDeleted; void ignoredVersion;
    const row = createMeetingRecord({ ...copy, title: `${old.title} (copy)`, status: 'Scheduled', outcome: '' }, user.id);
    await db.insert(meetings).values(row);
    return reply.code(201).send({ item: row });
  });

  app.delete('/api/v1/meetings/:id', async (request, reply) => {
    const user = owner(request), { id } = request.params as { id: string }, now = nowIso();
    const current = sqlite.prepare('SELECT version FROM meetings WHERE id=? AND user_id=? AND deleted_at IS NULL').get(id, user.id) as { version: number } | undefined;
    if (!current) return reply.code(404).send(failure('NOT_FOUND', 'Meeting not found.'));
    const expectedVersion = Number(request.headers['if-match']);
    if (Number.isInteger(expectedVersion) && expectedVersion !== current.version) return reply.code(409).send(failure('VERSION_CONFLICT', 'This meeting changed on another device. Refresh before deleting it.'));
    const result = sqlite.prepare('UPDATE meetings SET deleted_at=?,updated_at=?,version=version+1 WHERE id=? AND user_id=? AND deleted_at IS NULL').run(now, now, id, user.id);
    if (!result.changes) return reply.code(404).send(failure('NOT_FOUND', 'Meeting not found.'));
    sqlite.prepare("UPDATE tasks SET meeting_id=NULL,updated_at=?,version=version+1 WHERE meeting_id=? AND user_id=?").run(now, id, user.id);
    sqlite.prepare("UPDATE reminders SET state='cancelled',updated_at=? WHERE user_id=? AND target_id=? AND state IN ('pending','failed')").run(now, user.id, id);
    return reply.code(204).send();
  });

  app.get('/api/v1/tasks', async (request, reply) => {
    const user = owner(request), paging = paginationSchema.safeParse(request.query);
    if (!paging.success) return reply.code(400).send(failure('INVALID_QUERY', 'Invalid pagination values.'));
    const query = request.query as Record<string, string | undefined>;
    const clauses = ['user_id=?', 'deleted_at IS NULL'];
    const params: Array<string | number> = [user.id];
    for (const [key, column] of [['from', 'due_date >= ?'], ['to', 'due_date <= ?'], ['client', 'client = ?'], ['status', 'status = ?'], ['priority', 'priority = ?'], ['category', 'category = ?']] as const) {
      if (query[key] && !(key === 'status' && query.status === 'open')) { clauses.push(column); params.push(query[key]!); }
    }
    if (query.q) { clauses.push('(title LIKE ? OR client LIKE ? OR notes LIKE ?)'); const needle = `%${query.q.slice(0, 100)}%`; params.push(needle, needle, needle); }
    if (query.status === 'open') clauses.push("status != 'Done'");
    const where = clauses.join(' AND '), total = (sqlite.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE ${where}`).get(...params) as { count: number }).count;
    const items = sqlite.prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY due_date,due_time LIMIT ? OFFSET ?`).all(...params, paging.data.limit, paging.data.offset);
    return { items, total, ...paging.data };
  });

  app.post('/api/v1/tasks', async (request, reply) => {
    const user = owner(request), parsed = taskInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(failure('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid task.'));
    if (!ownsMeeting(user.id, parsed.data.meetingId)) return reply.code(400).send(failure('INVALID_MEETING', 'Related meeting is not available to this account.'));
    const row = createTaskRecord(parsed.data as Record<string, unknown>, user.id);
    await db.insert(tasks).values(row);
    const account = db.select().from(users).where(eq(users.id, user.id)).get();
    const prefsRow = sqlite.prepare('SELECT prefs_json FROM reminder_prefs WHERE user_id=?').get(user.id) as { prefs_json: string } | undefined;
    scheduleEntityReminders(user.id, 'task', { ...row, reminderLeadMinutes: parsed.data.reminderLeadMinutes }, account?.timezone ?? 'UTC', JSON.parse(prefsRow?.prefs_json ?? '{}') as Record<string, unknown>);
    return reply.code(201).send({ item: row });
  });

  app.patch('/api/v1/tasks/:id', async (request, reply) => {
    const user = owner(request), { id } = request.params as { id: string };
    const existing = db.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.userId, user.id), isNull(tasks.deletedAt))).get();
    if (!existing) return reply.code(404).send(failure('NOT_FOUND', 'Task not found.'));
    const expectedVersion = Number(request.headers['if-match']);
    if (Number.isInteger(expectedVersion) && expectedVersion !== existing.version) return reply.code(409).send(failure('VERSION_CONFLICT', 'This task changed on another device. Refresh before applying your edit.'));
    const parsed = taskInputSchema.partial().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(failure('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid task.'));
    const currentLeads = existing.reminderLeadJson ? JSON.parse(existing.reminderLeadJson) as number[] | null : undefined;
    const leads = Object.hasOwn(parsed.data, 'reminderLeadMinutes') ? parsed.data.reminderLeadMinutes : currentLeads;
    const row = { ...existing, ...parsed.data, reminderLeadMinutes: leads, updatedAt: nowIso(), version: existing.version + 1 };
    if (!ownsMeeting(user.id, row.meetingId)) return reply.code(400).send(failure('INVALID_MEETING', 'Related meeting is not available to this account.'));
    const checked = taskInputSchema.safeParse(row);
    if (!checked.success) return reply.code(400).send(failure('VALIDATION_ERROR', checked.error.issues[0]?.message ?? 'Invalid task.'));
    await db.update(tasks).set({ ...checked.data, reminderLeadJson: leads === undefined ? existing.reminderLeadJson : leads === null ? 'null' : JSON.stringify(leads), updatedAt: row.updatedAt, version: row.version }).where(eq(tasks.id, id));
    const account = db.select().from(users).where(eq(users.id, user.id)).get();
    const prefsRow = sqlite.prepare('SELECT prefs_json FROM reminder_prefs WHERE user_id=?').get(user.id) as { prefs_json: string } | undefined;
    scheduleEntityReminders(user.id, 'task', row as Record<string, unknown>, account?.timezone ?? 'UTC', JSON.parse(prefsRow?.prefs_json ?? '{}') as Record<string, unknown>);
    return { item: row };
  });

  app.delete('/api/v1/tasks/:id', async (request, reply) => {
    const user = owner(request), { id } = request.params as { id: string }, now = nowIso();
    const current = sqlite.prepare('SELECT version FROM tasks WHERE id=? AND user_id=? AND deleted_at IS NULL').get(id, user.id) as { version: number } | undefined;
    if (!current) return reply.code(404).send(failure('NOT_FOUND', 'Task not found.'));
    const expectedVersion = Number(request.headers['if-match']);
    if (Number.isInteger(expectedVersion) && expectedVersion !== current.version) return reply.code(409).send(failure('VERSION_CONFLICT', 'This task changed on another device. Refresh before deleting it.'));
    const result = sqlite.prepare('UPDATE tasks SET deleted_at=?,updated_at=?,version=version+1 WHERE id=? AND user_id=? AND deleted_at IS NULL').run(now, now, id, user.id);
    if (!result.changes) return reply.code(404).send(failure('NOT_FOUND', 'Task not found.'));
    sqlite.prepare("UPDATE reminders SET state='cancelled',updated_at=? WHERE user_id=? AND target_id=? AND state IN ('pending','failed')").run(now, user.id, id);
    return reply.code(204).send();
  });

  app.post('/api/v1/tasks/quick-add', async (request, reply) => {
    const user = owner(request), body = request.body as { text?: unknown };
    if (typeof body?.text !== 'string' || !body.text.trim() || body.text.length > 500) return reply.code(400).send(failure('VALIDATION_ERROR', 'Enter a task line of up to 500 characters.'));
    const text = body.text.trim();
    const account = db.select().from(users).where(eq(users.id, user.id)).get();
    const zone = account?.timezone ?? 'UTC';
    const today = DateTime.now().setZone(zone);
    let title = text, dueDate = today.toISODate() ?? '2000-01-01', dueTime: string | null = null;
    let priority = 'Medium', category = 'Other';
    title = title.replace(/\s!(high|h|medium|med|m|low|l)\b/i, (_all, raw: string) => { priority = /^[hl]/i.test(raw) ? (/^h/i.test(raw) ? 'High' : 'Low') : 'Medium'; return ''; });
    title = title.replace(/\s#([a-z-]+)\b/i, (_all, raw: string) => { const match = ['Prospecting','Proposal','Follow-up','Admin','Other'].find((value) => value.toLowerCase().replace(/[^a-z]/g, '').startsWith(raw.toLowerCase().replace(/[^a-z]/g, ''))); if (match) category = match; return match ? '' : _all; });
    title = title.replace(/\bin\s+(\d{1,3})\s+days?\b/i, (_all, count: string) => { dueDate = today.plus({ days: Number(count) }).toISODate() ?? dueDate; return ''; });
    title = title.replace(/\b(today|tomorrow|tmr|tmrw)\b/i, (raw) => { dueDate = today.plus({ days: /^today$/i.test(raw) ? 0 : 1 }).toISODate() ?? dueDate; return ''; });
    title = title.replace(/\b(\d{4}-\d{2}-\d{2})\b/, (raw) => { if (DateTime.fromISO(raw).isValid) dueDate = raw; return ''; });
    title = title.replace(/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{4}))?\b/, (_all, day: string, month: string, year: string | undefined) => {
      let parsed = `${year ?? String(today.year)}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      if (DateTime.fromISO(parsed).setZone(zone).isValid && !year && parsed < (today.toISODate() ?? '')) parsed = `${today.year + 1}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      if (DateTime.fromISO(parsed).isValid) dueDate = parsed;
      return '';
    });
    const weekdays: Record<string, number> = { sun:0, sunday:0, mon:1, monday:1, tue:2, tues:2, tuesday:2, wed:3, wednesday:3, thu:4, thur:4, thurs:4, thursday:4, fri:5, friday:5, sat:6, saturday:6 };
    title = title.replace(/\b(?:next\s+)?(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/i, (_all, dayName: string) => {
      const target = weekdays[dayName.toLowerCase()] ?? today.weekday % 7;
      let difference = (target - (today.weekday % 7) + 7) % 7;
      if (difference === 0) difference = 7;
      dueDate = today.plus({ days: difference }).toISODate() ?? dueDate;
      return '';
    });
    title = title.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/, (_all, h: string, m: string) => { dueTime = `${h.padStart(2, '0')}:${m}`; return ''; }).replace(/\s+/g, ' ').trim();
    const parsed = taskInputSchema.safeParse({ title, dueDate, dueTime, priority, status: 'To Do', category, client: '', meetingId: null, notes: '', completedAt: null });
    if (!parsed.success) return reply.code(400).send(failure('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Could not parse task.'));
    const row = createTaskRecord(parsed.data as Record<string, unknown>, user.id);
    await db.insert(tasks).values(row);
    return reply.code(201).send({ item: row });
  });

  app.get('/api/v1/dashboard', async (request) => {
    const user = owner(request), account = db.select().from(users).where(eq(users.id, user.id)).get();
    const zone = account?.timezone ?? 'UTC', today = DateTime.now().setZone(zone).toISODate() ?? '';
    const weekStart = DateTime.now().setZone(zone).startOf('week').toISODate() ?? today, weekEnd = DateTime.now().setZone(zone).endOf('week').toISODate() ?? today;
    const meetingsToday = sqlite.prepare("SELECT * FROM meetings WHERE user_id=? AND date=? AND deleted_at IS NULL ORDER BY start").all(user.id, today);
    const tasksToday = sqlite.prepare("SELECT * FROM tasks WHERE user_id=? AND due_date=? AND deleted_at IS NULL ORDER BY due_time").all(user.id, today);
    const overdue = sqlite.prepare("SELECT * FROM tasks WHERE user_id=? AND status!='Done' AND due_date<? AND deleted_at IS NULL ORDER BY due_date,due_time").all(user.id, today);
    const counters = {
      meetingsThisWeek: (sqlite.prepare("SELECT COUNT(*) AS count FROM meetings WHERE user_id=? AND date BETWEEN ? AND ? AND status IN ('Scheduled','Completed') AND deleted_at IS NULL").get(user.id, weekStart, weekEnd) as { count: number }).count,
      openTasks: (sqlite.prepare("SELECT COUNT(*) AS count FROM tasks WHERE user_id=? AND status!='Done' AND deleted_at IS NULL").get(user.id) as { count: number }).count,
      overdue: overdue.length,
      completedThisWeek: (sqlite.prepare("SELECT COUNT(*) AS count FROM tasks WHERE user_id=? AND status='Done' AND completed_at BETWEEN ? AND ? AND deleted_at IS NULL").get(user.id, weekStart, weekEnd + 'T23:59:59.999Z') as { count: number }).count
    };
    const weekMeetings = sqlite.prepare("SELECT * FROM meetings WHERE user_id=? AND date BETWEEN ? AND ? AND deleted_at IS NULL ORDER BY date,start").all(user.id, weekStart, weekEnd);
    const weekTasks = sqlite.prepare("SELECT * FROM tasks WHERE user_id=? AND due_date BETWEEN ? AND ? AND status!='Done' AND deleted_at IS NULL ORDER BY due_date,due_time").all(user.id, weekStart, weekEnd);
    return { date: today, timezone: zone, counters, meetingsToday, tasksToday, overdue, weekMeetings, weekTasks };
  });

  app.get('/api/v1/reminder-preferences', async (request) => {
    const user = owner(request);
    const row = sqlite.prepare('SELECT prefs_json FROM reminder_prefs WHERE user_id=?').get(user.id) as { prefs_json: string } | undefined;
    return { prefs: reminderPrefsSchema.parse(JSON.parse(row?.prefs_json ?? '{}')) };
  });
  app.put('/api/v1/reminder-preferences', async (request, reply) => {
    const user = owner(request), parsed = reminderPrefsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(failure('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid reminder preferences.'));
    sqlite.prepare('INSERT INTO reminder_prefs (user_id,prefs_json,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET prefs_json=excluded.prefs_json,updated_at=excluded.updated_at')
      .run(user.id, JSON.stringify(parsed.data), nowIso());
    const account = db.select().from(users).where(eq(users.id, user.id)).get();
    const meetingRows = db.select().from(meetings).where(and(eq(meetings.userId, user.id), isNull(meetings.deletedAt))).all();
    const taskRows = db.select().from(tasks).where(and(eq(tasks.userId, user.id), isNull(tasks.deletedAt))).all();
    meetingRows.forEach((row) => scheduleEntityReminders(user.id, 'meeting', { ...row, reminderLeadMinutes: row.reminderLeadJson ? JSON.parse(row.reminderLeadJson) as number[] | null : undefined }, account?.timezone ?? 'UTC', parsed.data));
    taskRows.forEach((row) => scheduleEntityReminders(user.id, 'task', { ...row, reminderLeadMinutes: row.reminderLeadJson ? JSON.parse(row.reminderLeadJson) as number[] | null : undefined }, account?.timezone ?? 'UTC', parsed.data));
    return { prefs: parsed.data };
  });
  app.get('/api/v1/reminders', async (request) => {
    const user = owner(request);
    const items = sqlite.prepare('SELECT * FROM reminders WHERE user_id=? ORDER BY created_at DESC LIMIT 200').all(user.id);
    return { items };
  });
  app.get('/api/v1/push/public-key', async (request, reply) => {
    owner(request);
    if (!config.VAPID_PUBLIC_KEY) return reply.code(503).send(failure('PUSH_NOT_CONFIGURED', 'Push delivery is not configured on this server.'));
    return { publicKey: config.VAPID_PUBLIC_KEY };
  });
  app.post('/api/v1/reminders/test', async (request, reply) => {
    const user = owner(request);
    try { await sendMail(user.email, 'ZarghamFlow test reminder', 'Your reminder delivery is configured.'); return { ok: true }; }
    catch (error) { return reply.code(502).send(failure('MAIL_DELIVERY_FAILED', String(error))); }
  });
  app.post('/api/v1/push/subscribe', async (request, reply) => {
    const user = owner(request), body = request.body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    if (typeof body?.endpoint !== 'string' || !body.endpoint.startsWith('https://') || typeof body.keys?.p256dh !== 'string' || typeof body.keys.auth !== 'string') return reply.code(400).send(failure('VALIDATION_ERROR', 'Invalid push subscription.'));
    const now = nowIso();
    sqlite.prepare('INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth,updated_at=excluded.updated_at')
      .run(randomUUID(), user.id, body.endpoint, body.keys.p256dh, body.keys.auth, now, now);
    return reply.code(201).send({ ok: true });
  });
  app.delete('/api/v1/push/subscribe', async (request, reply) => {
    const user = owner(request), body = request.body as { endpoint?: unknown };
    if (typeof body?.endpoint !== 'string') return reply.code(400).send(failure('VALIDATION_ERROR', 'Push endpoint is required.'));
    sqlite.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?').run(user.id, body.endpoint);
    return reply.code(204).send();
  });

  app.get('/api/v1/export.json', async (request) => {
    const user = owner(request);
    return {
      app: 'zarghamflow', version: 1, exportedAt: nowIso(),
      meetings: sqlite.prepare('SELECT * FROM meetings WHERE user_id=? AND deleted_at IS NULL ORDER BY date,start').all(user.id),
      tasks: sqlite.prepare('SELECT * FROM tasks WHERE user_id=? AND deleted_at IS NULL ORDER BY due_date,due_time').all(user.id)
    };
  });
  app.post('/api/v1/import', async (request, reply) => {
    const user = owner(request), parsed = importSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(failure('VALIDATION_ERROR', 'Import must include meetings and/or tasks arrays.'));
    const { data, mode } = parsed.data;
    const meetingsIn = data.meetings.map(parseOldMeeting).filter((item): item is Record<string, unknown> => item !== null);
    const idMap = new Map<string, string>();
    data.meetings.forEach((item, index) => { if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string' && meetingsIn[index]) idMap.set(String((item as Record<string, unknown>).id), randomUUID()); });
    const tasksIn = data.tasks.map((item) => parseOldTask(item, idMap)).filter((item): item is Record<string, unknown> => item !== null);
    sqlite.transaction(() => {
      if (mode === 'replace') {
        sqlite.prepare('UPDATE meetings SET deleted_at=?,updated_at=?,version=version+1 WHERE user_id=? AND deleted_at IS NULL').run(nowIso(), nowIso(), user.id);
        sqlite.prepare('UPDATE tasks SET deleted_at=?,updated_at=?,version=version+1 WHERE user_id=? AND deleted_at IS NULL').run(nowIso(), nowIso(), user.id);
      }
      const meetingStmt = sqlite.prepare(`INSERT INTO meetings (id,user_id,title,date,start,end,client,contacts,type,location,notes,outcome,status,follow_up_date,reminder_lead_json,created_at,updated_at,deleted_at,version)
        VALUES (@id,@userId,@title,@date,@start,@end,@client,@contacts,@type,@location,@notes,@outcome,@status,@followUpDate,@reminderLeadJson,@createdAt,@updatedAt,NULL,1)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,date=excluded.date,start=excluded.start,end=excluded.end,client=excluded.client,contacts=excluded.contacts,type=excluded.type,location=excluded.location,notes=excluded.notes,outcome=excluded.outcome,status=excluded.status,follow_up_date=excluded.follow_up_date,updated_at=excluded.updated_at,version=meetings.version+1`);
      const stamp = nowIso();
      meetingsIn.forEach((item) => {
        const oldId = String(item.id ?? '');
        const row = { ...item, id: idMap.get(oldId) ?? randomUUID(), userId: user.id, followUpDate: item.followUpDate ?? null,
          reminderLeadJson: item.reminderLeadMinutes ? JSON.stringify(item.reminderLeadMinutes) : null, createdAt: stamp, updatedAt: stamp };
        meetingStmt.run(row);
        idMap.set(oldId, row.id as string);
      });
      const taskStmt = sqlite.prepare(`INSERT INTO tasks (id,user_id,title,due_date,due_time,priority,status,category,client,meeting_id,notes,completed_at,reminder_lead_json,created_at,updated_at,deleted_at,version)
        VALUES (@id,@userId,@title,@dueDate,@dueTime,@priority,@status,@category,@client,@meetingId,@notes,@completedAt,@reminderLeadJson,@createdAt,@updatedAt,NULL,1)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,due_date=excluded.due_date,due_time=excluded.due_time,priority=excluded.priority,status=excluded.status,category=excluded.category,client=excluded.client,meeting_id=excluded.meeting_id,notes=excluded.notes,completed_at=excluded.completed_at,updated_at=excluded.updated_at,version=tasks.version+1`);
      tasksIn.forEach((item) => taskStmt.run({ ...item, id: randomUUID(), userId: user.id, dueTime: item.dueTime || null, meetingId: item.meetingId || null,
        completedAt: item.completedAt || null, reminderLeadJson: item.reminderLeadMinutes ? JSON.stringify(item.reminderLeadMinutes) : null, createdAt: stamp, updatedAt: stamp }));
    })();
    return { imported: { meetings: meetingsIn.length, tasks: tasksIn.length } };
  });

  app.get('/api/v1/export.csv', async (request, reply) => {
    const user = owner(request), kind = (request.query as { kind?: string }).kind;
    if (kind !== 'meetings' && kind !== 'tasks') return reply.code(400).send(failure('INVALID_QUERY', 'kind must be meetings or tasks.'));
    const rows = kind === 'meetings'
      ? sqlite.prepare('SELECT title,date,start,end,client,contacts,type,location,notes,outcome,status,follow_up_date FROM meetings WHERE user_id=? AND deleted_at IS NULL ORDER BY date,start').all(user.id)
      : sqlite.prepare('SELECT title,due_date,due_time,priority,status,category,client,meeting_id,notes,completed_at FROM tasks WHERE user_id=? AND deleted_at IS NULL ORDER BY due_date,due_time').all(user.id);
    const values = rows as Array<Record<string, unknown>>;
    const columns = values.length ? Object.keys(values[0]!) : [];
    const cell = (value: unknown) => `"${String(value ?? '').replace(/^[=+\-@\t\r]/, "'").replace(/"/g, '""')}"`;
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename=zarghamflow-${kind}.csv`);
    return '\uFEFF' + [columns, ...values.map((row) => columns.map((column) => row[column]))].map((row) => row.map(cell).join(',')).join('\r\n');
  });

  app.get('/api/v1/export.ics', async (request, reply) => {
    const user = owner(request), rows = sqlite.prepare("SELECT id,title,date,start,end,location,notes FROM meetings WHERE user_id=? AND status='Scheduled' AND date>=? AND deleted_at IS NULL ORDER BY date,start").all(user.id, DateTime.now().toISODate());
    const esc = (value: unknown) => String(value ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//ZarghamFlow//EN'];
    for (const raw of rows as Array<{ id: string; title: string; date: string; start: string; end: string; location: string; notes: string }>) {
      lines.push('BEGIN:VEVENT', `UID:${raw.id}@zarghamflow`, `DTSTART:${raw.date.replace(/-/g,'')}T${raw.start.replace(':','')}00`, `DTEND:${raw.date.replace(/-/g,'')}T${raw.end.replace(':','')}00`, `SUMMARY:${esc(raw.title)}`, `LOCATION:${esc(raw.location)}`, `DESCRIPTION:${esc(raw.notes)}`, 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return reply.header('content-type','text/calendar; charset=utf-8').send(lines.join('\r\n'));
  });

  app.post('/api/v1/reminders/:id/action-link', async (request, reply) => {
    const user = owner(request), { id } = request.params as { id: string }, body = request.body as { action?: unknown };
    if (body.action !== 'done' && body.action !== 'snooze') return reply.code(400).send(failure('VALIDATION_ERROR', 'action must be done or snooze.'));
    const item = sqlite.prepare('SELECT id FROM tasks WHERE id=? AND user_id=? AND deleted_at IS NULL').get(id, user.id);
    if (!item) return reply.code(404).send(failure('NOT_FOUND', 'Task not found.'));
    const token = randomToken(32), stamp = nowIso();
    sqlite.prepare('INSERT INTO login_tokens (id,email,token_hash,kind,target_type,target_id,action,expires_at,created_at,ip_hash) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), user.email, sha256(token), 'action', 'task', id, body.action, new Date(Date.now()+24*60*60_000).toISOString(), stamp, 'email-action');
    return { url: new URL(`/api/v1/auth/actions/${token}`, config.APP_URL).toString() };
  });

  app.post('/api/v1/settings/timezone', async (request, reply) => {
    const user = owner(request), body = request.body as { timezone?: unknown };
    if (typeof body.timezone !== 'string' || !DateTime.now().setZone(body.timezone).isValid) return reply.code(400).send(failure('VALIDATION_ERROR', 'A valid IANA timezone is required.'));
    db.update(users).set({ timezone: body.timezone, updatedAt: nowIso() }).where(eq(users.id, user.id)).run();
    return { timezone: body.timezone };
  });
}
