import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import webpush from 'web-push';
import { dbAll, dbGet, dbRun, dbTransaction } from '../db/index.js';
import { config } from '../config.js';
import { sendMail } from '../mail.js';
import { localToUtc } from './time.js';
import { sha256 } from '../security.js';
import { applyQuietHours } from './time.js';

export type DueReminder = { id: string; user_id: string; target_type: string; target_id: string; channel: 'email' | 'push'; attempts: number };
type Owner = { email: string };
type Subscription = { endpoint: string; p256dh: string; auth: string };
let lastTickAt = 0;

if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(config.VAPID_SUBJECT, config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY);
}

export async function scheduleEntityReminders(userId: string, type: 'task' | 'meeting', record: Record<string, unknown>, timezone: string, prefs: Record<string, unknown>): Promise<void> {
  const now = new Date().toISOString();
  const targetId = String(record.id);
  await dbRun("UPDATE reminders SET state = 'cancelled', updated_at = ? WHERE user_id = ? AND target_type = ? AND target_id = ? AND state IN ('pending','failed')", [now, userId, type, targetId]);
  const leads = record.reminderLeadMinutes as number[] | null | undefined;
  if (type === 'task' && record.status === 'Done') return;
  if (type === 'meeting' && !['Scheduled', 'Completed'].includes(String(record.status))) return;
  const channels: Array<'email' | 'push'> = [];
  if (prefs.emailEnabled !== false) channels.push('email');
  if (prefs.pushEnabled !== false) channels.push('push');
  if (!channels.length) return;
  const dueDate = String(type === 'task' ? record.dueDate : record.date);
  const dateOnlyTask = type === 'task' && !record.dueTime;
  const dueTime = String(type === 'task' ? (record.dueTime || '23:59') : record.start);
  const due = DateTime.fromISO(`${dueDate}T${dueTime}`, { zone: timezone });
  const effectiveLeads = leads === null ? [] : leads ?? (dateOnlyTask ? [0] : type === 'task' ? [1440, 60] : [60, 15]);
  const insert = async (id: string, targetType: string, fire: string, channel: string, lead: number, dedupeKey: string): Promise<void> => dbRun(`INSERT INTO reminders
    (id,user_id,target_type,target_id,fire_at,channel,lead,state,attempts,created_at,updated_at,dedupe_key)
    VALUES (?,?,?,?,?,?,?,'pending',0,?,?,?)
    ON CONFLICT(dedupe_key) DO UPDATE SET fire_at=excluded.fire_at,state='pending',attempts=0,last_error=NULL,sent_at=NULL,updated_at=excluded.updated_at
    WHERE reminders.state IN ('cancelled','failed')`, [id,userId,targetType,targetId,fire,channel,lead,now,now,dedupeKey]).then(() => undefined);
  for (const lead of effectiveLeads) {
    const base = dateOnlyTask && lead === 0 ? due.set({ hour: 9, minute: 0 }) : due.minus({ minutes: lead });
    const fire = applyQuietHours(base, timezone, String(prefs.quietStart ?? '') || null, String(prefs.quietEnd ?? '') || null, type === 'meeting' && lead <= 30 ? due : null).toUTC().toISO();
    if (!fire || DateTime.fromISO(fire) <= DateTime.now()) continue;
    for (const channel of channels) await insert(randomUUID(), type, fire, channel, lead, `${type}:${targetId}:${fire}:${channel}`);
  }
  if (type === 'task' && prefs.overdueEnabled !== false && record.status !== 'Done') {
    for (let day = 1; day <= 3; day++) {
      const localDate = DateTime.fromISO(dueDate, { zone: timezone }).plus({ days: day }).toISODate();
      if (!localDate) continue;
      const localFire = DateTime.fromISO(`${localDate}T09:00`, { zone: timezone });
      const fire = applyQuietHours(localFire, timezone, String(prefs.quietStart ?? '') || null, String(prefs.quietEnd ?? '') || null).toUTC().toISO();
      if (!fire || DateTime.fromISO(fire) <= DateTime.now()) continue;
      for (const channel of channels) await insert(randomUUID(), 'overdue', fire, channel, 0, `overdue:${targetId}:${localDate}:${channel}`);
    }
  }
  if (type === 'meeting' && prefs.followUpEnabled !== false && record.followUpDate) {
    const localFire = DateTime.fromISO(`${record.followUpDate}T08:00`, { zone: timezone });
    const fire = applyQuietHours(localFire, timezone, String(prefs.quietStart ?? '') || null, String(prefs.quietEnd ?? '') || null).toUTC().toISO();
    if (fire && DateTime.fromISO(fire) > DateTime.now()) {
      for (const channel of channels) await insert(randomUUID(), 'followup', fire, channel, 0, `followup:${targetId}:${record.followUpDate}:${channel}`);
    }
  }
}

