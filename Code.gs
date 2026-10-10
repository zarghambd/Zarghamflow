/**
 * ZarghamFlow – Google companion script
 * Runs inside YOUR Google account. It
 *   1) stores meetings and tasks in a private Google spreadsheet,
 *   2) adds / updates / removes your meetings in Google Calendar, and
 *   3) emails you reminders (task deadlines, upcoming meetings, follow-ups) every 5 minutes,
 *      even when the ZarghamFlow page is closed.
 * Deploy as: Web app · Execute as: Me · Who has access: Anyone.
 * Only requests that carry the secret TOKEN below are accepted.
 */
var TOKEN = 'PASTE_YOUR_TOKEN_HERE';
var P = PropertiesService.getScriptProperties();
var CHUNK = 3000;

/* ---------------- Web app entry points ---------------- */
function doGet() { return out_({ ok: true, message: 'ZarghamFlow script is running.' }); }

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
    var body = JSON.parse(e.postData.contents);
    if (body.token !== TOKEN) return out_({ ok: false, error: 'Wrong token – copy the setup script again from the app.' });
    if (body.action === 'test') return out_(test_(body));
    if (body.action === 'load') return out_(loadDatabase_());
    if (body.action === 'sync') return out_(sync_(body));
    return out_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return out_({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- Small helpers ---------------- */
function validEmail_(s) { return typeof s === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s); }
function esc_(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

/* Script properties hold max 9 KB per value, so larger JSON is stored in chunks */
function setBig_(key, str) {
  var n = Math.ceil(str.length / CHUNK) || 1, old = Number(P.getProperty(key + '#n') || 0), o = {}, i;
  o[key + '#n'] = String(n);
  for (i = 0; i < n; i++) o[key + '#' + i] = str.substr(i * CHUNK, CHUNK);
  P.setProperties(o);
  for (i = n; i < old; i++) P.deleteProperty(key + '#' + i);
}
function getBig_(key) {
  var n = Number(P.getProperty(key + '#n') || 0), s = '', i;
  for (i = 0; i < n; i++) s += P.getProperty(key + '#' + i) || '';
  return s;
}

function ensureTrigger_() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'checkReminders'; });
  if (!exists) ScriptApp.newTrigger('checkReminders').timeBased().everyMinutes(5).create();
}

function ensureDatabase_() {
  var id = P.getProperty('databaseId'), ss;
  if (id) ss = SpreadsheetApp.openById(id);
  else {
    ss = SpreadsheetApp.create('ZarghamFlow Database');
    P.setProperty('databaseId', ss.getId());
  }
  var meetings = ss.getSheetByName('Meetings');
  if (!meetings) { meetings = ss.getSheets()[0]; meetings.setName('Meetings'); }
  var tasks = ss.getSheetByName('Tasks') || ss.insertSheet('Tasks');
  [meetings, tasks].forEach(function (sheet) {
    if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, 2).setValues([['id', 'record_json']]);
  });
  return ss;
}

function readRecords_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, 2).getValues().map(function (row) {
    try { return JSON.parse(row[1]); } catch (e) { return null; }
  }).filter(function (record) { return record && typeof record === 'object' && record.id; });
}

function writeRecords_(sheet, records) {
  sheet.clearContents();
  sheet.getRange(1, 1, 1, 2).setValues([['id', 'record_json']]);
  if (records.length) {
    sheet.getRange(2, 1, records.length, 2).setValues(records.map(function (record) {
      return [String(record.id || ''), JSON.stringify(record)];
    }));
  }
}

function loadDatabase_() {
  var ss = ensureDatabase_();
  return {
    ok: true,
    initialized: P.getProperty('databaseInitialized') === 'true',
    databaseUrl: ss.getUrl(),
    meetings: readRecords_(ss.getSheetByName('Meetings')),
    tasks: readRecords_(ss.getSheetByName('Tasks'))
  };
}

/* ---------------- Test ---------------- */
function test_(b) {
  var user = Session.getEffectiveUser().getEmail();
  CalendarApp.getDefaultCalendar().getName();               // makes sure Calendar permission is granted
  var sent = false;
  if (validEmail_(b.email)) {
    MailApp.sendEmail({
      to: b.email, name: 'ZarghamFlow', subject: 'ZarghamFlow – test email',
      body: 'It works! You will receive task, meeting and follow-up reminders at this address.'
    });
    sent = true;
  }
  ensureTrigger_();
  return { ok: true, user: user, emailSent: sent };
}

