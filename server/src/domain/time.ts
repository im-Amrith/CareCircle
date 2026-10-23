/**
 * Timezone helpers. Care schedules are wall-clock times in the family's timezone
 * ("8 pm in Rose's kitchen"), so every date/time decision goes through these.
 * Uses only Intl, no extra dependencies.
 */

export interface LocalParts {
  /** YYYY-MM-DD in the target timezone */
  date: string;
  /** HH:MM (24h) in the target timezone */
  time: string;
  /** Minutes since local midnight */
  minutes: number;
  /** 0 = Sunday */
  weekday: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short'
    });
    partsCache.set(tz, f);
  }
  return f;
}

function rawParts(d: Date, tz: string) {
  const out: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(d)) out[p.type] = p.value;
  return out;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function localParts(d: Date, tz: string): LocalParts {
  const p = rawParts(d, tz);
  const hour = Number(p.hour) % 24;
  const minute = Number(p.minute);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${String(hour).padStart(2, '0')}:${p.minute}`,
    minutes: hour * 60 + minute,
    weekday: WEEKDAYS.indexOf(p.weekday)
  };
}

/** Offset of `tz` from UTC at instant `d`, in milliseconds (positive east of Greenwich). */
function tzOffsetMs(d: Date, tz: string): number {
  const p = rawParts(d, tz);
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second)
  );
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/** Converts a wall-clock date + time in `tz` to the UTC instant. */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let result = guess - tzOffsetMs(new Date(guess), tz);
  // Second pass corrects for DST transitions between guess and result.
  result = guess - tzOffsetMs(new Date(result), tz);
  return new Date(result);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

export function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/** "20:00" -> "8 pm", "07:45" -> "7:45 am", "12:00" -> "noon". Voice friendly. */
export function spokenTime(time: string): string {
  const [h, m] = time.split(':').map(Number);
  if (h === 12 && m === 0) return 'noon';
  if (h === 0 && m === 0) return 'midnight';
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12} ${suffix}` : `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** Days between two YYYY-MM-DD dates (b - a). */
export function daysBetween(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  return Math.round((tb - ta) / 86_400_000);
}

export function spokenDate(date: string, today: string): string {
  const diff = daysBetween(today, date);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const weekday = dt.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const month = dt.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  return diff > 1 && diff < 7 ? weekday : `${weekday}, ${month} ${d}`;
}

/** "Sunday" for a YYYY-MM-DD date. */
export function weekdayName(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}
