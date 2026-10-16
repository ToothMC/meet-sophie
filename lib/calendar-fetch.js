// lib/calendar-fetch.js — Google Calendar API Wrapper + Caching
// Cache-first: liest aus sophie_calendar_memory (TTL 5 Min),
// nur bei Cache-Miss wird Google Calendar API aufgerufen.

import { createClient } from '@supabase/supabase-js';
import { getValidToken } from './google-token.js';
import { DATE_LIST_DAYS, resolveTimeZone, wholeDayWindow, shortLabel } from './date-context.js';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 Minuten
const MAX_EVENTS = 100;              // 14 Tage, alle Kalender

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

const CALENDAR_LIST_API = 'https://www.googleapis.com/calendar/v3/users/me/calendarList';
const CALENDAR_EVENTS_API = 'https://www.googleapis.com/calendar/v3/calendars';

/**
 * Holt Events aus ALLEN Kalendern des Users fuer ein festes Zeitfenster.
 * Zuerst CalendarList laden, dann parallel Events aus jedem Kalender holen.
 * @param {string} token — gueltiger Google Access Token
 * @param {object} options
 * @param {Date} [options.timeMin] — Fensterbeginn (default: jetzt)
 * @param {Date} [options.timeMax] — Fensterende (default: timeMin + days)
 * @param {number} [options.days] — nur ohne timeMax (Altverhalten)
 * @param {number} [options.maxResults] — max Events insgesamt
 * @returns {{ events: Array, calendars: number, fetchedAt: string, truncated: boolean } | null}
 */
export async function fetchUpcomingEvents(token, { days = 7, maxResults = MAX_EVENTS, timeMin = null, timeMax = null } = {}) {
  try {
    const now = new Date();
    const from = timeMin || now;
    const to = timeMax || new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
    const headers = { Authorization: `Bearer ${token}` };

    // 1. Alle Kalender des Users laden
    // Kein minAccessRole-Filter: abonnierte iCal-Feeds (VRBO, Airbnb etc.)
    // haben oft nur freeBusyReader — wuerden sonst rausgefiltert.
    const listRes = await fetch(CALENDAR_LIST_API, {
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (!listRes.ok) {
      console.warn(`[calendar] CalendarList error: ${listRes.status}`);
      // Fallback: nur primary
      const primary = await fetchEventsFromCalendar(token, 'primary', from, to, maxResults);
      return { ...primary, calendars: 1, fetchedAt: now.toISOString() };
    }

    const listData = await listRes.json();
    const calendars = (listData.items || []).filter(c => !c.deleted && c.accessRole !== 'none');

    if (!calendars.length) return { events: [], calendars: 0, fetchedAt: now.toISOString(), truncated: false };

    // 2. Events aus allen Kalendern parallel holen
    const eventPromises = calendars.map(cal =>
      fetchEventsFromCalendar(token, encodeURIComponent(cal.id), from, to, maxResults, cal.summary)
    );
    const results = await Promise.allSettled(eventPromises);

    // 3. Alle Events zusammenfuehren und nach Startzeit sortieren
    const allEvents = [];
    let truncated = false;
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value?.events) {
        allEvents.push(...r.value.events);
        if (r.value.truncated) truncated = true;
      }
    }
    allEvents.sort((a, b) => eventInstant(a.start) - eventInstant(b.start));
    if (allEvents.length > maxResults) truncated = true;

    return { events: allEvents.slice(0, maxResults), calendars: calendars.length, fetchedAt: now.toISOString(), truncated };
  } catch (e) {
    console.warn('[calendar] Fetch error:', e?.message);
    return null;
  }
}

