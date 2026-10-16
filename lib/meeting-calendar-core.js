// lib/meeting-calendar-core.js — reine Logik der Meeting-Folgetermine (ohne npm-Abhaengigkeiten),
// damit die Smoke-Tests sie in CI ohne node_modules importieren koennen.
// I/O (Supabase, Google, OpenAI) liegt in lib/meeting-calendar.js.
//
// Zeitzonen-Regel: Alles in der Zeitzone des USERS (Header X-Sophie-Timezone).
// An Google gehen Datum + Uhrzeit immer als { dateTime (lokal), timeZone } via
// toGoogleDateTime — nie ein selbst gerechneter Offset (16.10.2026: 10:00 fuer einen
// User in Zypern mit +02:00 eingetragen → stand auf 11:00).

import { partsIn, nextDays, longToday, resolveTimeZone } from './date-context.js';
import { toGoogleDateTime, addMinutesLocal, eventInstant } from './calendar-format.js';
import { meetingFollowUpPrompt } from './grounding-texts.js';

export const DEFAULT_DURATION_MIN = 60;
const DATE_TABLE_DAYS = 21;

const pad = (n) => String(n).padStart(2, '0');

/** Lokale Wanduhrzeit (YYYY-MM-DD + HH:MM in tz) → UTC-Instant. DST-sicher (zwei Durchgaenge). */
export function zonedToUtc(dateStr, timeStr, tz) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const [H, M] = String(timeStr).split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, H, M, 0);
  const offsetAt = (instant) => {
    const p = partsIn(new Date(instant), tz);
    return Date.UTC(p.y, p.m - 1, p.d, Number(p.hh), Number(p.mm)) - Math.floor(instant / 60000) * 60000;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return new Date(t);
}

/** "2026-10-20" in tz */
export function localDateStr(date, tz) {
  const p = partsIn(date, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** "10:00" in tz */
export function localTimeStr(date, tz) {
  const p = partsIn(date, tz);
  return `${p.hh}:${p.mm}`;
}

/** Datums-Tabelle ab Meetingtag (Server rechnet, Modell waehlt nur aus). */
export function buildDateTable(tz, meetingDate) {
  return nextDays(tz, DATE_TABLE_DAYS, meetingDate)
    .map((d, i) => `${d.label.split(' ')[0]} ${d.y}-${pad(d.m)}-${pad(d.d)}${i === 0 ? ' (meeting day)' : ''}`)
    .join('\n');
}

export function formatKnownAppointments(items, tz) {
  const lines = [];
  for (const it of items || []) {
    if (it.kind === 'check' && it.start_at) {
      const d = new Date(it.start_at);
      lines.push(`- proposed ${localDateStr(d, tz)} ${localTimeStr(d, tz)}`);
    } else if (it.kind === 'booking' && it.start_at && it.status !== 'replaced') {
      const d = new Date(it.start_at);
      lines.push(`- agreed ${localDateStr(d, tz)} ${localTimeStr(d, tz)}`);
    } else if (it.kind === 'time_open' && it.slot_date) {
      lines.push(`- agreed ${it.slot_date} (no time yet)`);
    }
  }
  return lines.length ? lines.join('\n') : '(none)';
}

export function buildDetectPrompt({ title, meetingDate, tz, items, earlier, transcript, now = new Date() }) {
  const zone = resolveTimeZone(tz);
  return meetingFollowUpPrompt({
    title,
    meetingDayLong: longToday(zone, meetingDate),
    nowLocal: localTimeStr(now, zone),
    timeZone: zone,
    dateTable: buildDateTable(zone, meetingDate),
    known: formatKnownAppointments(items, zone),
    earlier,
    transcript,
  });
}

// Format-Validierung der AI-Antwort (keine Inhalts-Klassifikation)
const DATE_FMT = /^\d{4}-\d{2}-\d{2}$/;
const TIME_FMT = /^([01]\d|2[0-3]):[0-5]\d$/;

export function sanitizeAppointments(raw) {
  const list = Array.isArray(raw?.appointments) ? raw.appointments : [];
  const out = [];
  for (const a of list.slice(0, 5)) {
    if (!a || (a.status !== 'proposed' && a.status !== 'agreed')) continue;
    if (typeof a.date !== 'string' || !DATE_FMT.test(a.date)) continue;
    const time = typeof a.time === 'string' && TIME_FMT.test(a.time) ? a.time : null;
    const dur = Number.isFinite(a.duration_minutes) ? Math.round(a.duration_minutes) : null;
    let replaces = null;
    if (typeof a.replaces === 'string') {
      const [rd, rt] = a.replaces.trim().split(/\s+/);
      if (DATE_FMT.test(rd || '') && TIME_FMT.test(rt || '')) replaces = { date: rd, time: rt };
    }
    out.push({ status: a.status, date: a.date, time, duration_minutes: dur, replaces });
  }
  return out;
}

/**
 * Slot eines Termins mit Uhrzeit in der Zeitzone des Users.
 * @returns {{ start: Date, end: Date, slotKey: string, googleStart: {dateTime, timeZone}, googleEnd: {dateTime, timeZone} } | null}
 */
export function planSlot({ date, time, duration_minutes }, tz) {
  const zone = resolveTimeZone(tz);
  const googleStart = toGoogleDateTime(`${date}T${time}`, zone);
  if (!googleStart) return null;
  const durMin = Math.min(480, Math.max(15, duration_minutes || DEFAULT_DURATION_MIN));
  const googleEnd = addMinutesLocal(googleStart, durMin);
  if (!googleEnd) return null;
  const start = zonedToUtc(date, time, zone);
  const [ed, et] = googleEnd.dateTime.split('T');
  const end = zonedToUtc(ed, et.slice(0, 5), zone);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) return null;
  return { start, end, slotKey: start.toISOString(), googleStart, googleEnd };
}

/** Parameter fuer calendarWrite('create') — Zeiten lokal + timeZone, kein Offset. */
export function buildCreateParams(slot, { title, description }) {
  return {
    title,
    description,
    start: slot.googleStart.dateTime,
    end: slot.googleEnd.dateTime,
    timeZone: slot.googleStart.timeZone,
  };
}

/**
 * Erster echter Konflikt im Slot, verglichen in der Zeitzone des Users.
 * Timed: Instant-Ueberlappung (Offset im Google-String wird beachtet).
 * Ganztaegig: Google-Datum [start, end) gegen den Kalendertag des Slots in tz.
 * @returns {string|null} Titel des Konflikts
 */
export function findConflict(events, slot, tz, ownEventIds = new Set()) {
  const zone = resolveTimeZone(tz);
  const s = slot.start.getTime();
  const e = slot.end.getTime();
  const slotDays = new Set([localDateStr(slot.start, zone), localDateStr(new Date(e - 1), zone)]);
  for (const ev of events || []) {
    if (!ev || ownEventIds.has(ev.id)) continue;
    if (ev.allDay) {
      const from = String(ev.start || '').slice(0, 10);
      const to = String(ev.end || ev.start || '').slice(0, 10);
      for (const day of slotDays) {
        if (day >= from && (day < to || (to === from && day === from))) return ev.title || '';
      }
      continue;
    }
    const es = eventInstant(ev.start);
    const ee = eventInstant(ev.end) || es;
    if (es < e && ee > s) return ev.title || '';
  }
  return null;
}