async function claimDue(now: string): Promise<DueReminder[]> {
  return dbTransaction(async (database) => {
    const rows = await database.all<DueReminder>(`SELECT id,user_id,target_type,target_id,channel,attempts FROM reminders
      WHERE state = 'pending' AND fire_at <= ? ORDER BY fire_at LIMIT 50`, [now]);
    const claimed: DueReminder[] = [];
    for (const row of rows) {
      const result = await database.run("UPDATE reminders SET state = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ? AND state = 'pending'", [now, row.id]);
      if (result.changes === 1) claimed.push(row);
    }
    return claimed;
  });
}

async function deliver(reminder: DueReminder): Promise<void> {
  const owner = await dbGet<Owner>('SELECT email FROM users WHERE id = ?', [reminder.user_id]);
  if (!owner) throw new Error('Owner account missing');
  if (reminder.target_type === 'digest') {
    await deliverDigest(reminder, owner.email);
    return;
  }
  const item = ['task', 'overdue'].includes(reminder.target_type)
    ? await dbGet('SELECT title,due_date AS date,due_time AS time,client,priority AS detail FROM tasks WHERE id = ? AND user_id=? AND deleted_at IS NULL', [reminder.target_id,reminder.user_id])
    : await dbGet('SELECT title,date,start AS time,"end",client,type AS detail,location,notes FROM meetings WHERE id = ? AND user_id=? AND deleted_at IS NULL', [reminder.target_id,reminder.user_id]);
  if (!item) return;
  const record = item as { title: string; date: string; time: string | null; end?: string; client: string; detail: string; location?: string; notes?: string };
  const title = reminder.target_type === 'followup' ? `Follow-up: ${record.title}` : record.title;
  const detail = `${record.date}${record.time ? ` ${record.time}` : ''}${record.client ? ` · ${record.client}` : ''}${record.detail ? ` · ${record.detail}` : ''}`;
  if (reminder.channel === 'email') {
    const subject = `ZarghamFlow reminder: ${title}`;
    const actions = ['task', 'overdue'].includes(reminder.target_type) ? await createActionLinks(owner.email, reminder.target_id) : null;
    const actionText = actions ? `\nMark done: ${actions.done}\nSnooze 1 hour: ${actions.snooze}` : '';
    const actionHtml = actions ? `<p><a href="${actions.done}">Mark done</a> · <a href="${actions.snooze}">Snooze 1 hour</a></p>` : '';
    const attachments = ['meeting', 'followup'].includes(reminder.target_type) && record.end
      ? [{ filename: `zarghamflow-${record.date}.ics`, content: await meetingIcs(reminder.user_id, record), contentType: 'text/calendar; charset=utf-8' }]
      : undefined;
    await sendMail(owner.email, subject, `${title}\n${detail}${actionText}`, `<main style="font:16px/1.5 Arial,sans-serif;color:#1b2330"><h1 style="font-size:20px">${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>${actionHtml}<p>ZarghamFlow reminder</p></main>`, attachments);
  } else {
    const subscriptions = await dbAll<Subscription>('SELECT endpoint,p256dh,auth FROM push_subscriptions WHERE user_id = ?', [reminder.user_id]);
    const actions = ['task', 'overdue'].includes(reminder.target_type) ? await createActionLinks(owner.email, reminder.target_id) : null;
    const payload = JSON.stringify({ title, body: detail, url: '/', actions: actions ? [{ action: 'done', title: 'Mark done', url: actions.done }, { action: 'snooze', title: 'Snooze 1 h', url: actions.snooze }] : [] });
    await Promise.all(subscriptions.map(async (subscription) => {
      try { await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, payload); }
      catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await dbRun('DELETE FROM push_subscriptions WHERE endpoint = ?', [subscription.endpoint]);
        else throw error;
      }
    }));
  }
}

