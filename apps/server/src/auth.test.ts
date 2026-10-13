import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { localToUtc } from './reminders/time.js';

const ownerEmail = 'owner@example.test';
const testDir = mkdtempSync(join(tmpdir(), 'zarghamflow-auth-'));
process.env.NODE_ENV = 'test';
process.env.OWNER_EMAIL = ownerEmail;
process.env.APP_URL = 'http://localhost:5173';
process.env.DATABASE_PATH = join(testDir, 'auth.sqlite');
process.env.SESSION_SECRET = 'auth-test-session-secret-0123456789abcdef';
process.env.LOGIN_SECRET = 'auth-test-login-secret-0123456789abcdef';

let app: FastifyInstance;
type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;
let sqlite: typeof import('./db/index.js').sqlite;
let takeTestMails: typeof import('./mail.js').takeTestMails;
let failNextTestEmails: typeof import('./mail.js').failNextTestEmails;
let scheduleEntityReminders: typeof import('./reminders/scheduler.js').scheduleEntityReminders;
let runReminderTick: typeof import('./reminders/scheduler.js').runReminderTick;

type Csrf = { token: string; cookie: string };
function setCookies(response: InjectResponse): string[] {
  const header = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header : header ? [header] : [];
  return values.map((value) => String(value).split(';', 1)[0] ?? '').filter(Boolean);
}
async function csrf(): Promise<Csrf> {
  const response = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf' });
  const token = (response.json() as { csrfToken: string }).csrfToken;
  const cookie = setCookies(response).find((value) => value.startsWith('zf_csrf='));
  if (!cookie) throw new Error('CSRF cookie not returned');
  return { token, cookie };
}
async function requestLink(email: string, pair: Csrf): Promise<InjectResponse> {
  return app.inject({
    method: 'POST', url: '/api/v1/auth/request',
    headers: { cookie: pair.cookie, 'x-csrf-token': pair.token },
    payload: { email }
  });
}
async function issueOwnerToken(pair: Csrf): Promise<string> {
  return issueTokenFor(ownerEmail, pair);
}
async function issueTokenFor(email: string, pair: Csrf): Promise<string> {
  const response = await requestLink(email, pair);
  expect(response.statusCode).toBe(200);
  const messages = takeTestMails();
  expect(messages).toHaveLength(1);
  const token = /[?&]token=([A-Za-z0-9_-]+)/.exec(messages[0]!.text)?.[1];
  if (!token) throw new Error('Magic link token not found in test email');
  return token;
}
async function verifyToken(token: string, pair: Csrf): Promise<InjectResponse> {
  return app.inject({
    method: 'POST', url: '/api/v1/auth/verify',
    headers: { cookie: pair.cookie, 'x-csrf-token': pair.token },
    payload: { token }
  });
}

beforeAll(async () => {
  const [{ buildApp }, database, migrations, mail, scheduler] = await Promise.all([
    import('./app.js'), import('./db/index.js'), import('./db/migrations.js'), import('./mail.js'), import('./reminders/scheduler.js')
  ]);
  sqlite = database.sqlite;
  takeTestMails = mail.takeTestMails;
  failNextTestEmails = mail.failNextTestEmails;
  scheduleEntityReminders = scheduler.scheduleEntityReminders;
  runReminderTick = scheduler.runReminderTick;
  migrations.applyMigrations();
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  if (sqlite) sqlite.close();
  rmSync(testDir, { recursive: true, force: true });
});

beforeEach(() => {
  sqlite.exec(`DELETE FROM reminders; DELETE FROM push_subscriptions; DELETE FROM sessions; DELETE FROM login_tokens;
    DELETE FROM audit_log; DELETE FROM tasks; DELETE FROM meetings; DELETE FROM reminder_prefs; DELETE FROM users;`);
  takeTestMails();
});

