import { DateTime } from 'luxon';

export function localToUtc(date: string, time: string, timezone: string): string {
  const parsed = DateTime.fromISO(`${date}T${time}`, { zone: timezone });
  if (!parsed.isValid) throw new Error(`Invalid local time: ${date} ${time} (${timezone})`);
  if (parsed.toFormat("yyyy-MM-dd'T'HH:mm") !== `${date}T${time}`) throw new Error(`Local time does not exist because of a daylight-saving transition: ${date} ${time} (${timezone})`);
  return parsed.toUTC().toISO() ?? '';
}

export function applyQuietHours(instant: DateTime, timezone: string, start: string | null, end: string | null, meetingStart: DateTime | null = null): DateTime {
  if (!start || !end) return instant;
  const local = instant.setZone(timezone);
  const startMinutes = Number(start.slice(0, 2)) * 60 + Number(start.slice(3));
  const endMinutes = Number(end.slice(0, 2)) * 60 + Number(end.slice(3));
  const minute = local.hour * 60 + local.minute;
  const quiet = startMinutes <= endMinutes ? minute >= startMinutes && minute < endMinutes : minute >= startMinutes || minute < endMinutes;
  if (!quiet || (meetingStart && meetingStart.diff(instant).as('minutes') <= 30)) return instant;
  let endDay = local.startOf('day');
  if (startMinutes > endMinutes && minute >= startMinutes) endDay = endDay.plus({ days: 1 });
  const [hour, min] = end.split(':').map(Number);
  return endDay.set({ hour, minute: min, second: 0, millisecond: 0 });
}
