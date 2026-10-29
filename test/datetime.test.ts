import test from 'node:test';
import assert from 'node:assert/strict';
import { localCalendarDates, resolveDateTime } from '../src/features/datetime.js';

test('Tomorrow uses the local calendar date across a UTC midnight, not the UTC date', () => {
  const options = { timeZone: 'America/New_York', now: Date.parse('2026-10-30T02:00:00Z') };
  assert.deepEqual(localCalendarDates(options.timeZone, options.now), {
    today: '2026-10-29',
    tomorrow: '2026-10-30',
  });
  assert.deepEqual(resolveDateTime({ day: 'tomorrow', time: '21:00', durationMinutes: 120 }, options), {
    timeZone: 'America/New_York',
    localDate: '2026-10-30',
    localTime: '21:00',
    startTime: '2026-10-31T01:00:00.000Z',
    durationMinutes: 120,
    endTime: '2026-10-31T03:00:00.000Z',
    endLocalDate: '2026-10-30',
    endLocalTime: '23:00',
  });
});

test('Calendar arithmetic handles year boundaries and leap days independently of the host zone', () => {
  assert.deepEqual(localCalendarDates('UTC', Date.parse('2026-12-31T23:59:00Z')), {
    today: '2026-12-31',
    tomorrow: '2027-01-01',
  });
  assert.equal(
    resolveDateTime(
      { day: 'tomorrow', time: '12:00' },
      {
        timeZone: 'UTC',
        now: Date.parse('2028-02-28T23:00:00Z'),
      },
    ).startTime,
    '2028-02-29T12:00:00.000Z',
  );
});

test('DST skipped and repeated wall times require clarification rather than choosing an offset', () => {
  assert.throws(
    () => resolveDateTime({ day: '2026-03-08', time: '02:30', timeZone: 'America/New_York' }),
    /does not exist/,
  );
  assert.throws(
    () => resolveDateTime({ day: '2026-11-01', time: '01:30', timeZone: 'America/New_York' }),
    /occurs twice/,
  );
  assert.equal(
    resolveDateTime({ day: '2026-11-01', time: '03:30', timeZone: 'America/New_York' }).startTime,
    '2026-11-01T08:30:00.000Z',
  );
  assert.throws(
    () => resolveDateTime({ day: '2026-10-04', time: '02:15', timeZone: 'Australia/Lord_Howe' }),
    /does not exist/,
  );
  assert.throws(
    () => resolveDateTime({ day: '2026-04-05', time: '01:45', timeZone: 'Australia/Lord_Howe' }),
    /occurs twice/,
  );
});

test('Fractional-hour zones and elapsed durations crossing DST resolve exactly', () => {
  assert.equal(
    resolveDateTime({ day: '2026-10-30', time: '21:00', timeZone: 'Asia/Kathmandu' }).startTime,
    '2026-10-30T15:15:00.000Z',
  );
  const result = resolveDateTime({
    day: '2026-03-08',
    time: '01:30',
    timeZone: 'America/New_York',
    durationMinutes: 120,
  });
  assert.equal(result.startTime, '2026-03-08T06:30:00.000Z');
  assert.equal(result.endTime, '2026-03-08T08:30:00.000Z');
  assert.equal(result.endLocalTime, '04:30');
});

test('Invalid dates, clock forms, zones and historical skipped dates cannot produce a timestamp', () => {
  for (const raw of [
    { day: '2026-02-29', time: '12:00' },
    { day: '2026-13-01', time: '12:00' },
    { day: '0000-01-01', time: '12:00' },
    { day: 'tomorrow', time: '24:00' },
    { day: 'tomorrow', time: '9pm' },
    { day: 'tomorrow', time: '12:00', timeZone: 'Not/AZone' },
    { day: '2011-12-30', time: '12:00', timeZone: 'Pacific/Apia' },
  ])
    assert.throws(() => resolveDateTime(raw));
});