/* ---------------- Sync: calendar + store data for reminders ---------------- */
function sync_(b) {
  var tz = b.tz || Session.getScriptTimeZone(), prefs = b.prefs || {};
  var records = b.records || {}, ss = ensureDatabase_();
  writeRecords_(ss.getSheetByName('Meetings'), Array.isArray(records.meetings) ? records.meetings : []);
  writeRecords_(ss.getSheetByName('Tasks'), Array.isArray(records.tasks) ? records.tasks : []);
  P.setProperty('databaseInitialized', 'true');
  var cal = syncCalendar_(b, tz, prefs);
  var keep = (b.meetings || []).map(function (m) {
    return { id: m.id, title: m.title, date: m.date, start: m.start, end: m.end, client: m.client, location: m.location, followUp: m.followUp, status: m.status };
  });
  setBig_('data', JSON.stringify({ email: b.email, tz: tz, prefs: prefs, tasks: b.tasks || [], meetings: keep }));
  ensureTrigger_();
  return { ok: true, calendar: cal, tasks: (records.tasks || []).length, meetings: (records.meetings || []).length, databaseUrl: ss.getUrl() };
}

function safeGet_(calendar, id) { try { return calendar.getEventById(id); } catch (e) { return null; } }
function delEvent_(calendar, entry) { var ev = safeGet_(calendar, entry.e); if (ev) { try { ev.deleteEvent(); } catch (e) {} } }

/* Only touches events this script created (tracked in "calmap") – never your other events */
function syncCalendar_(b, tz, prefs) {
  var res = { created: 0, updated: 0, deleted: 0, errors: 0 };
  var map = JSON.parse(getBig_('calmap') || '{}');
  var calendar = CalendarApp.getDefaultCalendar();
  var all = {};
  (b.allMeetingIds || []).forEach(function (id) { all[id] = 1; });

  Object.keys(map).forEach(function (id) {                  // meeting deleted in the app → remove event
    if (!all[id]) { delEvent_(calendar, map[id]); delete map[id]; res.deleted++; }
  });
  if (prefs.calendarOn === false) { setBig_('calmap', JSON.stringify(map)); return res; }

  (b.meetings || []).forEach(function (m) {
    var active = m.cal && (m.status === 'Scheduled' || m.status === 'Completed');
    var cur = map[m.id];
    try {
      if (!active) { if (cur) { delEvent_(calendar, cur); delete map[m.id]; res.deleted++; } return; }
      var start = Utilities.parseDate(m.date + ' ' + m.start, tz, 'yyyy-MM-dd HH:mm');
      var end = Utilities.parseDate(m.date + ' ' + m.end, tz, 'yyyy-MM-dd HH:mm');
      var lead = Math.max(1, Math.min(prefs.meetingLeadMinutes || 30, 40320));
      var sig = [m.title, m.date, m.start, m.end, m.location, m.client, m.contacts, m.type, m.notes, lead].join('|');
      if (cur && cur.s === sig) return;                     // unchanged
      var desc = [m.type + (m.client ? ' · ' + m.client : ''), m.contacts ? 'With: ' + m.contacts : '', m.notes ? '\nAgenda / notes:\n' + m.notes : '', '\n— ZarghamFlow']
        .filter(function (x) { return x; }).join('\n');
      var ev = cur ? safeGet_(calendar, cur.e) : null;
      if (ev) { ev.setTitle(m.title); ev.setTime(start, end); ev.setLocation(m.location || ''); ev.setDescription(desc); res.updated++; }
      else { ev = calendar.createEvent(m.title, start, end, { location: m.location || '', description: desc }); res.created++; }
      ev.removeAllReminders();
      ev.addPopupReminder(lead);
      map[m.id] = { e: ev.getId(), s: sig };
    } catch (err) { res.errors++; res.lastError = String(err); }
  });
  setBig_('calmap', JSON.stringify(map));
  return res;
}