async function fetchEventsFromCalendar(token, calendarId, from, to, maxResults, calendarName) {
  const params = new URLSearchParams({
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    maxResults: String(maxResults),
    singleEvents: 'true',
    orderBy: 'startTime',
  });

  const res = await fetch(`${CALENDAR_EVENTS_API}/${calendarId}/events?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) return { events: [], truncated: false };

  const data = await res.json();
  const events = (data.items || []).map(item => ({
    id: item.id || '',
    title: item.summary || '(Ohne Titel)',
    start: item.start?.dateTime || item.start?.date || '',
    end: item.end?.dateTime || item.end?.date || '',
    allDay: !item.start?.dateTime,
    location: item.location || '',
    description: (item.description || '').slice(0, 100),
    organizer: item.organizer?.email || '',
    attendees: (item.attendees || []).slice(0, 5).map(a => a.email).filter(Boolean),
    calendar: calendarName || '',
    calendarId: calendarId ? decodeURIComponent(calendarId) : '',
  }));

  // nextPageToken = es gibt mehr Events als maxResults → Liste ist nicht vollstaendig
  return { events, truncated: !!data.nextPageToken };
}

// "2026-10-23T10:00:00+02:00" or "2026-10-23" (all-day) → epoch ms for sorting
function eventInstant(iso) {
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

/**
 * Cache-first: liest aus sophie_calendar_memory, bei Miss holt von Google API.
 * Ganze Tage in der Zeitzone des Users: heute 00:00 bis Ende von (heute + days - 1).
 * Der Cache antwortet nur, wenn er den angefragten Zeitraum komplett abdeckt
 * (Bereich steht in context_links.cache_range — die Spalte war ungenutzt).
 * @param {string} userId
 * @param {object} options
 * @param {number} options.days — Anzahl Tage inkl. heute (default 14)
 * @param {string} options.language — ungenutzt (Block englisch)
 * @param {boolean} options.forceRefresh — Cache ignorieren
 * @param {string} options.timeZone — IANA-Zeitzone des Users (Browser)
 * @returns {{ text: string, events: Array, cached: boolean } | null}
 */
export async function getCalendarEventsForUser(userId, { days = DATE_LIST_DAYS, language = 'de', forceRefresh = false, timeZone = null } = {}) {
  const supabase = getSupabase();
  const tz = resolveTimeZone(timeZone);
  const win = wholeDayWindow(tz, days);
  const fromIso = win.timeMin.toISOString();
  const toIso = win.timeMax.toISOString();
  const inWindow = (e) => {
    const t = eventInstant(e.start);
    const end = eventInstant(e.end) || t;
    return end > win.timeMin.getTime() && t < win.timeMax.getTime();
  };

  // 1. Cache pruefen (wenn nicht forceRefresh) — nur wenn er den Zeitraum abdeckt
  if (!forceRefresh) {
    try {
      const { data: cached } = await supabase
        .from('sophie_calendar_memory')
        .select('upcoming_events, context_links, expires_at')
        .eq('user_id', userId)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();

      const range = cached?.context_links?.cache_range;
      if (cached && range && range.from <= fromIso && range.to >= toIso && !range.truncated) {
        const events = (cached.upcoming_events || []).filter(inWindow);
        return { text: formatCalendarContext(events, language, win), events, cached: true };
      }
    } catch (e) {
      console.warn('[calendar] Cache read error:', e?.message);
    }
  }

  // 2. Cache Miss oder forceRefresh → Google API aufrufen
  const token = await getValidToken(userId, 'google');
  if (!token) return null;

  const data = await fetchUpcomingEvents(token, { timeMin: win.timeMin, timeMax: win.timeMax });
  if (!data) return null; // API-Fehler: lieber kein Kalender als "keine Termine"
  const events = data.events || [];

  // 3. Cache schreiben (upsert — UNIQUE auf user_id)
  try {
    await supabase.from('sophie_calendar_memory').upsert({
      user_id: userId,
      upcoming_events: events,
      context_links: { cache_range: { from: fromIso, to: toIso, tz, truncated: !!data.truncated } },
      expires_at: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
    }, { onConflict: 'user_id' });
  } catch (e) {
    console.warn('[calendar] Cache write error:', e?.message);
  }

  return { text: formatCalendarContext(events, language, { ...win, truncated: !!data.truncated }), events, cached: false };
}

// ── Write-Operationen ──────────────────────────────────────

async function invalidateCache(userId) {
  try {
    const supabase = getSupabase();
    await supabase.from('sophie_calendar_memory')
      .update({ expires_at: new Date(0).toISOString() })
      .eq('user_id', userId);
  } catch (e) {
    console.warn('[calendar] Cache invalidation error:', e?.message);
  }
}

/**
 * Erstellt einen neuen Termin im Google Calendar.
 * @returns {{ success: boolean, event?: object, error?: string }}
 */
export async function createCalendarEvent(token, { title, start, end, description, location, allDay }) {
  try {
    const body = {
      summary: title,
      description: description || undefined,
      location: location || undefined,
    };

    if (allDay) {
      // All-day: nur Datum, kein dateTime
      body.start = { date: start.split('T')[0] };
      body.end = { date: (end || start).split('T')[0] };
    } else {
      body.start = { dateTime: start };
      body.end = { dateTime: end };
    }

    const res = await fetch(`${CALENDAR_EVENTS_API}/primary/events`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { success: false, error: err.error?.message || `HTTP ${res.status}` };
    }

    const event = await res.json();
    return {
      success: true,
      event: {
        id: event.id,
        title: event.summary,
        start: event.start?.dateTime || event.start?.date,
        end: event.end?.dateTime || event.end?.date,
        link: event.htmlLink,
      },
    };
  } catch (e) {
    return { success: false, error: e?.message || 'Unknown error' };
  }
}

/**
 * Aktualisiert einen bestehenden Termin (partial update via PATCH).
 * @returns {{ success: boolean, event?: object, error?: string }}
 */
export async function updateCalendarEvent(token, eventId, updates) {
  try {
    const calId = encodeURIComponent(updates.calendarId || 'primary');
    const body = {};
    if (updates.title) body.summary = updates.title;
    if (updates.description !== undefined) body.description = updates.description;
    if (updates.location !== undefined) body.location = updates.location;
    if (updates.start) body.start = updates.allDay ? { date: updates.start.split('T')[0] } : { dateTime: updates.start };
    if (updates.end) body.end = updates.allDay ? { date: updates.end.split('T')[0] } : { dateTime: updates.end };

    const res = await fetch(`${CALENDAR_EVENTS_API}/${calId}/events/${encodeURIComponent(eventId)}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { success: false, error: err.error?.message || `HTTP ${res.status}` };
    }

    const event = await res.json();
    return {
      success: true,
      event: {
        id: event.id,
        title: event.summary,
        start: event.start?.dateTime || event.start?.date,
        end: event.end?.dateTime || event.end?.date,
      },
    };
  } catch (e) {
    return { success: false, error: e?.message || 'Unknown error' };
  }
}

