// lib/calendar-fetch.js — Google Calendar API Wrapper + Caching
// Cache-first: liest aus sophie_calendar_memory (TTL 5 Min),
// nur bei Cache-Miss wird Google Calendar API aufgerufen.

import { createClient } from '@supabase/supabase-js';
import { getValidToken } from './google-token.js';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 Minuten

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

const CALENDAR_LIST_API = 'https://www.googleapis.com/calendar/v3/users/me/calendarList';
const CALENDAR_EVENTS_API = 'https://www.googleapis.com/calendar/v3/calendars';

/**
 * Holt kommende Events aus ALLEN Kalendern des Users.
 * Zuerst CalendarList laden, dann parallel Events aus jedem Kalender holen.
 * @param {string} token — gueltiger Google Access Token
 * @param {object} options
 * @param {number} options.days — Tage in die Zukunft (default 7)
 * @param {number} options.maxResults — max Events pro Kalender (default 30)
 * @returns {{ events: Array, calendars: number, fetchedAt: string } | null}
 */
export async function fetchUpcomingEvents(token, { days = 7, maxResults = 30 } = {}) {
  try {
    const now = new Date();
    const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
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
      return fetchEventsFromCalendar(token, 'primary', now, future, maxResults);
    }

    const listData = await listRes.json();
    const calendars = (listData.items || []).filter(c => !c.deleted && c.accessRole !== 'none');

    if (!calendars.length) return { events: [], calendars: 0, fetchedAt: now.toISOString() };

    // 2. Events aus allen Kalendern parallel holen
    const eventPromises = calendars.map(cal =>
      fetchEventsFromCalendar(token, encodeURIComponent(cal.id), now, future, maxResults, cal.summary)
    );
    const results = await Promise.allSettled(eventPromises);

    // 3. Alle Events zusammenfuehren und nach Startzeit sortieren
    const allEvents = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value?.events) {
        allEvents.push(...r.value.events);
      }
    }
    allEvents.sort((a, b) => a.start.localeCompare(b.start));

    return { events: allEvents.slice(0, maxResults), calendars: calendars.length, fetchedAt: now.toISOString() };
  } catch (e) {
    console.warn('[calendar] Fetch error:', e?.message);
    return null;
  }
}

async function fetchEventsFromCalendar(token, calendarId, now, future, maxResults, calendarName) {
  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: future.toISOString(),
    maxResults: String(maxResults),
    singleEvents: 'true',
    orderBy: 'startTime',
  });

  const res = await fetch(`${CALENDAR_EVENTS_API}/${calendarId}/events?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) return { events: [] };

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

  return { events };
}

/**
 * Formatiert Events als Prompt-Kontext-Block.
 * @param {Array} events — normalisierte Events
 * @param {string} language — 'de' oder 'en'
 * @returns {string}
 */
export function formatCalendarContext(events, language = 'de') {
  if (!events?.length) return '';

  const dayNames = language === 'de'
    ? ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const header = language === 'de'
    ? 'KALENDER (naechste Termine):'
    : 'CALENDAR (upcoming events):';

  // Lokalzeit direkt aus ISO-String parsen (z.B. "2026-04-13T20:00:00+03:00")
  // Nicht ueber new Date().getHours() — das konvertiert zu UTC auf dem Server.
  function parseLocalTime(isoStr) {
    const m = isoStr.match(/T(\d{2}):(\d{2})/);
    return m ? { h: m[1], m: m[2] } : null;
  }
  function parseLocalDate(isoStr) {
    // Handles both "2026-04-13T20:00:00+03:00" and "2026-04-13" (all-day)
    const m = isoStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return { day: '??', month: '??', weekday: 0 };
    const y = parseInt(m[1]), mo = parseInt(m[2]) - 1, da = parseInt(m[3]);
    return { day: m[3], month: m[2], weekday: new Date(y, mo, da).getDay() };
  }

  const lines = events.map(e => {
    const pd = parseLocalDate(e.start);
    const day = dayNames[pd.weekday];
    const date = `${pd.day}.${pd.month}.`;

    let time = '';
    if (!e.allDay) {
      const startT = parseLocalTime(e.start);
      if (startT && e.end) {
        const endT = parseLocalTime(e.end);
        time = endT ? ` ${startT.h}:${startT.m}-${endT.h}:${endT.m}` : ` ${startT.h}:${startT.m}`;
      } else if (startT) {
        time = ` ${startT.h}:${startT.m}`;
      }
    } else {
      time = language === 'de' ? ' ganztaegig' : ' all day';
    }

    const loc = e.location ? ` (${e.location})` : '';
    const attendeeCount = e.attendees?.length;
    const people = attendeeCount ? ` [${attendeeCount} Teilnehmer]` : '';
    const cal = e.calendar ? ` [${e.calendar}]` : '';

    const eid = e.id ? ` {id:${e.id}}` : '';

    return `- ${day} ${date}${time}: ${e.title}${loc}${people}${cal}${eid}`;
  });

  // Max ~1500 Zeichen um den Prompt nicht zu ueberfrachten
  let result = header + '\n';
  let addedCount = 0;
  for (const line of lines) {
    if (result.length + line.length > 1500) {
      const remaining = lines.length - addedCount;
      result += `- ... und ${remaining} weitere Termine`;
      break;
    }
    result += line + '\n';
    addedCount++;
  }

  return result.trimEnd();
}

/**
 * Cache-first: liest aus sophie_calendar_memory, bei Miss holt von Google API.
 * @param {string} userId
 * @param {object} options
 * @param {number} options.days — Tage in die Zukunft (default 7)
 * @param {string} options.language — 'de' oder 'en'
 * @param {boolean} options.forceRefresh — Cache ignorieren
 * @returns {{ text: string, events: Array, cached: boolean } | null}
 */
export async function getCalendarEventsForUser(userId, { days = 7, language = 'de', forceRefresh = false } = {}) {
  const supabase = getSupabase();

  // 1. Cache pruefen (wenn nicht forceRefresh)
  if (!forceRefresh) {
    try {
      const { data: cached } = await supabase
        .from('sophie_calendar_memory')
        .select('upcoming_events, expires_at')
        .eq('user_id', userId)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();

      if (cached?.upcoming_events?.length) {
        const text = formatCalendarContext(cached.upcoming_events, language);
        return { text, events: cached.upcoming_events, cached: true };
      }
    } catch (e) {
      console.warn('[calendar] Cache read error:', e?.message);
    }
  }

  // 2. Cache Miss oder forceRefresh → Google API aufrufen
  const token = await getValidToken(userId, 'google');
  if (!token) return null;

  const data = await fetchUpcomingEvents(token, { days });
  const events = data?.events || [];

  // 3. Cache schreiben (upsert — UNIQUE auf user_id)
  try {
    await supabase.from('sophie_calendar_memory').upsert({
      user_id: userId,
      upcoming_events: events,
      expires_at: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
    }, { onConflict: 'user_id' });
  } catch (e) {
    console.warn('[calendar] Cache write error:', e?.message);
  }

  if (!events.length) {
    return { text: language === 'de' ? `Keine Termine in den naechsten ${days} Tagen.` : `No events in the next ${days} days.`, events: [], cached: false };
  }

  return { text: formatCalendarContext(events, language), events, cached: false };
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