async function meetingIcs(userId: string, meeting: { title: string; date: string; time: string | null; end?: string; location?: string; notes?: string }): Promise<string> {
  const timezone = (await dbGet<{ timezone: string }>('SELECT timezone FROM users WHERE id=?', [userId]))?.timezone ?? 'UTC';
  const utc = (time: string) => localToUtc(meeting.date, time, timezone).replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const esc = (value: string) => value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  return ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//ZarghamFlow//EN','BEGIN:VEVENT',`UID:${randomUUID()}@zarghamflow`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z')}`,
    `DTSTART:${utc(meeting.time ?? '09:00')}`,`DTEND:${utc(meeting.end ?? '10:00')}`,`SUMMARY:${esc(meeting.title)}`,`LOCATION:${esc(meeting.location ?? '')}`,`DESCRIPTION:${esc(meeting.notes ?? '')}`,'END:VEVENT','END:VCALENDAR'].join('\r\n')+'\r\n';
}

async function deliverDigest(reminder: DueReminder, email: string): Promise<void> {
  const account = await dbGet<{ timezone: string }>('SELECT timezone FROM users WHERE id=?', [reminder.user_id]);
  const timezone = account?.timezone ?? 'UTC';
  const date = reminder.target_id;
  const tasks = await dbAll<{ title: string; due_date: string; due_time: string | null; priority: string }>("SELECT title,due_date,due_time,priority FROM tasks WHERE user_id=? AND due_date=? AND status!='Done' AND deleted_at IS NULL ORDER BY due_time,title", [reminder.user_id, date]);
  const meetings = await dbAll<{ title: string; date: string; start: string; client: string; location: string }>("SELECT title,date,start,client,location FROM meetings WHERE user_id=? AND date=? AND status='Scheduled' AND deleted_at IS NULL ORDER BY start", [reminder.user_id, date]);
  const overdue = await dbAll<{ title: string; due_date: string; priority: string }>("SELECT title,due_date,priority FROM tasks WHERE user_id=? AND due_date<? AND status!='Done' AND deleted_at IS NULL ORDER BY due_date", [reminder.user_id, date]);
  const sections = [
    `Meetings today:\n${meetings.map((item) => `${item.start} ${item.title}${item.client ? ` · ${item.client}` : ''}`).join('\n') || 'None'}`,
    `Tasks due today:\n${tasks.map((item) => `${item.due_time ? `${item.due_time} ` : ''}${item.title} · ${item.priority}`).join('\n') || 'None'}`,
    `Overdue:\n${overdue.map((item) => `${item.title} · due ${item.due_date}`).join('\n') || 'None'}`
  ];
  const text = sections.join('\n\n');
  if (reminder.channel === 'email') await sendMail(email, `ZarghamFlow daily briefing · ${date}`, text, `<main style="font:16px/1.5 Arial,sans-serif;color:#1b2330"><h1>Daily briefing · ${escapeHtml(date)} (${escapeHtml(timezone)})</h1>${sections.map((section) => `<pre style="white-space:pre-wrap">${escapeHtml(section)}</pre>`).join('')}</main>`);
  else {
    const subscriptions = await dbAll<Subscription>('SELECT endpoint,p256dh,auth FROM push_subscriptions WHERE user_id=?', [reminder.user_id]);
    await Promise.all(subscriptions.map((subscription) => webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, JSON.stringify({ title: 'ZarghamFlow daily briefing', body: `${meetings.length} meetings · ${tasks.length} tasks due · ${overdue.length} overdue`, url: '/' }))));
  }
}

