// lib/calendar-fetch.js — Google Calendar API Wrapper + Caching
// Cache-first: liest aus sophie_calendar_memory (TTL 5 Min),
// nur bei Cache-Miss wird Google Calendar API aufgerufen.

import { createClient } from '@supabase/supabase-js';
import { getValidToken } from './google-token.js';
import { DATE_LIST_DAYS, resolveTimeZone, wholeDayWindow } from './date-context.js';
import { formatCalendarContext, eventInstant, toGoogleDateTime, addMinutesLocal } from './calendar-format.js';

export { formatCalendarContext };

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
      if (primary.failed) {
        console.warn(`[calendar] primary events fetch failed: ${primary.status}`);
        return null; // no calendar block rather than a false "complete, no events" (final audit 16.10.2026)
      }
      // 403 = scope calendar.events only → the user's other calendars are invisible.
      // The block must say so instead of claiming completeness (grounding audit 16.10.2026).
      return { ...primary, calendars: 1, fetchedAt: now.toISOString(), primaryOnly: true };
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
    let failedCount = 0;
    let primaryFailed = false;
    results.forEach((r, i) => {
      const ok = r.status === 'fulfilled' && r.value && !r.value.failed;
      if (!ok) {
        failedCount++;
        if (calendars[i]?.primary) primaryFailed = true;
        return;
      }
      allEvents.push(...r.value.events);
      if (r.value.truncated) truncated = true;
    });
    if (primaryFailed || failedCount === calendars.length) {
      console.warn(`[calendar] events fetch failed (primary=${primaryFailed}, failed=${failedCount}/${calendars.length})`);
      return null;
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

  // A failed fetch must not look like "no events" — the block would claim the days are free.
  if (!res.ok) return { events: [], truncated: false, failed: true, status: res.status };

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
export async function getCalendarEventsForUser(userId, { days = DATE_LIST_DAYS, language = 'de', forceRefresh = false, timeZone = null, withTool = true } = {}) {
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
        return { text: formatCalendarContext(events, language, { ...win, tz, withTool, primaryOnly: !!range.primaryOnly }), events, cached: true };
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
      context_links: { cache_range: { from: fromIso, to: toIso, tz, truncated: !!data.truncated, primaryOnly: !!data.primaryOnly } },
      expires_at: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
    }, { onConflict: 'user_id' });
  } catch (e) {
    console.warn('[calendar] Cache write error:', e?.message);
  }

  return { text: formatCalendarContext(events, language, { ...win, tz, withTool, primaryOnly: !!data.primaryOnly, truncated: !!data.truncated }), events, cached: false };
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
export async function createCalendarEvent(token, { title, start, end, description, location, allDay, timeZone = null }) {
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
      // User's time zone wins over any offset the model sent (see toGoogleDateTime).
      const zonedStart = toGoogleDateTime(start, timeZone);
      if (zonedStart) {
        body.start = zonedStart;
        body.end = toGoogleDateTime(end, timeZone) || addMinutesLocal(zonedStart, 60);
      } else {
        body.start = { dateTime: start };
        body.end = { dateTime: end };
      }
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
    if (updates.start) body.start = updates.allDay ? { date: updates.start.split('T')[0] } : (toGoogleDateTime(updates.start, updates.timeZone) || { dateTime: updates.start });
    if (updates.end) body.end = updates.allDay ? { date: updates.end.split('T')[0] } : (toGoogleDateTime(updates.end, updates.timeZone) || { dateTime: updates.end });

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