/* ---------------- Reminder emails (runs every 5 minutes via trigger) ---------------- */
function checkReminders() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    var raw = getBig_('data');
    if (!raw) return;
    var d = JSON.parse(raw), prefs = d.prefs || {}, tz = d.tz || Session.getScriptTimeZone();
    if (!validEmail_(d.email) || prefs.emailOn === false) return;

    var now = Date.now(), sent = JSON.parse(getBig_('sent') || '{}'), items = [], keys = [];
    var DAY = 864e5;
    function ts(date, time) { return Utilities.parseDate(date + ' ' + time, tz, 'yyyy-MM-dd HH:mm').getTime(); }
    function fmt(ms, pat) { return Utilities.formatDate(new Date(ms), tz, pat); }
    var taskLead = (prefs.taskLeadHours || 24) * 3600000, meetLead = (prefs.meetingLeadMinutes || 60) * 60000;

    (d.tasks || []).forEach(function (t) {
      var timed = !!t.dueTime;
      var ref = ts(t.dueDate, timed ? t.dueTime : '09:00');         // date-only tasks: window opens 09:00
      var end = ts(t.dueDate, timed ? t.dueTime : '23:59');         // …and they are due by end of day
      var base = t.id + ':' + t.dueDate + (t.dueTime || '');
      var detail = 'Due ' + (timed ? fmt(end, 'EEE d MMM, HH:mm') : fmt(end, 'EEE d MMM')) +
        (t.client ? ' · ' + t.client : '') + ' · ' + t.priority + ' priority · ' + t.category;
      if (now >= ref - taskLead && now < end && !sent['s:' + base]) {
        items.push({ label: 'Task due soon', title: t.title, detail: detail }); keys.push('s:' + base);
      } else if (prefs.overdueOn !== false && now >= end && now < end + 3 * DAY && !sent['o:' + base]) {
        items.push({ label: 'Task OVERDUE', title: t.title, detail: detail }); keys.push('o:' + base);
      }
    });

    (d.meetings || []).forEach(function (m) {
      if (m.status === 'Scheduled') {
        var st = ts(m.date, m.start), k = 'm:' + m.id + ':' + m.date + m.start;
        if (now >= st - meetLead && now < st && !sent[k]) {
          items.push({ label: 'Meeting starting soon', title: m.title,
            detail: fmt(st, 'EEE d MMM, HH:mm') + '–' + m.end + (m.client ? ' · ' + m.client : '') + (m.location ? ' · ' + m.location : '') });
          keys.push(k);
        }
      }
      if (prefs.followUpOn !== false && m.followUp && m.status !== 'Cancelled') {
        var f = ts(m.followUp, '08:00'), kf = 'f:' + m.id + ':' + m.followUp;
        if (now >= f && now < f + DAY && !sent[kf]) {
          items.push({ label: 'Follow-up due today', title: m.title, detail: 'After your meeting on ' + m.date + (m.client ? ' · ' + m.client : '') });
          keys.push(kf);
        }
      }
    });

    Object.keys(sent).forEach(function (k) { if (now - sent[k] > 45 * DAY) delete sent[k]; });   // tidy old keys
    if (!items.length) { setBig_('sent', JSON.stringify(sent)); return; }

    var subject = items.length === 1 ? 'ZarghamFlow: ' + items[0].label + ' – ' + items[0].title : 'ZarghamFlow: ' + items.length + ' reminders';
    var text = items.map(function (i) { return i.label.toUpperCase() + '\n' + i.title + '\n' + i.detail; }).join('\n\n');
    var html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1b2330">' + items.map(function (i) {
      return '<div style="border-left:4px solid ' + (/OVERDUE/.test(i.label) ? '#d92d20' : '#2f5bea') + ';padding:4px 12px;margin:0 0 14px">' +
        '<div style="font-size:12px;color:#667085;text-transform:uppercase;letter-spacing:.04em">' + esc_(i.label) + '</div>' +
        '<div style="font-size:16px;font-weight:600">' + esc_(i.title) + '</div><div style="color:#667085">' + esc_(i.detail) + '</div></div>';
    }).join('') + '<div style="font-size:12px;color:#98a2b3">Sent by your ZarghamFlow script.</div></div>';

    MailApp.sendEmail({ to: d.email, name: 'ZarghamFlow', subject: subject, body: text, htmlBody: html });
    keys.forEach(function (k) { sent[k] = now; });          // mark as sent only after the mail went out
    setBig_('sent', JSON.stringify(sent));
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}
