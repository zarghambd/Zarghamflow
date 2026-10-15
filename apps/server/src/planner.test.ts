import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiTestApp, InjectResponse } from './http-types.js';

const testDir = mkdtempSync(join(tmpdir(), 'zarghamflow-planner-'));
process.env.NODE_ENV = 'test';
process.env.APP_URL = 'http://127.0.0.1:3001';
process.env.TRUST_PROXY = 'true';
process.env.DATABASE_PATH = join(testDir, 'planner.sqlite');
process.env.LOGIN_SECRET = 'planner-test-login-secret-0123456789abcdef';
delete process.env.DATABASE_URL;

let app: ApiTestApp;
let sqlite: typeof import('./db/index.js').sqlite;
let takeTestMails: typeof import('./mail.js').takeTestMails;

type UserContext = { cookie: string; csrfToken: string; ip: string };
type CsrfPair = { cookie: string; token: string };

function setCookies(response: InjectResponse): string[] {
  const header = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header : header ? [header] : [];
  return values.map((value) => String(value).split(';', 1)[0] ?? '').filter(Boolean);
}

async function getCsrf(): Promise<CsrfPair> {
  const response = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf' });
  const token = (response.json() as { csrfToken: string }).csrfToken;
  const cookie = setCookies(response).find((value) => value.startsWith('zf_csrf='));
  if (!cookie) throw new Error('CSRF cookie not returned');
  return { cookie, token };
}

let nextIp = 20;
async function createUser(email: string): Promise<UserContext> {
  const csrf = await getCsrf();
  const ip = `192.0.2.${nextIp++}`;
  const requested = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    headers: { cookie: csrf.cookie, 'x-csrf-token': csrf.token, 'x-forwarded-for': ip },
    payload: { firstName: 'Test', lastName: 'User', email }
  });
  if (requested.statusCode !== 200) throw new Error(`Signup failed: ${requested.statusCode}`);
  const messages = takeTestMails();
  const code = /Your ZarghamFlow code is (\d{6})/.exec(messages[0]?.text ?? '')?.[1];
  if (!code) throw new Error('OTP not found in test email');
  const verified = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/verify',
    headers: { cookie: csrf.cookie, 'x-csrf-token': csrf.token, 'x-forwarded-for': ip },
    payload: { email, code }
  });
  if (verified.statusCode !== 200) throw new Error(`Verification failed: ${verified.statusCode}`);
  const session = setCookies(verified).find((value) => value.startsWith('zf_session='));
  if (!session) throw new Error('Session cookie not returned');
  return { cookie: `${csrf.cookie}; ${session}`, csrfToken: csrf.token, ip };
}

