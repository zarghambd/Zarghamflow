import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { localToUtc } from './reminders/time.js';
import type { ApiTestApp, InjectResponse } from './http-types.js';

const ownerEmail = 'owner@example.test';
const testDir = mkdtempSync(join(tmpdir(), 'zarghamflow-auth-'));
process.env.NODE_ENV = 'test';
process.env.OWNER_EMAIL = ownerEmail;
process.env.APP_URL = 'http://127.0.0.1:3001';
process.env.TRUST_PROXY = 'true';
process.env.DATABASE_PATH = join(testDir, 'auth.sqlite');
delete process.env.DATABASE_URL;
delete process.env.ADMIN_EMAIL;
process.env.LOGIN_SECRET = 'auth-test-login-secret-0123456789abcdef';

let app: ApiTestApp;
let sqlite: typeof import('./db/index.js').sqlite;
let takeTestMails: typeof import('./mail.js').takeTestMails;
let failNextTestEmails: typeof import('./mail.js').failNextTestEmails;
const otpEmails = new Map<string, string>();
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
async function requestLink(email: string, pair: Csrf, ip = '198.51.100.1'): Promise<InjectResponse> {
  return app.inject({
    method: 'POST', url: '/api/v1/auth/request',
    headers: { cookie: pair.cookie, 'x-csrf-token': pair.token, 'x-forwarded-for': ip },
    payload: { email }
  });
}
async function issueOwnerToken(pair: Csrf): Promise<string> {
  return issueTokenFor(ownerEmail, pair);
}
async function issueTokenFor(email: string, pair: Csrf, ip?: string): Promise<string> {
  const response = await requestLink(email, pair, ip);
  expect(response.statusCode).toBe(200);
  const messages = takeTestMails();
  expect(messages).toHaveLength(1);
  const code = /Your ZarghamFlow code is (\d{6})/.exec(messages[0]!.text)?.[1];
  if (!code) throw new Error('6-digit OTP not found in test email');
  otpEmails.set(code, email.trim().toLowerCase());
  return code;
}
async function verifyToken(code: string, pair: Csrf, ip = '198.51.100.1', email = otpEmails.get(code) ?? ownerEmail): Promise<InjectResponse> {
  return app.inject({
    method: 'POST', url: '/api/v1/auth/verify',
    headers: { cookie: pair.cookie, 'x-csrf-token': pair.token, 'x-forwarded-for': ip },
    payload: { email, code }
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
    DELETE FROM auth_rate_limits; DELETE FROM audit_log; DELETE FROM tasks; DELETE FROM meetings; DELETE FROM reminder_prefs; DELETE FROM users;`);
  takeTestMails();
  otpEmails.clear();
});

describe('single-owner email authentication', () => {
  it('serves the same-origin auth aliases and requires CSRF before issuing an OTP', async () => {
    const csrfResponse = await app.inject({ method: 'GET', url: '/api/auth/csrf' });
    expect(csrfResponse.statusCode).toBe(200);
    const csrfToken = (csrfResponse.json() as { csrfToken: string }).csrfToken;
    const csrfCookie = setCookies(csrfResponse).find((value) => value.startsWith('zf_csrf='));
    expect(csrfCookie).toBeDefined();

    const requested = await app.inject({
      method: 'POST',
      url: '/api/auth/request',
      headers: { cookie: csrfCookie!, 'x-csrf-token': csrfToken },
      payload: { email: ownerEmail }
    });
    expect(requested.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: ownerEmail } })).statusCode).toBe(403);
    const [message] = takeTestMails();
    expect(message).toBeDefined();
    expect(message!.subject).not.toMatch(/\d{6}/);
    expect(message!.text).toMatch(/Your ZarghamFlow code is \d{6}\. It expires in 10 minutes\./);
    expect(message!.html).toContain('expires in 10 minutes');
    const code = /Your ZarghamFlow code is (\d{6})/.exec(message!.text)?.[1];
    expect(code).toBeDefined();
    otpEmails.set(code!, ownerEmail);

    const verified = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      headers: { cookie: csrfCookie!, 'x-csrf-token': csrfToken },
      payload: { email: ownerEmail, code }
    });
    expect(verified.statusCode).toBe(200);
    expect((verified.json() as { redirect: string }).redirect).toBe('/admin');
  });

  it('returns the same generic response for existing, new, and deactivated addresses', async () => {
    const pair = await csrf();
    const existingCode = await issueTokenFor(ownerEmail, pair);
    expect((await verifyToken(existingCode, pair)).statusCode).toBe(200);
    sqlite.prepare('UPDATE auth_otps SET created_at=? WHERE email=?').run(new Date(Date.now() - 61_000).toISOString(), ownerEmail);
    const known = await requestLink(ownerEmail, pair);
    sqlite.prepare('UPDATE auth_otps SET created_at=? WHERE email=?').run(new Date(Date.now() - 61_000).toISOString(), ownerEmail);
    const unknown = await requestLink('other@example.test', pair);
    sqlite.prepare("UPDATE users SET active=0 WHERE lower(email)=lower(?)").run(ownerEmail);
    sqlite.prepare('UPDATE auth_otps SET created_at=? WHERE email=?').run(new Date(Date.now() - 61_000).toISOString(), ownerEmail);
    const disabled = await requestLink(ownerEmail, pair);
    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    expect(disabled.statusCode).toBe(200);
    expect(unknown.json()).toEqual(known.json());
    expect(disabled.json()).toEqual(known.json());
    expect(takeTestMails()).toHaveLength(3);
  });

  it('requires CSRF, rejects OTP replays, rotates sessions, and preserves logout-all', async () => {
    const rejected = await app.inject({ method: 'POST', url: '/api/v1/auth/request', payload: { email: ownerEmail } });
    expect(rejected.statusCode).toBe(403);

    const pair = await csrf();
    const code = await issueOwnerToken(pair);
    const missingVerifyCsrf = await app.inject({
      method: 'POST', url: '/api/v1/auth/verify', payload: { email: ownerEmail, code }
    });
    expect(missingVerifyCsrf.statusCode).toBe(403);
    const signedIn = await verifyToken(code, pair);
    expect(signedIn.statusCode).toBe(200);
    const sessionCookie = setCookies(signedIn).find((value) => value.startsWith('zf_session='));
    const rawSetCookies = signedIn.headers['set-cookie'];
    const sessionSetCookie = (Array.isArray(rawSetCookies) ? rawSetCookies : rawSetCookies ? [rawSetCookies] : [])
      .find((value) => String(value).startsWith('zf_session='));
    expect(sessionCookie).toBeDefined();
    expect(sessionSetCookie).toContain('Path=/');
    expect(sessionSetCookie).toContain('HttpOnly');
    expect(sessionSetCookie).toContain('SameSite=Lax');
    expect(sessionSetCookie).not.toContain('Secure');
    expect((await verifyToken(code, pair)).statusCode).toBe(400);

    sqlite.prepare('UPDATE auth_otps SET created_at=? WHERE email=?').run(new Date(Date.now() - 61_000).toISOString(), ownerEmail);
    const nextCode = await issueOwnerToken(pair);
    const rotated = await app.inject({
      method: 'POST', url: '/api/v1/auth/verify',
      headers: { cookie: `${pair.cookie}; ${sessionCookie}`, 'x-csrf-token': pair.token },
      payload: { email: ownerEmail, code: nextCode }
    });
    expect(rotated.statusCode).toBe(200);
    const newSessionCookie = setCookies(rotated).find((value) => value.startsWith('zf_session='));
    expect(newSessionCookie).toBeDefined();
    expect(newSessionCookie).not.toBe(sessionCookie);
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: `${pair.cookie}; ${sessionCookie}` } });
    expect(me.statusCode).toBe(401);
    const newMe = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: `${pair.cookie}; ${newSessionCookie}` } });
    expect(newMe.statusCode).toBe(200);
    expect((newMe.json() as { user: { email: string } }).user.email).toBe(ownerEmail);
    const logoutAll = await app.inject({ method: 'POST', url: '/api/v1/auth/logout-all', headers: { cookie: `${pair.cookie}; ${newSessionCookie}`, 'x-csrf-token': pair.token } });
    expect(logoutAll.statusCode).toBe(200);
    const revoked = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: `${pair.cookie}; ${newSessionCookie}` } });
    expect(revoked.statusCode).toBe(401);
  });

  it('rejects expired codes and invalidates prior codes when a new one is requested', async () => {
    const pair = await csrf();
    expect((await verifyToken('invalid-token', pair)).statusCode).toBe(400);
    const expiredCode = await issueOwnerToken(pair);
    sqlite.prepare('UPDATE auth_otps SET expires_at=? WHERE email=?').run(new Date(Date.now() - 1000).toISOString(), ownerEmail);
    expect((await verifyToken(expiredCode, pair)).json()).toEqual({
      error: { code: 'EXPIRED_CODE', message: 'This code expired. Request a new one.' }
    });

    const firstCode = await issueTokenFor('resend@example.test', pair);
    sqlite.prepare('UPDATE auth_otps SET created_at=? WHERE email=?').run(new Date(Date.now() - 61_000).toISOString(), 'resend@example.test');
    const secondCode = await issueTokenFor('resend@example.test', pair);
    expect((await verifyToken(firstCode, pair)).statusCode).toBe(400);
    expect((await verifyToken(secondCode, pair)).statusCode).toBe(200);
  });

  it('keeps signup generic after a delivery failure and stores only the OTP hash', async () => {
    const pair = await csrf();
    failNextTestEmails();

    const response = await requestLink(ownerEmail, pair);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, message: 'If the address is eligible, a sign-in code will arrive shortly.' });
    expect((sqlite.prepare('SELECT COUNT(*) AS count FROM auth_otps WHERE email=?').get(ownerEmail) as { count: number }).count).toBe(1);
    expect(takeTestMails()).toHaveLength(0);
  });

  it('limits OTP sends per email and enforces the resend cooldown with Retry-After', async () => {
    const pair = await csrf();
    const first = await requestLink(ownerEmail, pair);
    expect(first.statusCode).toBe(200);
    const cooldown = await requestLink(ownerEmail, pair, '203.0.113.2');
    expect(cooldown.statusCode).toBe(429);
    expect(Number(cooldown.headers['retry-after'])).toBeGreaterThan(0);
    takeTestMails();
    for (let index = 1; index < 4; index++) {
      sqlite.prepare('UPDATE auth_otps SET created_at=? WHERE email=?').run(new Date(Date.now() - 61_000).toISOString(), ownerEmail);
      expect((await requestLink(ownerEmail, pair, `203.0.113.${index + 2}`)).statusCode).toBe(200);
    }
    const messages = takeTestMails();
    expect(messages).toHaveLength(3);
    sqlite.prepare('UPDATE auth_otps SET created_at=? WHERE email=?').run(new Date(Date.now() - 61_000).toISOString(), ownerEmail);
    const limited = await requestLink(ownerEmail, pair, '203.0.113.20');
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(takeTestMails()).toHaveLength(0);
  });

  it('limits OTP sends per IP even when each attempt uses a different email', async () => {
    const pair = await csrf();
    for (let index = 0; index < 20; index++) {
      expect((await requestLink(`ip-limit-${index}@example.test`, pair, '203.0.113.80')).statusCode).toBe(200);
    }
    takeTestMails();
    const limited = await requestLink('ip-limit-final@example.test', pair, '203.0.113.80');
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(takeTestMails()).toHaveLength(0);
  });

  it('locks a code after five failed attempts and enforces verification rate limits', async () => {
    const pair = await csrf();
    const actualCode = await issueTokenFor('verify-email@example.test', pair);
    const incorrect = actualCode === '000000' ? '000001' : '000000';
    for (let index = 0; index < 4; index++) {
      expect((await verifyToken(incorrect, pair, `203.0.113.${100 + index}`, 'verify-email@example.test')).statusCode).toBe(400);
    }
    const locked = await verifyToken(incorrect, pair, '203.0.113.110', 'verify-email@example.test');
    expect(locked.statusCode).toBe(429);
    expect((locked.json() as { error: { code: string } }).error.code).toBe('TOO_MANY_ATTEMPTS');
    const otp = sqlite.prepare('SELECT attempts,consumed_at FROM auth_otps WHERE email=?').get('verify-email@example.test') as { attempts: number; consumed_at: string };
    expect(otp.attempts).toBe(5);
    expect(otp.consumed_at).toBeTruthy();
  });

  it('rate-limits verification by both IP and normalized email', async () => {
    const pair = await csrf();
    for (let index = 0; index < 20; index++) {
      expect((await verifyToken('123456', pair, '203.0.113.150', `ip-${index}@example.test`)).statusCode).toBe(400);
    }
    const ipLimited = await verifyToken('123456', pair, '203.0.113.150', 'ip-final@example.test');
    expect(ipLimited.statusCode).toBe(429);
    expect(Number(ipLimited.headers['retry-after'])).toBeGreaterThan(0);

    for (let index = 0; index < 10; index++) {
      expect((await verifyToken('123456', pair, `203.0.113.${index + 160}`, 'email-limit@example.test')).statusCode).toBe(400);
    }
    const emailLimited = await verifyToken('123456', pair, '203.0.113.180', 'email-limit@example.test');
    expect(emailLimited.statusCode).toBe(429);
    expect(Number(emailLimited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('normalizes emails and stores OTPs as HMAC-SHA256 hashes', async () => {
    const pair = await csrf();
    const code = await issueTokenFor('  Hashed-Token@Example.Test  ', pair);
    const email = 'hashed-token@example.test';
    expect(otpEmails.get(code)).toBe(email);
    const stored = sqlite.prepare('SELECT code_hash FROM auth_otps WHERE email=?').get(email) as { code_hash: string };
    const expectedHash = createHmac('sha256', process.env.LOGIN_SECRET!).update(`${email}:${code}`).digest('hex');
    expect(stored.code_hash).not.toBe(code);
    expect(stored.code_hash).toBe(expectedHash);
  });

  it('returns the same invalid-code failure for deactivated accounts', async () => {
    const pair = await csrf();
    const code = await issueTokenFor('disabled@example.test', pair);
    const stamp = new Date().toISOString();
    sqlite.prepare("INSERT INTO users(id,email,timezone,locale,settings_json,role,active,created_at,updated_at) VALUES(?,?,?,?,?,'user',0,?,?)")
      .run(randomUUID(), 'disabled@example.test', 'UTC', 'en-GB', '{}', stamp, stamp);
    const disabled = await verifyToken(code, pair, '198.51.100.4');
    const wrongCode = code === '000000' ? '000001' : '000000';
    const invalid = await verifyToken(wrongCode, pair, '198.51.100.5', 'disabled@example.test');
    expect(disabled.statusCode).toBe(invalid.statusCode);
    expect(disabled.json()).toEqual(invalid.json());
  });

  it('cleans expired OTP rows when a new code is requested', async () => {
    const pair = await csrf();
    const expired = await issueTokenFor('cleanup@example.test', pair);
    expect(expired).toHaveLength(6);
    sqlite.prepare('UPDATE auth_otps SET expires_at=? WHERE email=?').run(new Date(Date.now() - 1000).toISOString(), 'cleanup@example.test');
    await issueTokenFor('cleanup@example.test', pair);
    expect((sqlite.prepare('SELECT COUNT(*) AS count FROM auth_otps WHERE email=? AND expires_at<?').get('cleanup@example.test', new Date().toISOString()) as { count: number }).count).toBe(0);
  });
});

describe('multi-user signup and administration', () => {
  it('grants administrator role only to the configured ADMIN_EMAIL', async () => {
    const { config } = await import('./config.js');
    const previousAdminEmail = config.ADMIN_EMAIL;
    config.ADMIN_EMAIL = 'designated@example.test';
    try {
      const pair = await csrf();
      const memberCode = await issueTokenFor('member@example.test', pair);
      const member = await verifyToken(memberCode, pair);
      expect((member.json() as { user: { role: string } }).user.role).toBe('user');

      const adminCode = await issueTokenFor('designated@example.test', pair);
      const admin = await verifyToken(adminCode, pair);
      expect((admin.json() as { user: { role: string } }).user.role).toBe('admin');
    } finally {
      config.ADMIN_EMAIL = previousAdminEmail;
    }
  });

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
  it('reactivates unchanged pending reminders after an item edit and replaces changed times', async () => {
    const userId = randomUUID(), meetingId = randomUUID(), stamp = new Date().toISOString();
    sqlite.prepare('INSERT INTO users(id,email,timezone,locale,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(userId, ownerEmail, 'Europe/London', 'en-GB', '{}', stamp, stamp);
    const date = DateTime.now().setZone('Europe/London').plus({ days: 3 }).toISODate()!;
    const meeting = { id: meetingId, title: 'Review', date, start: '10:00', end: '11:00', status: 'Scheduled', reminderLeadMinutes: [60,15] };
    await scheduleEntityReminders(userId, 'meeting', meeting, 'Europe/London', { emailEnabled: true, pushEnabled: true });
    await scheduleEntityReminders(userId, 'meeting', meeting, 'Europe/London', { emailEnabled: true, pushEnabled: true });
    expect((sqlite.prepare("SELECT COUNT(*) AS count FROM reminders WHERE state='pending'").get() as {count:number}).count).toBe(4);

    const moved = { ...meeting, date: DateTime.fromISO(date).plus({days:1}).toISODate()! };
    await scheduleEntityReminders(userId, 'meeting', moved, 'Europe/London', { emailEnabled: true, pushEnabled: true });
    expect((sqlite.prepare("SELECT COUNT(*) AS count FROM reminders WHERE state='pending'").get() as {count:number}).count).toBe(4);
    expect((sqlite.prepare("SELECT COUNT(*) AS count FROM reminders WHERE state='cancelled'").get() as {count:number}).count).toBe(4);
  });

  it('fires date-only task reminders at 09:00 local time', async () => {
    const userId = randomUUID(), taskId = randomUUID(), stamp = new Date().toISOString();
    sqlite.prepare('INSERT INTO users(id,email,timezone,locale,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(userId, ownerEmail, 'Europe/London', 'en-GB', '{}', stamp, stamp);
    const dueDate = DateTime.now().setZone('Europe/London').plus({ days: 3 }).toISODate()!;
    await scheduleEntityReminders(userId, 'task', { id:taskId, title:'Prepare', dueDate, dueTime:'', status:'To Do' }, 'Europe/London', { emailEnabled:true, pushEnabled:false });
    const reminder = sqlite.prepare("SELECT fire_at FROM reminders WHERE target_type='task' AND target_id=?").get(taskId) as {fire_at:string};
    expect(reminder.fire_at).toBe(localToUtc(dueDate,'09:00','Europe/London'));
  });

  it('defers 08:00 meeting follow-ups until quiet hours end', async () => {
    const userId=randomUUID(),meetingId=randomUUID(),stamp=new Date().toISOString();
    sqlite.prepare('INSERT INTO users(id,email,timezone,locale,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(userId,ownerEmail,'Europe/London','en-GB','{}',stamp,stamp);
    const followUpDate=DateTime.now().setZone('Europe/London').plus({days:4}).toISODate()!;
    const meetingDate=DateTime.fromISO(followUpDate).minus({days:1}).toISODate()!;
    await scheduleEntityReminders(userId,'meeting',{id:meetingId,title:'Follow-up call',date:meetingDate,start:'10:00',end:'10:30',status:'Completed',followUpDate,reminderLeadMinutes:null},'Europe/London',{emailEnabled:true,pushEnabled:false,followUpEnabled:true,quietStart:'07:00',quietEnd:'09:30'});
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
