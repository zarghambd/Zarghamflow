import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { applyQuietHours, localToUtc } from './time.js';

describe('local reminder time conversion', () => {
  it('converts London wall time to UTC across summer time', () => {
    expect(localToUtc('2026-07-10', '09:00', 'Europe/London')).toBe('2026-07-10T08:00:00.000Z');
    expect(localToUtc('2026-01-10', '09:00', 'Europe/London')).toBe('2026-01-10T09:00:00.000Z');
  });

  it('rejects a nonexistent local time in the spring DST gap', () => {
    expect(() => localToUtc('2026-03-29', '01:30', 'Europe/London')).toThrow(/daylight-saving/);
  });

  it('uses the first occurrence of an ambiguous autumn wall time', () => {
    expect(localToUtc('2026-10-25', '01:30', 'Europe/London')).toBe('2026-10-25T00:30:00.000Z');
  });

  it('defers reminders inside overnight quiet hours to local quiet end', () => {
    const fire = DateTime.fromISO('2026-10-10T22:30:00Z');
    const deferred = applyQuietHours(fire, 'Europe/London', '22:00', '07:30');
    expect(deferred.toUTC().toISO()).toBe('2026-10-11T06:30:00.000Z');
  });

  it('does not defer an imminent meeting reminder', () => {
    const fire = DateTime.fromISO('2026-10-10T22:30:00Z');
    const meeting = DateTime.fromISO('2026-10-10T22:45:00Z');
    expect(applyQuietHours(fire, 'Europe/London', '22:00', '07:30', meeting).toMillis()).toBe(fire.toMillis());
  });
});