async function inject(
  user: UserContext,
  method: string,
  url: string,
  payload?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<InjectResponse> {
  return app.inject({
    method,
    url,
    headers: {
      cookie: user.cookie,
      'x-csrf-token': user.csrfToken,
      'x-forwarded-for': user.ip,
      ...extraHeaders
    },
    ...(payload === undefined ? {} : { payload })
  });
}

const meetingInput = {
  title: 'Planning review',
  date: '2032-04-12',
  start: '09:00',
  end: '10:00',
  type: 'Video',
  status: 'Scheduled'
};

const taskInput = {
  title: 'Prepare agenda',
  dueDate: '2032-04-12',
  dueTime: null,
  priority: 'High',
  status: 'To Do',
  category: 'Admin'
};

beforeAll(async () => {
  const [{ buildApp }, database, migrations, mail] = await Promise.all([
    import('./app.js'),
    import('./db/index.js'),
    import('./db/migrations.js'),
    import('./mail.js')
  ]);
  sqlite = database.sqlite;
  takeTestMails = mail.takeTestMails;
  await migrations.applyMigrations();
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  if (sqlite) sqlite.close();
  rmSync(testDir, { recursive: true, force: true });
});

beforeEach(() => {
  sqlite.exec(`DELETE FROM reminders; DELETE FROM push_subscriptions; DELETE FROM sessions; DELETE FROM auth_otps; DELETE FROM login_tokens;
    DELETE FROM auth_rate_limits; DELETE FROM audit_log; DELETE FROM tasks; DELETE FROM meetings;
    DELETE FROM reminder_prefs; DELETE FROM users;`);
  takeTestMails();
});

describe('planner CRUD', () => {
  it('signs up, verifies, creates a meeting and task, and lists both records', async () => {
    const user = await createUser('planner-flow@example.test');
    const meetingCreated = await inject(user, 'POST', '/api/v1/meetings', {
      ...meetingInput,
      title: 'Signup flow meeting',
      client: '',
      contacts: '',
      location: '',
      notes: '',
      outcome: '',
      followUpDate: null
    });
    expect(meetingCreated.statusCode).toBe(201);
    const meeting = (meetingCreated.json() as { item: { id: string; title: string } }).item;
    const taskCreated = await inject(user, 'POST', '/api/v1/tasks', {
      ...taskInput,
      title: 'Signup flow task',
      client: '',
      notes: '',
      meetingId: meeting.id
    });
    expect(taskCreated.statusCode).toBe(201);

    expect((await inject(user, 'GET', '/api/v1/meetings')).json()).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ id: meeting.id, title: 'Signup flow meeting' })]
    });
    expect((await inject(user, 'GET', '/api/v1/tasks')).json()).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ title: 'Signup flow task', meeting_id: meeting.id })]
    });
  });

  it('returns field paths when meeting or task input is invalid', async () => {
    const user = await createUser('planner-validation@example.test');
    const invalidMeeting = await inject(user, 'POST', '/api/v1/meetings', { ...meetingInput, date: 'not-a-date' });
    const invalidTask = await inject(user, 'POST', '/api/v1/tasks', { ...taskInput, dueDate: 'not-a-date' });

    expect(invalidMeeting.statusCode).toBe(400);
    expect((invalidMeeting.json() as { error: { fields: Array<{ path: string[] }> } }).error.fields).toContainEqual(
      expect.objectContaining({ path: ['date'] })
    );
    expect(invalidTask.statusCode).toBe(400);
    expect((invalidTask.json() as { error: { fields: Array<{ path: string[] }> } }).error.fields).toContainEqual(
      expect.objectContaining({ path: ['dueDate'] })
    );
  });

  it('rejects duplicate task and meeting titles without regard to case or surrounding spaces', async () => {
    const user = await createUser('duplicate-titles@example.test');
    const task = await inject(user, 'POST', '/api/v1/tasks', taskInput);
    expect(task.statusCode).toBe(201);
    const duplicateTask = await inject(user, 'POST', '/api/v1/tasks', { ...taskInput, title: '  prepare AGENDA  ' });
    expect(duplicateTask.statusCode).toBe(409);
    expect(duplicateTask.json()).toMatchObject({ error: { code: 'DUPLICATE_TITLE', message: 'A task with this title already exists.' } });
    const otherTask = await inject(user, 'POST', '/api/v1/tasks', { ...taskInput, title: 'Another task' });
    const taskId = (otherTask.json() as { item: { id: string } }).item.id;
    expect((await inject(user, 'PATCH', `/api/v1/tasks/${taskId}`, { title: 'prepare agenda' }, { 'if-match': '1' })).statusCode).toBe(409);
    expect((await inject(user, 'POST', '/api/v1/tasks/quick-add', { text: 'Prepare agenda tomorrow' })).statusCode).toBe(409);

    const meeting = await inject(user, 'POST', '/api/v1/meetings', meetingInput);
    expect(meeting.statusCode).toBe(201);
    const duplicateMeeting = await inject(user, 'POST', '/api/v1/meetings', { ...meetingInput, title: ' planning REVIEW ' });
    expect(duplicateMeeting.statusCode).toBe(409);
    expect(duplicateMeeting.json()).toMatchObject({ error: { code: 'DUPLICATE_TITLE', message: 'A meeting with this title already exists.' } });
    const otherMeeting = await inject(user, 'POST', '/api/v1/meetings', { ...meetingInput, title: 'Another meeting' });
    const meetingId = (otherMeeting.json() as { item: { id: string } }).item.id;
    expect((await inject(user, 'PATCH', `/api/v1/meetings/${meetingId}`, { title: 'planning review' }, { 'if-match': '1' })).statusCode).toBe(409);
  });

  it('creates, reads, updates, conflicts, and deletes meetings and tasks', async () => {
    const user = await createUser('planner@example.test');

    const meetingCreated = await inject(user, 'POST', '/api/v1/meetings', meetingInput);
    expect(meetingCreated.statusCode).toBe(201);
    const meeting = (meetingCreated.json() as { item: { id: string; version: number; title: string } }).item;
    expect(meeting).toMatchObject({ version: 1, title: 'Planning review' });
    expect((await inject(user, 'GET', '/api/v1/meetings')).json()).toMatchObject({ total: 1 });

    const meetingUpdated = await inject(user, 'PATCH', `/api/v1/meetings/${meeting.id}`, { title: 'Updated review' }, { 'if-match': '1' });
    expect(meetingUpdated.statusCode).toBe(200);
    expect((meetingUpdated.json() as { item: { version: number } }).item.version).toBe(2);
    expect((await inject(user, 'PATCH', `/api/v1/meetings/${meeting.id}`, { title: 'Stale edit' }, { 'if-match': '1' })).statusCode).toBe(409);
    expect((await inject(user, 'DELETE', `/api/v1/meetings/${meeting.id}`, undefined, { 'if-match': '1' })).statusCode).toBe(409);
    expect((await inject(user, 'DELETE', `/api/v1/meetings/${meeting.id}`, undefined, { 'if-match': '2' })).statusCode).toBe(204);

    const taskCreated = await inject(user, 'POST', '/api/v1/tasks', taskInput);
    expect(taskCreated.statusCode).toBe(201);
    const task = (taskCreated.json() as { item: { id: string; version: number; title: string } }).item;
    expect(task).toMatchObject({ version: 1, title: 'Prepare agenda' });
    expect((await inject(user, 'GET', '/api/v1/tasks')).json()).toMatchObject({ total: 1 });

    const taskUpdated = await inject(user, 'PATCH', `/api/v1/tasks/${task.id}`, { title: 'Updated agenda' }, { 'if-match': '1' });
    expect(taskUpdated.statusCode).toBe(200);
    expect((taskUpdated.json() as { item: { version: number } }).item.version).toBe(2);
    expect((await inject(user, 'PATCH', `/api/v1/tasks/${task.id}`, { title: 'Stale edit' }, { 'if-match': '1' })).statusCode).toBe(409);
    expect((await inject(user, 'DELETE', `/api/v1/tasks/${task.id}`, undefined, { 'if-match': '1' })).statusCode).toBe(409);
    expect((await inject(user, 'DELETE', `/api/v1/tasks/${task.id}`, undefined, { 'if-match': '2' })).statusCode).toBe(204);
  });
});

