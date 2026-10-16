// lib/calendar-format.js — pure calendar formatting (no dependencies besides date-context),
// so the smoke tests can import it in CI without installed npm packages.

import { shortLabel, partsIn, validTimeZone } from './date-context.js';

// "2026-10-23T10:00:00+02:00" or "2026-10-23" (all-day) → epoch ms for sorting
export function eventInstant(iso) {
  const t = Date.parse(iso && iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isFinite(t) ? t : 0;
}

// Calendar day of an event start ("2026-10-23"). With a time zone, timed events are
// converted to the user's zone — an event saved as 10:00+02:00 is 11:00 in Cyprus and
// must be shown as such (16.10.2026). Without tz, or for all-day dates, the ISO date part.
function eventDayKey(iso, tz = null) {
  const s = String(iso || '');
  if (tz && s.length > 10) {
    const t = Date.parse(s);
    if (Number.isFinite(t)) {
      const p = partsIn(new Date(t), tz);
      return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    }
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function eventClock(iso, tz = null) {
  const s = String(iso || '');
  if (tz) {
    const t = Date.parse(s);
    if (Number.isFinite(t)) { const p = partsIn(new Date(t), tz); return `${p.hh}:${p.mm}`; }
  }
  const m = s.match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '';
}

/**
 * Date/time for the Google Calendar API, always in the USER's time zone.
 * Sophie used to guess an offset ("infer from existing events") and wrote 10:00+02:00
 * for a user in Cyprus (+03:00) → 11:00 in the calendar (16.10.2026). Now the clock
 * time is taken as the user's local time; any offset sent by the model is ignored.
 * @returns {{ dateTime: string, timeZone: string } | null}
 */
export function toGoogleDateTime(value, timeZone) {
  const tz = validTimeZone(timeZone);
  const m = String(value || '').match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!tz || !m) return null;
  return { dateTime: `${m[1]}T${m[2]}:${m[3]}:${m[4] || '00'}`, timeZone: tz };
}

/** Local end = local start + minutes (naive clock arithmetic, DST handled by Google). */
export function addMinutesLocal(googleDateTime, minutes) {
  const m = String(googleDateTime?.dateTime || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5] + minutes, +m[6]));
  const pad = (n) => String(n).padStart(2, '0');
  return { dateTime: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`, timeZone: googleDateTime.timeZone };
}

function dayKeyOf(day) {
  return `${day.y}-${String(day.m).padStart(2, '0')}-${String(day.d).padStart(2, '0')}`;
}

/**
 * Formatiert Events als Prompt-Kontext-Block.
 * Mit `range` (aus wholeDayWindow) sagt der Block ausdruecklich, fuer welche Tage
 * er vollstaendig ist — sonst schliesst das Modell aus "nicht in der Liste" auf
 * "kein Termin" (16.10.2026: 23.10. 10:00 lag hinter dem 7-Tage-Fenster).
 * Text englisch (Projektregel), freigegeben von Michael am 16.10.2026.
 * @param {Array} events — normalisierte Events
 * @param {string} language — ungenutzt (Block ist englisch), fuer Kompatibilitaet
 * @param {{ firstDay: object, lastDay: object, truncated?: boolean }} [range]
 * @returns {string}
 */
export function formatCalendarContext(events, language = 'de', range = null) {
  void language;
  const tz = validTimeZone(range?.tz);
  function lineFor(e) {
    const label = shortLabel(dayFromKey(eventDayKey(e.start, e.allDay ? null : tz)));
    let time = '';
    if (!e.allDay) {
      const startT = eventClock(e.start, tz);
      const endT = e.end ? eventClock(e.end, tz) : '';
      if (startT) time = endT ? ` ${startT}-${endT}` : ` ${startT}`;
    } else {
      time = ' all day';
    }
    const loc = e.location ? ` (${e.location})` : '';
    const people = e.attendees?.length ? ` [${e.attendees.length} attendees]` : '';
    const cal = e.calendar ? ` [${e.calendar}]` : '';
    const eid = e.id ? ` {id:${e.id}}` : '';
    return `- ${label}${time}: ${e.title}${loc}${people}${cal}${eid}`;
  }

  const list = [...(events || [])].sort((a, b) => eventInstant(a.start) - eventInstant(b.start));

  // Legacy call without range: plain list (no completeness claim)
  if (!range) {
    if (!list.length) return '';
    return ['CALENDAR (upcoming events):', ...list.map(lineFor)].join('\n');
  }

  // Budget + truncation: drop the whole day of the first event that does not fit,
  // so every listed day is complete; "complete until" then ends the day before.
  const MAX_CHARS = 3000;
  const lines = [];
  let used = 0;
  let completeUntilKey = dayKeyOf(range.lastDay);
  let cutDayKey = null;
  for (const e of list) {
    const line = lineFor(e);
    if (used + line.length + 1 > MAX_CHARS) { cutDayKey = eventDayKey(e.start, e.allDay ? null : tz); break; }
    lines.push({ key: eventDayKey(e.start, e.allDay ? null : tz), line });
    used += line.length + 1;
  }
  if (!cutDayKey && range.truncated && list.length) { const last = list[list.length - 1]; cutDayKey = eventDayKey(last.start, last.allDay ? null : tz); }
  if (cutDayKey) {
    while (lines.length && lines[lines.length - 1].key >= cutDayKey) lines.pop();
    completeUntilKey = previousDayKey(cutDayKey);
  }

  const firstLabel = range.firstDay.label || shortLabel(range.firstDay);
  if (completeUntilKey < dayKeyOf(range.firstDay)) {
    return `CALENDAR — too many events to list completely. Check the calendar tool for any specific day before answering — never say a day is free without having checked it.`;
  }
  const untilLabel = shortLabel(dayFromKey(completeUntilKey));
  const body = lines.length ? lines.map((l) => l.line).join('\n') : '- no events';
  return `CALENDAR — complete for ${firstLabel} to ${untilLabel}:
${body}
This list is complete only for these days. For any other day, check the calendar tool first — never say a day is free without having checked it.
${SOURCE_CONFLICT_RULE}`;
}

// Approved by Michael 2026-10-16 (also in the shared-memory rules).
export const SOURCE_CONFLICT_RULE = `If your sources disagree (e.g. the calendar shows a different time than a meeting protocol), name both with their source and ask which one is right. Never attribute something to a source that does not say it.`;

function dayFromKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  const dt = new Date(Date.UTC(y || 1970, (m || 1) - 1, d || 1));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), weekday: dt.getUTCDay() };
}

function previousDayKey(key) {
  const day = dayFromKey(key);
  const dt = new Date(Date.UTC(day.y, day.m - 1, day.d - 1));
  return dayKeyOf({ y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() });
}
