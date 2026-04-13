// lib/calendar-fetch.js — Google Calendar API Wrapper
// Holt Events, normalisiert, formatiert als Prompt-Kontext.
// Spec: Phase 1 Calendar Integration

import { getValidToken } from './google-token.js';

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

/**
 * Holt kommende Events aus Google Calendar.
 * @param {string} token — gueltiger Google Access Token
 * @param {object} options
 * @param {number} options.days — Tage in die Zukunft (default 7)
 * @param {number} options.maxResults — max Events (default 30)
 * @returns {{ events: Array, fetchedAt: string } | null}
 */
export async function fetchUpcomingEvents(token, { days = 7, maxResults = 30 } = {}) {
  try {
    const now = new Date();
    const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const params = new URLSearchParams({
      timeMin: now.toISOString(),
      timeMax: future.toISOString(),
      maxResults: String(maxResults),
      singleEvents: 'true',
      orderBy: 'startTime',
    });

    const res = await fetch(`${CALENDAR_API}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.warn(`[calendar] API error: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = await res.json();
    const events = (data.items || []).map(item => ({
      title: item.summary || '(Ohne Titel)',
      start: item.start?.dateTime || item.start?.date || '',
      end: item.end?.dateTime || item.end?.date || '',
      allDay: !item.start?.dateTime,
      location: item.location || '',
      description: (item.description || '').slice(0, 100),
      organizer: item.organizer?.email || '',
      attendees: (item.attendees || []).slice(0, 5).map(a => a.email).filter(Boolean),
    }));

    return { events, fetchedAt: now.toISOString() };
  } catch (e) {
    console.warn('[calendar] Fetch error:', e?.message);
    return null;
  }
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

  const lines = events.map(e => {
    const d = new Date(e.start);
    const day = dayNames[d.getDay()];
    const date = `${d.getDate().toString().padStart(2, '0')}.${(d.getMonth() + 1).toString().padStart(2, '0')}.`;

    let time = '';
    if (!e.allDay) {
      const startH = d.getHours().toString().padStart(2, '0');
      const startM = d.getMinutes().toString().padStart(2, '0');
      if (e.end) {
        const endD = new Date(e.end);
        const endH = endD.getHours().toString().padStart(2, '0');
        const endM = endD.getMinutes().toString().padStart(2, '0');
        time = ` ${startH}:${startM}-${endH}:${endM}`;
      } else {
        time = ` ${startH}:${startM}`;
      }
    } else {
      time = language === 'de' ? ' ganztaegig' : ' all day';
    }

    const loc = e.location ? ` (${e.location})` : '';
    const attendeeCount = e.attendees?.length;
    const people = attendeeCount ? ` [${attendeeCount} Teilnehmer]` : '';

    return `- ${day} ${date}${time}: ${e.title}${loc}${people}`;
  });

  // Max ~1500 Zeichen um den Prompt nicht zu ueberfrachten
  let result = header + '\n';
  for (const line of lines) {
    if (result.length + line.length > 1500) {
      result += `- ... und ${lines.length - result.split('\n').length + 1} weitere Termine`;
      break;
    }
    result += line + '\n';
  }

  return result.trimEnd();
}

/**
 * Convenience: Token holen + Events fetchen + formatieren in einem Aufruf.
 * Fuer Nutzung in tools.js und Context-Injection.
 */
export async function getCalendarEventsForUser(userId, { days = 7, language = 'de' } = {}) {
  const token = await getValidToken(userId, 'google_calendar');
  if (!token) return null;

  const data = await fetchUpcomingEvents(token, { days });
  if (!data?.events?.length) return { text: language === 'de' ? `Keine Termine in den naechsten ${days} Tagen.` : `No events in the next ${days} days.`, events: [] };

  return { text: formatCalendarContext(data.events, language), events: data.events };
}