async function scheduleDailyDigests(now: Date): Promise<void> {
  const stamp = now.toISOString();
  const owners = await dbAll<{ id: string; timezone: string; prefs_json: string }>('SELECT users.id,users.timezone,reminder_prefs.prefs_json FROM users JOIN reminder_prefs ON reminder_prefs.user_id=users.id');
  for (const account of owners) {
    const prefs = JSON.parse(account.prefs_json) as Record<string, unknown>;
    if (prefs.digestEnabled !== true) continue;
    const localNow = DateTime.fromJSDate(now).setZone(account.timezone || 'UTC');
    const time = String(prefs.digestTime ?? '08:00');
    let digestDate = localNow.toISODate() ?? '';
    let fireAt: DateTime = DateTime.fromISO(`${digestDate}T${time}`, { zone: account.timezone || 'UTC' });
    if (fireAt <= localNow) {
      digestDate = localNow.plus({ days: 1 }).toISODate() ?? digestDate;
      fireAt = DateTime.fromISO(`${digestDate}T${time}`, { zone: account.timezone || 'UTC' });
    }
    fireAt = applyQuietHours(fireAt, account.timezone || 'UTC', String(prefs.quietStart ?? '') || null, String(prefs.quietEnd ?? '') || null);
    const channels = [prefs.emailEnabled !== false ? 'email' : null, prefs.pushEnabled !== false ? 'push' : null].filter((channel): channel is string => channel !== null);
    for (const channel of channels) await dbRun(`INSERT INTO reminders (id,user_id,target_type,target_id,fire_at,channel,lead,state,attempts,created_at,updated_at,dedupe_key)
      VALUES (?,?, 'digest', ?, ?, ?, 0, 'pending', 0, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [randomUUID(), account.id, digestDate, fireAt.toUTC().toISO(), channel, stamp, stamp, `digest:${account.id}:${digestDate}:${channel}`]);
  }
}

export function schedulerHeartbeat(): { lastTickAt: string | null; healthy: boolean } {
  return { lastTickAt: lastTickAt ? new Date(lastTickAt).toISOString() : null, healthy: lastTickAt > 0 && Date.now() - lastTickAt < 10 * 60_000 };
}

async function createActionLinks(email: string, taskId: string): Promise<{ done: string; snooze: string }> {
  const stamp = new Date().toISOString();
  const create = async (action: string): Promise<string> => {
    const token = randomUUID() + randomUUID().replace(/-/g, '');
    await dbRun(`INSERT INTO login_tokens (id,email,token_hash,kind,target_type,target_id,action,expires_at,created_at,ip_hash)
      VALUES (?,?,?,'action','task',?,?,?,?,'email-action')`, [randomUUID(), email, sha256(token), taskId, action, new Date(Date.now() + 24 * 60 * 60_000).toISOString(), stamp]);
    return new URL(`/api/v1/auth/actions/${token}`, config.APP_URL).toString();
  };
  const [done, snooze] = await Promise.all([create('done'), create('snooze')]);
  return { done, snooze };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

export async function runReminderTick(): Promise<void> {
  lastTickAt = Date.now();
  const now = new Date().toISOString();
  await scheduleDailyDigests(new Date(now));
  await dbRun("UPDATE reminders SET state = 'pending', updated_at = ? WHERE state = 'processing' AND updated_at < ?", [now, new Date(Date.now() - 5 * 60_000).toISOString()]);
  const due = await claimDue(now);
  for (const reminder of due) {
    try {
      await deliver(reminder);
      const sentAt = new Date().toISOString();
      await dbRun("UPDATE reminders SET state = 'sent', sent_at = ?, last_error = NULL, updated_at = ? WHERE id = ? AND state = 'processing'", [sentAt, sentAt, reminder.id]);
    } catch (error) {
      const attempts = reminder.attempts + 1;
      const retryAt = new Date(Date.now() + Math.min(60, 2 ** attempts) * 60_000).toISOString();
      const failed = attempts >= 6;
      await dbRun('UPDATE reminders SET state = ?, fire_at = ?, last_error = ?, updated_at = ? WHERE id = ? AND state = \'processing\'',
        [failed ? 'failed' : 'pending', retryAt, String(error).slice(0, 1000), now, reminder.id]);
      console.error(JSON.stringify({ level: 'error', event: 'reminder_delivery_failed', reminderId: reminder.id, attempts, error: String(error) }));
      if (failed && reminder.channel === 'email') {
        const recipient = await dbGet<Owner>('SELECT email FROM users WHERE id=?', [reminder.user_id]);
        if (recipient) void sendMail(recipient.email, 'ZarghamFlow reminder delivery failed', `Reminder ${reminder.id} failed after ${attempts} attempts. Error: ${String(error)}`).catch((alertError: unknown) => console.error(JSON.stringify({ level: 'error', event: 'reminder_alert_failed', error: String(alertError) })));
      }
    }
  }
}

export function startReminderScheduler(): ReturnType<typeof setInterval> {
  void runReminderTick();
  return setInterval(() => { void runReminderTick().catch((error: unknown) => console.error(JSON.stringify({ level: 'error', event: 'reminder_tick_failed', error: String(error) }))); }, 60_000);
}