describe('single-owner email authentication', () => {
  it('returns the same generic response for any signup address', async () => {
    const pair = await csrf();
    const wrong = await requestLink('other@example.test', pair);
    const owner = await requestLink(ownerEmail, pair);
    expect(wrong.statusCode).toBe(200);
    expect(wrong.json()).toEqual(owner.json());
    expect(takeTestMails()).toHaveLength(2);
  });

  it('rejects CSRF and token replays without a session, but allows an authenticated retry', async () => {
    const rejected = await app.inject({ method: 'POST', url: '/api/v1/auth/request', payload: { email: ownerEmail } });
    expect(rejected.statusCode).toBe(403);

    const pair = await csrf();
    const token = await issueOwnerToken(pair);
    const signedIn = await verifyToken(token, pair);
    expect(signedIn.statusCode).toBe(200);
    const sessionCookie = setCookies(signedIn).find((value) => value.startsWith('zf_session='));
    expect(sessionCookie).toBeDefined();
    expect((await verifyToken(token, pair)).statusCode).toBe(400);
    const retry = await app.inject({
      method: 'POST', url: '/api/v1/auth/verify',
      headers: { cookie: `${pair.cookie}; ${sessionCookie}`, 'x-csrf-token': pair.token },
      payload: { token }
    });
    expect(retry.statusCode).toBe(200);
    expect((sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count).toBe(1);
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: `${pair.cookie}; ${sessionCookie}` } });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { user: { email: string } }).user.email).toBe(ownerEmail);
    const logoutAll = await app.inject({ method: 'POST', url: '/api/v1/auth/logout-all', headers: { cookie: `${pair.cookie}; ${sessionCookie}`, 'x-csrf-token': pair.token } });
    expect(logoutAll.statusCode).toBe(200);
    const revoked = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: `${pair.cookie}; ${sessionCookie}` } });
    expect(revoked.statusCode).toBe(401);
  });

  it('rejects an expired link and keeps other device sessions active', async () => {
    const pair = await csrf();
    const expiredToken = await issueOwnerToken(pair);
    sqlite.prepare('UPDATE login_tokens SET expires_at=? WHERE token_hash=?').run(new Date(Date.now() - 1000).toISOString(), createHash('sha256').update(expiredToken).digest('hex'));
    expect((await verifyToken(expiredToken, pair)).statusCode).toBe(400);

    const firstToken = await issueOwnerToken(pair);
    const first = await verifyToken(firstToken, pair);
    const secondToken = await issueOwnerToken(pair);
    const second = await verifyToken(secondToken, pair);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect((sqlite.prepare('SELECT COUNT(*) AS count FROM sessions WHERE revoked_at IS NULL').get() as { count: number }).count).toBe(2);
  });

  it('limits magic-link sends per owner account while keeping the generic response', async () => {
    const pair = await csrf();
    for (let index = 0; index < 5; index++) await requestLink(ownerEmail, pair);
    const messages = takeTestMails();
    expect(messages).toHaveLength(5);
    const limited = await requestLink(ownerEmail, pair);
    expect(limited.statusCode).toBe(200);
    expect(limited.json()).toEqual({ ok: true, message: 'If the address is eligible, a sign-in link will arrive shortly.' });
    expect(takeTestMails()).toHaveLength(0);
  });
});

describe('multi-user signup and administration', () => {
  it('promotes the first verified signup to admin and later signups to regular users', async () => {
    const pair=await csrf();
    const firstToken=await issueTokenFor('first@example.test',pair);
    const first=await verifyToken(firstToken,pair);
    expect(first.statusCode).toBe(200);
    expect((first.json() as {user:{role:string}}).user.role).toBe('admin');
    const firstSession=setCookies(first).find((value)=>value.startsWith('zf_session='))!;

    const secondToken=await issueTokenFor('second@example.test',pair);
    const second=await verifyToken(secondToken,pair);
    expect(second.statusCode).toBe(200);
    expect((second.json() as {user:{role:string}}).user.role).toBe('user');
    const secondSession=setCookies(second).find((value)=>value.startsWith('zf_session='))!;
    const denied=await app.inject({method:'GET',url:'/api/v1/admin/users',headers:{cookie:`${pair.cookie}; ${secondSession}`}});
    expect(denied.statusCode).toBe(403);

    const list=await app.inject({method:'GET',url:'/api/v1/admin/users',headers:{cookie:`${pair.cookie}; ${firstSession}`}});
    expect(list.statusCode).toBe(200);
    expect((list.json() as {items:Array<{email:string;role:string}>}).items).toEqual(expect.arrayContaining([
      expect.objectContaining({email:'first@example.test',role:'admin'}),
      expect.objectContaining({email:'second@example.test',role:'user'})
    ]));
  });

  it('allows admins to deactivate accounts but prevents removing the last active admin', async () => {
    const pair=await csrf();
    const adminToken=await issueTokenFor('admin@example.test',pair);
    const adminLogin=await verifyToken(adminToken,pair);
    const adminCookie=setCookies(adminLogin).find((value)=>value.startsWith('zf_session='))!;
    const memberToken=await issueTokenFor('member@example.test',pair);
    const memberLogin=await verifyToken(memberToken,pair);
    const memberCookie=setCookies(memberLogin).find((value)=>value.startsWith('zf_session='))!;
    const memberId=(sqlite.prepare('SELECT id FROM users WHERE email=?').get('member@example.test') as {id:string}).id;

    const deactivate=await app.inject({method:'PATCH',url:`/api/v1/admin/users/${memberId}`,headers:{cookie:`${pair.cookie}; ${adminCookie}`,'x-csrf-token':pair.token},payload:{active:false}});
    expect(deactivate.statusCode).toBe(200);
    expect((await app.inject({method:'GET',url:'/api/v1/auth/me',headers:{cookie:`${pair.cookie}; ${memberCookie}`}})).statusCode).toBe(401);

    const admins=sqlite.prepare("SELECT id FROM users WHERE role='admin' AND active=1").all() as Array<{id:string}>;
    expect(admins).toHaveLength(1);
    const lastAdmin=await app.inject({method:'PATCH',url:`/api/v1/admin/users/${admins[0]!.id}`,headers:{cookie:`${pair.cookie}; ${adminCookie}`,'x-csrf-token':pair.token},payload:{active:false}});
    expect(lastAdmin.statusCode).toBe(409);
  });
});

