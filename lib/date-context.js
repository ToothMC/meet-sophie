// lib/date-context.js — deterministic date facts for Sophie's prompts.
//
// Language models get weekday/date arithmetic wrong ("next Friday is the 20th").
// So the server computes today's date, the next 14 days with weekdays, and whole-day
// calendar windows in the USER's time zone (sent by the browser as X-Sophie-Timezone),
// and Sophie only reads them. Fallback time zone: Europe/Berlin.

export const DEFAULT_TIME_ZONE = "Europe/Berlin";
export const DATE_LIST_DAYS = 14;

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_DE = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A valid IANA time zone or the fallback. */
export function resolveTimeZone(tz) {
  const s = String(tz || "").trim();
  if (s && s.length <= 64) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: s });
      return s;
    } catch { /* invalid → fallback */ }
  }
  return DEFAULT_TIME_ZONE;
}

/** The IANA time zone if valid, otherwise null (no fallback). */
export function validTimeZone(tz) {
  const s = String(tz || "").trim();
  if (!s || s.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s });
    return s;
  } catch {
    return null;
  }
}

/** Read the time zone header sent by the browser. */
export function timeZoneFromRequest(req) {
  return resolveTimeZone(req?.headers?.["x-sophie-timezone"]);
}

/** Calendar parts of an instant in a time zone. */
export function partsIn(date, tz) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const y = Number(p.year), m = Number(p.month), d = Number(p.day);
  return { y, m, d, hh: p.hour, mm: p.minute, weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

function offsetMs(instant, tz) {
  const p = partsIn(new Date(instant), tz);
  return Date.UTC(p.y, p.m - 1, p.d, Number(p.hh), Number(p.mm)) - Math.floor(instant / 60000) * 60000;
}

/** UTC instant of local midnight (y-m-d 00:00 in tz). DST-safe. */
export function localMidnightUtc(y, m, d, tz) {
  const guess = Date.UTC(y, m - 1, d, 0, 0);
  let t = guess - offsetMs(guess, tz);
  t = guess - offsetMs(t, tz); // second pass for DST transitions
  return new Date(t);
}

/** Calendar day i days after today (in tz), as plain parts. */
function addDays(today, i) {
  const dt = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), weekday: dt.getUTCDay() };
}

/** "Fri 16.10." */
export function shortLabel(day) {
  return `${WEEKDAY_SHORT[day.weekday]} ${String(day.d).padStart(2, "0")}.${String(day.m).padStart(2, "0")}.`;
}

/** List of the next `count` days starting today (in tz). */
export function nextDays(tz, count = DATE_LIST_DAYS, now = new Date()) {
  const today = partsIn(now, tz);
  return Array.from({ length: count }, (_, i) => ({ ...addDays(today, i), label: shortLabel(addDays(today, i)) }));
}

/**
 * Whole-day window: today 00:00 until the end of day (today + days - 1), in tz.
 * @returns {{ timeMin: Date, timeMax: Date, firstDay: object, lastDay: object }}
 */
export function wholeDayWindow(tz, days, now = new Date()) {
  const n = Math.max(1, Math.min(60, Math.round(Number(days) || DATE_LIST_DAYS)));
  const today = partsIn(now, tz);
  const firstDay = addDays(today, 0);
  const lastDay = addDays(today, n - 1);
  const after = addDays(today, n);
  return {
    timeMin: localMidnightUtc(firstDay.y, firstDay.m, firstDay.d, tz),
    timeMax: localMidnightUtc(after.y, after.m, after.d, tz),
    firstDay: { ...firstDay, label: shortLabel(firstDay) },
    lastDay: { ...lastDay, label: shortLabel(lastDay) },
  };
}

/** Prompt block (English — project rule). Text approved by Michael 2026-10-16. */
export function buildDateBlock(tz, now = new Date()) {
  const zone = resolveTimeZone(tz);
  const p = partsIn(now, zone);
  const days = nextDays(zone, DATE_LIST_DAYS, now);
  const list = days.map((d, i) => (i === 0 ? `${d.label} (today)` : d.label)).join(" · ");
  return `CURRENT DATE AND TIME (user's time zone ${zone}): ${WEEKDAY_LONG[p.weekday]}, ${p.d} ${MONTH_LONG[p.m - 1]} ${p.y}, ${p.hh}:${p.mm}.
Next ${DATE_LIST_DAYS} days: ${list}
Take dates and weekdays only from this list — never calculate them yourself.
"Next <weekday>" means its next occurrence after today; if today is that weekday, it means in 7 days. If the user's meaning is unclear, ask briefly.`;
}

/** "Friday, 16 October 2026" in the user's time zone. */
export function longToday(tz, now = new Date()) {
  const p = partsIn(now, resolveTimeZone(tz));
  return `${WEEKDAY_LONG[p.weekday]}, ${p.d} ${MONTH_LONG[p.m - 1]} ${p.y}`;
}

/** Formatted "today" in the user's time zone for a given locale (reports). */
export function localeToday(tz, locale, options = { day: "2-digit", month: "2-digit", year: "numeric" }, now = new Date()) {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: resolveTimeZone(tz) }).format(now);
}

/** "2026-10-16" in the user's time zone. */
export function isoToday(tz, now = new Date()) {
  const p = partsIn(now, resolveTimeZone(tz));
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** "Freitag, 16.10.2026" — for the (German) fact-check prompt. */
export function germanToday(tz, now = new Date()) {
  const p = partsIn(now, resolveTimeZone(tz));
  return `${WEEKDAY_DE[p.weekday]}, ${String(p.d).padStart(2, "0")}.${String(p.m).padStart(2, "0")}.${p.y}`;
}
