import { z } from 'zod';
import { UserError } from '../core/errors.js';

export const dateTimeInput = z.strictObject({
  day: z.union([z.enum(['today', 'tomorrow']), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  timeZone: z.string().min(1).max(100).nullable().optional(),
  durationMinutes: z.number().int().min(1).max(10080).nullable().optional(),
});
type DateParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };
const pad = (n: number, digits = 2) => String(n).padStart(digits, '0');
const dateLabel = (p: DateParts) => `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
const clockLabel = (p: DateParts) => `${pad(p.hour)}:${pad(p.minute)}`;
function formatter(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw new UserError('Use a valid IANA time zone, such as America/New_York.');
  }
}
function parts(format: Intl.DateTimeFormat, timestamp: number): DateParts {
  const values = Object.fromEntries(format.formatToParts(timestamp).map((p) => [p.type, p.value]));
  return Object.fromEntries(
    ['year', 'month', 'day', 'hour', 'minute', 'second'].map((key) => [key, Number(values[key])]),
  ) as DateParts;
}
function timestamp(p: DateParts): number {
  const value = new Date(Date.UTC(2000, p.month - 1, p.day, p.hour, p.minute, p.second));
  value.setUTCFullYear(p.year);
  return value.getTime();
}
/** Calendar addition is independent of DST and the host machine's time zone. */
export function localCalendarDates(timeZone: string, now = Date.now()): { today: string; tomorrow: string } {
  if (!Number.isFinite(now)) throw new UserError('The current time is unavailable.');
  const current = parts(formatter(timeZone), now);
  const next = new Date(timestamp({ ...current, hour: 0, minute: 0, second: 0 }) + 86400000);
  return { today: dateLabel(current), tomorrow: next.toISOString().slice(0, 10) };
}
/** Resolve wall-clock time by candidate offset and exact round trip; DST gaps/folds are never guessed. */
export function resolveDateTime(raw: unknown, options: { timeZone?: string; now?: number } = {}) {
  const input = dateTimeInput.parse(raw),
    timeZone = input.timeZone ?? options.timeZone ?? 'America/New_York',
    format = formatter(timeZone),
    dates = localCalendarDates(timeZone, options.now ?? Date.now()),
    day = input.day === 'today' ? dates.today : input.day === 'tomorrow' ? dates.tomorrow : input.day,
    [year, month, date] = day.split('-').map(Number),
    [hour, minute] = input.time.split(':').map(Number);
  const wanted: DateParts = {
      year: year!,
      month: month!,
      day: date!,
      hour: hour!,
      minute: minute!,
      second: 0,
    },
    naive = timestamp(wanted),
    check = new Date(naive);
  if (wanted.year < 1 || check.toISOString().slice(0, 10) !== day)
    throw new UserError('Use a valid calendar date in YYYY-MM-DD form.');
  const offsets = new Set<number>();
  // Both sides of all normal DST transitions, including half-hour changes and a skipped local day.
  for (let hours = -48; hours <= 48; hours += 6) {
    const sample = naive + hours * 3600000;
    offsets.add(timestamp(parts(format, sample)) - sample);
  }
  const matches = [...offsets]
    .map((offset) => naive - offset)
    .filter((candidate) => {
      const local = parts(format, candidate);
      return dateLabel(local) === day && clockLabel(local) === input.time && local.second === 0;
    });
  if (!matches.length)
    throw new UserError(
      `${day} at ${input.time} does not exist in ${timeZone} because the clocks change. Ask for another local time.`,
    );
  if (matches.length !== 1)
    throw new UserError(
      `${day} at ${input.time} occurs twice in ${timeZone} because the clocks change. Ask which UTC offset the member means, then resolve the explicit UTC time.`,
    );
  const start = matches[0]!,
    end = input.durationMinutes ? start + input.durationMinutes * 60000 : undefined;
  return {
    timeZone,
    localDate: day,
    localTime: input.time,
    startTime: new Date(start).toISOString(),
    ...(end === undefined
      ? {}
      : {
          durationMinutes: input.durationMinutes,
          endTime: new Date(end).toISOString(),
          endLocalDate: dateLabel(parts(format, end)),
          endLocalTime: clockLabel(parts(format, end)),
        }),
  };
}