describe('legacy import', () => {
  it('merges data and remaps non-UUID legacy meeting IDs for linked tasks', async () => {
    const user = await createUser('import-merge@example.test');
    const existing = await inject(user, 'POST', '/api/v1/meetings', { ...meetingInput, title: 'Keep existing' });
    expect(existing.statusCode).toBe(201);
    const imported = await inject(user, 'POST', '/api/v1/import', {
      mode: 'merge',
      data: {
        meetings: [{ id: 'legacy-meeting-001', title: 'Imported legacy meeting', date: '2032-05-01', start: '11:00', end: '12:00' }],
        tasks: [{ id: 'legacy-task-001', title: 'Imported legacy task', dueDate: '2032-05-02', meetingId: 'legacy-meeting-001' }]
      }
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toEqual({ imported: { meetings: 1, tasks: 1 } });

    const meetings = (await inject(user, 'GET', '/api/v1/meetings')).json() as { items: Array<{ id: string; title: string }> };
    expect(meetings.items.map((item) => item.title)).toEqual(expect.arrayContaining(['Keep existing', 'Imported legacy meeting']));
    const importedMeeting = meetings.items.find((item) => item.title === 'Imported legacy meeting');
    expect(importedMeeting?.id).toMatch(/^[0-9a-f-]{36}$/i);
    const tasks = (await inject(user, 'GET', '/api/v1/tasks')).json() as { items: Array<{ meeting_id: string | null; title: string }> };
    expect(tasks.items).toContainEqual(expect.objectContaining({ title: 'Imported legacy task', meeting_id: importedMeeting?.id }));
  });

  it('replaces only the current user’s active planner records', async () => {
    const user = await createUser('import-replace@example.test');
    await inject(user, 'POST', '/api/v1/meetings', { ...meetingInput, title: 'To be replaced' });
    await inject(user, 'POST', '/api/v1/tasks', taskInput);
    const imported = await inject(user, 'POST', '/api/v1/import', {
      mode: 'replace',
      data: { meetings: [{ id: 'old-app-id', ...meetingInput, title: 'Replacement meeting' }], tasks: [] }
    });
    expect(imported.statusCode).toBe(200);
    expect((await inject(user, 'GET', '/api/v1/meetings')).json()).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ title: 'Replacement meeting' })]
    });
    expect((await inject(user, 'GET', '/api/v1/tasks')).json()).toMatchObject({ total: 0, items: [] });
  });
});

describe('cross-user isolation', () => {
  it('prevents another user from reading or modifying meetings and tasks', async () => {
    const owner = await createUser('records-owner@example.test');
    const other = await createUser('records-other@example.test');
    const meetingResponse = await inject(owner, 'POST', '/api/v1/meetings', meetingInput);
    const taskResponse = await inject(owner, 'POST', '/api/v1/tasks', taskInput);
    const meeting = (meetingResponse.json() as { item: { id: string } }).item;
    const task = (taskResponse.json() as { item: { id: string } }).item;

    expect((await inject(other, 'GET', '/api/v1/meetings')).json()).toMatchObject({ total: 0, items: [] });
    expect((await inject(other, 'GET', '/api/v1/tasks')).json()).toMatchObject({ total: 0, items: [] });
    expect((await inject(other, 'GET', `/api/v1/meetings/${meeting.id}`)).statusCode).toBe(404);
    expect((await inject(other, 'GET', `/api/v1/tasks/${task.id}`)).statusCode).toBe(404);
    expect((await inject(other, 'PATCH', `/api/v1/meetings/${meeting.id}`, { title: 'Unauthorized' }, { 'if-match': '1' })).statusCode).toBe(404);
    expect((await inject(other, 'DELETE', `/api/v1/meetings/${meeting.id}`, undefined, { 'if-match': '1' })).statusCode).toBe(404);
    expect((await inject(other, 'PATCH', `/api/v1/tasks/${task.id}`, { title: 'Unauthorized' }, { 'if-match': '1' })).statusCode).toBe(404);
    expect((await inject(other, 'DELETE', `/api/v1/tasks/${task.id}`, undefined, { 'if-match': '1' })).statusCode).toBe(404);
    expect((await inject(owner, 'GET', `/api/v1/meetings/${meeting.id}`)).statusCode).toBe(200);
    expect((await inject(owner, 'GET', `/api/v1/tasks/${task.id}`)).statusCode).toBe(200);
  });
});
