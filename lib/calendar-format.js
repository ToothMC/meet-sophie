// lib/calendar-format.js — pure calendar formatting (no dependencies besides date-context),
// so the smoke tests can import it in CI without installed npm packages.

import { shortLabel } from './date-context.js';

// "2026-10-23T10:00:00+02:00" or "2026-10-23" (all-day) → epoch ms for sorting
export function eventInstant(iso) {
  const t = Date.parse(iso && iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isFinite(t) ? t : 0;
}

// Local calendar day of an event start ("2026-10-23"), straight from the ISO string:
// Google returns dateTime with the event's own offset, so the date part is local.
function eventDayKey(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
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
  function parseLocalTime(isoStr) {
    const m = isoStr.match(/T(\d{2}):(\d{2})/);
    return m ? { h: m[1], m: m[2] } : null;
  }
  function lineFor(e) {
    const label = shortLabel(dayFromKey(eventDayKey(e.start)));
    let time = '';
    if (!e.allDay) {
      const startT = parseLocalTime(e.start);
      const endT = e.end ? parseLocalTime(e.end) : null;
      if (startT) time = endT ? ` ${startT.h}:${startT.m}-${endT.h}:${endT.m}` : ` ${startT.h}:${startT.m}`;
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
    if (used + line.length + 1 > MAX_CHARS) { cutDayKey = eventDayKey(e.start); break; }
    lines.push({ key: eventDayKey(e.start), line });
    used += line.length + 1;
  }
  if (!cutDayKey && range.truncated && list.length) cutDayKey = eventDayKey(list[list.length - 1].start);
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
This list is complete only for these days. For any other day, check the calendar tool first — never say a day is free without having checked it.`;
}

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