/**
 * Loescht einen Termin aus dem Google Calendar.
 * @returns {{ success: boolean, error?: string }}
 */
export async function deleteCalendarEvent(token, eventId, calendarId) {
  try {
    const calId = encodeURIComponent(calendarId || 'primary');
    const res = await fetch(`${CALENDAR_EVENTS_API}/${calId}/events/${encodeURIComponent(eventId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok && res.status !== 410) {
      const err = await res.json().catch(() => ({}));
      return { success: false, error: err.error?.message || `HTTP ${res.status}` };
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: e?.message || 'Unknown error' };
  }
}

/**
 * Wrapper fuer Write-Operationen: holt Token, fuehrt Aktion aus, invalidiert Cache.
 */
export async function calendarWrite(userId, action, params) {
  const token = await getValidToken(userId, 'google');
  if (!token) return { success: false, error: 'Kalender nicht verbunden.' };

  let result;
  switch (action) {
    case 'create':
      result = await createCalendarEvent(token, params);
      break;
    case 'update':
      result = await updateCalendarEvent(token, params.eventId, params);
      break;
    case 'delete':
      result = await deleteCalendarEvent(token, params.eventId);
      break;
    default:
      return { success: false, error: `Unbekannte Aktion: ${action}` };
  }

  if (result.success) await invalidateCache(userId);
  return result;
}