describe('persistent reminder scheduling', () => {
  it('reactivates unchanged pending reminders after an item edit and replaces changed times', () => {
    const userId = randomUUID(), meetingId = randomUUID(), stamp = new Date().toISOString();
    sqlite.prepare('INSERT INTO users(id,email,timezone,locale,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(userId, ownerEmail, 'Europe/London', 'en-GB', '{}', stamp, stamp);
    const date = DateTime.now().setZone('Europe/London').plus({ days: 3 }).toISODate()!;
    const meeting = { id: meetingId, title: 'Review', date, start: '10:00', end: '11:00', status: 'Scheduled', reminderLeadMinutes: [60,15] };
    scheduleEntityReminders(userId, 'meeting', meeting, 'Europe/London', { emailEnabled: true, pushEnabled: true });
    scheduleEntityReminders(userId, 'meeting', meeting, 'Europe/London', { emailEnabled: true, pushEnabled: true });
    expect((sqlite.prepare("SELECT COUNT(*) AS count FROM reminders WHERE state='pending'").get() as {count:number}).count).toBe(4);

    const moved = { ...meeting, date: DateTime.fromISO(date).plus({days:1}).toISODate()! };
    scheduleEntityReminders(userId, 'meeting', moved, 'Europe/London', { emailEnabled: true, pushEnabled: true });
    expect((sqlite.prepare("SELECT COUNT(*) AS count FROM reminders WHERE state='pending'").get() as {count:number}).count).toBe(4);
    expect((sqlite.prepare("SELECT COUNT(*) AS count FROM reminders WHERE state='cancelled'").get() as {count:number}).count).toBe(4);
  });

  it('fires date-only task reminders at 09:00 local time', () => {
    const userId = randomUUID(), taskId = randomUUID(), stamp = new Date().toISOString();
    sqlite.prepare('INSERT INTO users(id,email,timezone,locale,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(userId, ownerEmail, 'Europe/London', 'en-GB', '{}', stamp, stamp);
    const dueDate = DateTime.now().setZone('Europe/London').plus({ days: 3 }).toISODate()!;
    scheduleEntityReminders(userId, 'task', { id:taskId, title:'Prepare', dueDate, dueTime:'', status:'To Do' }, 'Europe/London', { emailEnabled:true, pushEnabled:false });
    const reminder = sqlite.prepare("SELECT fire_at FROM reminders WHERE target_type='task' AND target_id=?").get(taskId) as {fire_at:string};
    expect(reminder.fire_at).toBe(localToUtc(dueDate,'09:00','Europe/London'));
  });

  it('defers 08:00 meeting follow-ups until quiet hours end', () => {
    const userId=randomUUID(),meetingId=randomUUID(),stamp=new Date().toISOString();
    sqlite.prepare('INSERT INTO users(id,email,timezone,locale,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(userId,ownerEmail,'Europe/London','en-GB','{}',stamp,stamp);
    const followUpDate=DateTime.now().setZone('Europe/London').plus({days:4}).toISODate()!;
    const meetingDate=DateTime.fromISO(followUpDate).minus({days:1}).toISODate()!;
    scheduleEntityReminders(userId,'meeting',{id:meetingId,title:'Follow-up call',date:meetingDate,start:'10:00',end:'10:30',status:'Completed',followUpDate,reminderLeadMinutes:null},'Europe/London',{emailEnabled:true,pushEnabled:false,followUpEnabled:true,quietStart:'07:00',quietEnd:'09:30'});
    const followUp=sqlite.prepare("SELECT fire_at FROM reminders WHERE target_type='followup' AND target_id=?").get(meetingId) as {fire_at:string};
    expect(followUp.fire_at).toBe(localToUtc(followUpDate,'09:30','Europe/London'));
  });

  it('records delivery once across repeated worker ticks', async () => {
    const userId = randomUUID(), taskId = randomUUID(), stamp = new Date().toISOString();
    sqlite.prepare('INSERT INTO users(id,email,timezone,locale,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(userId, ownerEmail, 'UTC', 'en-GB', '{}', stamp, stamp);
    sqlite.prepare(`INSERT INTO tasks(id,user_id,title,due_date,due_time,priority,status,category,client,notes,created_at,updated_at,version)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(taskId,userId,'Send proposal',DateTime.now().toISODate(),'12:00','High','To Do','Proposal','','',stamp,stamp);
    sqlite.prepare(`INSERT INTO reminders(id,user_id,target_type,target_id,fire_at,channel,lead,state,attempts,created_at,updated_at,dedupe_key)
      VALUES(?,?,?,?,?,'email',60,'pending',0,?,?,?)`).run(randomUUID(),userId,'task',taskId,new Date(Date.now()-1000).toISOString(),stamp,stamp,`test:${taskId}`);

    await runReminderTick();
    expect((sqlite.prepare("SELECT state FROM reminders WHERE dedupe_key=?").get(`test:${taskId}`) as {state:string}).state).toBe('sent');
    expect(takeTestMails()).toHaveLength(1);
    await runReminderTick();
    expect(takeTestMails()).toHaveLength(0);
  });

  it('persists a failed delivery for retry and marks it sent after recovery', async () => {
    const userId = randomUUID(), taskId = randomUUID(), stamp = new Date().toISOString(), dedupeKey = `retry:${randomUUID()}`;
    sqlite.prepare('INSERT INTO users(id,email,timezone,locale,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(userId, ownerEmail, 'UTC', 'en-GB', '{}', stamp, stamp);
    sqlite.prepare(`INSERT INTO tasks(id,user_id,title,due_date,due_time,priority,status,category,client,notes,created_at,updated_at,version)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(taskId,userId,'Retry proposal',DateTime.now().toISODate(),'12:00','High','To Do','Proposal','','',stamp,stamp);
    sqlite.prepare(`INSERT INTO reminders(id,user_id,target_type,target_id,fire_at,channel,lead,state,attempts,created_at,updated_at,dedupe_key)
      VALUES(?,?,?,?,?,'email',60,'pending',0,?,?,?)`).run(randomUUID(),userId,'task',taskId,new Date(Date.now()-1000).toISOString(),stamp,stamp,dedupeKey);

    failNextTestEmails(1);
    await runReminderTick();
    const retry = sqlite.prepare('SELECT state,attempts,last_error FROM reminders WHERE dedupe_key=?').get(dedupeKey) as {state:string;attempts:number;last_error:string};
    expect(retry.state).toBe('pending');
    expect(retry.attempts).toBe(1);
    expect(retry.last_error).toContain('Simulated test-mail transport failure');

    sqlite.prepare('UPDATE reminders SET fire_at=? WHERE dedupe_key=?').run(new Date(Date.now()-1000).toISOString(),dedupeKey);
    await runReminderTick();
    const recovered = sqlite.prepare('SELECT state,attempts,last_error FROM reminders WHERE dedupe_key=?').get(dedupeKey) as {state:string;attempts:number;last_error:string|null};
    expect(recovered.state).toBe('sent');
    expect(recovered.attempts).toBe(2);
    expect(recovered.last_error).toBeNull();
    expect(takeTestMails()).toHaveLength(1);
  });

  it('attaches an iCalendar event to meeting reminder emails', async () => {
    const userId=randomUUID(),meetingId=randomUUID(),stamp=new Date().toISOString();
    sqlite.prepare('INSERT INTO users(id,email,timezone,locale,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(userId,ownerEmail,'Europe/London','en-GB','{}',stamp,stamp);
    const date=DateTime.now().setZone('Europe/London').plus({days:3}).toISODate()!;
    sqlite.prepare(`INSERT INTO meetings(id,user_id,title,date,start,end,client,contacts,type,location,notes,outcome,status,created_at,updated_at,version)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(meetingId,userId,'Acme review',date,'10:00','10:45','Acme Ltd','Alex Morgan','Video','https://meet.example.test/room','Review expansion plan','','Scheduled',stamp,stamp);
    sqlite.prepare(`INSERT INTO reminders(id,user_id,target_type,target_id,fire_at,channel,lead,state,attempts,created_at,updated_at,dedupe_key)
      VALUES(?,?,?,?,?,'email',15,'pending',0,?,?,?)`).run(randomUUID(),userId,'meeting',meetingId,new Date(Date.now()-1000).toISOString(),stamp,stamp,`ics:${meetingId}`);

    await runReminderTick();
    const message=takeTestMails()[0];
    expect(message?.attachments).toHaveLength(1);
    expect(message?.attachments?.[0]?.filename).toBe(`zarghamflow-${date}.ics`);
    expect(String(message?.attachments?.[0]?.content)).toContain('BEGIN:VEVENT');
    expect(String(message?.attachments?.[0]?.content)).toContain('SUMMARY:Acme review');
    expect(String(message?.attachments?.[0]?.content)).toContain('LOCATION:https://meet.example.test/room');
  });
});
