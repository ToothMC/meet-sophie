// lib/contacts-fetch.js — Google Contacts Search (People API)
// Durchsucht "Meine Kontakte" + "Weitere Kontakte" + connections.list Fallback.
// Gibt Diagnose-Info zurueck wenn keine Ergebnisse gefunden werden.

import { getValidToken } from './google-token.js';

const SEARCH_CONTACTS_API = 'https://people.googleapis.com/v1/people:searchContacts';
const SEARCH_OTHER_API = 'https://people.googleapis.com/v1/otherContacts:search';
const CONNECTIONS_API = 'https://people.googleapis.com/v1/people/me/connections';
const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,birthdays,organizations,nicknames';

/**
 * Durchsucht alle Kontakt-Quellen parallel mit Diagnose.
 */
export async function searchContacts(token, query, maxResults = 10) {
  if (!query || query.length < 2) return { results: [], debug: 'query too short' };

  const [myResult, otherResult, listResult] = await Promise.all([
    searchMyContacts(token, query, maxResults),
    searchOtherContacts(token, query, maxResults),
    searchViaConnectionsList(token, query, maxResults),
  ]);

  // Merge + Deduplizierung
  const seen = new Set();
  const merged = [];
  for (const c of [...myResult.contacts, ...otherResult.contacts, ...listResult.contacts]) {
    const key = `${c.name.toLowerCase()}|${c.email.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(c);
    if (merged.length >= maxResults) break;
  }

  const debug = [
    `searchAPI: ${myResult.contacts.length} (${myResult.status})`,
    `otherContacts: ${otherResult.contacts.length} (${otherResult.status})`,
    `connectionsList: ${listResult.contacts.length}/${listResult.totalScanned} scanned (${listResult.status})`,
  ].join(' | ');

  console.log(`[contacts] "${query}": ${debug}`);
  return { results: merged, debug };
}

async function searchMyContacts(token, query, maxResults) {
  try {
    const params = new URLSearchParams({
      query,
      readMask: PERSON_FIELDS,
      pageSize: String(Math.min(maxResults, 30)),
    });

    const res = await fetch(`${SEARCH_CONTACTS_API}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { contacts: [], status: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    }

    const data = await res.json();
    const contacts = (data.results || []).map(r => normalizePerson(r.person)).filter(c => c.name);
    return { contacts, status: 'ok' };
  } catch (e) {
    return { contacts: [], status: `error: ${e?.message}` };
  }
}

async function searchOtherContacts(token, query, maxResults) {
  try {
    const params = new URLSearchParams({
      query,
      readMask: PERSON_FIELDS,
      pageSize: String(Math.min(maxResults, 30)),
    });

    const res = await fetch(`${SEARCH_OTHER_API}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { contacts: [], status: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    }

    const data = await res.json();
    const contacts = (data.results || []).map(r => normalizePerson(r.person)).filter(c => c.name);
    return { contacts, status: 'ok' };
  } catch (e) {
    return { contacts: [], status: `error: ${e?.message}` };
  }
}

async function searchViaConnectionsList(token, query, maxResults) {
  const q = query.toLowerCase();
  const matches = [];
  let totalScanned = 0;

  try {
    const headers = { Authorization: `Bearer ${token}` };
    let pageToken = null;
    let pages = 0;

    do {
      const params = new URLSearchParams({
        personFields: PERSON_FIELDS,
        pageSize: '1000',
      });
      if (pageToken) params.set('pageToken', pageToken);

      const res = await fetch(`${CONNECTIONS_API}?${params}`, {
        headers,
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { contacts: matches, totalScanned, status: `HTTP ${res.status}: ${body.slice(0, 200)}` };
      }

      const data = await res.json();
      const connections = data.connections || [];
      totalScanned += connections.length;

      for (const person of connections) {
        const c = normalizePerson(person);
        if (!c.name) continue;
        if (
          c.name.toLowerCase().includes(q) ||
          c.firstName.toLowerCase().includes(q) ||
          c.lastName.toLowerCase().includes(q) ||
          c.nickname.toLowerCase().includes(q) ||
          c.email.toLowerCase().includes(q) ||
          c.phone.includes(q)
        ) {
          matches.push(c);
          if (matches.length >= maxResults) break;
        }
      }

      pageToken = data.nextPageToken || null;
      pages++;
    } while (pageToken && matches.length < maxResults && pages < 20);

    return { contacts: matches, totalScanned, status: `ok (${pages} pages)` };
  } catch (e) {
    return { contacts: matches, totalScanned, status: `error: ${e?.message}` };
  }
}

function normalizePerson(person) {
  if (!person) return { name: '' };
  const name = person.names?.[0];
  const email = person.emailAddresses?.[0];
  const phone = person.phoneNumbers?.[0];
  const birthday = person.birthdays?.[0]?.date;
  const org = person.organizations?.[0];
  const nickname = person.nicknames?.[0];

  return {
    name: name?.displayName || '',
    firstName: name?.givenName || '',
    lastName: name?.familyName || '',
    email: email?.value || '',
    phone: phone?.value || '',
    birthday: birthday ? `${String(birthday.month).padStart(2, '0')}-${String(birthday.day).padStart(2, '0')}` : '',
    birthdayYear: birthday?.year || null,
    organization: org?.name || '',
    title: org?.title || '',
    nickname: nickname?.value || '',
  };
}

export function formatContactResults(contacts, language = 'de') {
  if (!contacts?.length) return language === 'de' ? 'Kein Kontakt gefunden.' : 'No contact found.';

  return contacts.map(c => {
    const parts = [c.name];
    if (c.nickname) parts.push(`"${c.nickname}"`);
    if (c.organization) parts.push(c.organization);
    if (c.title) parts.push(c.title);
    if (c.email) parts.push(c.email);
    if (c.phone) parts.push(c.phone);
    if (c.birthday) {
      const [m, d] = c.birthday.split('-');
      parts.push(`Geb: ${d}.${m}.${c.birthdayYear || ''}`);
    }
    return `- ${parts.join(' | ')}`;
  }).join('\n');
}

/**
 * Convenience: Token holen + suchen + formatieren.
 * Gibt Diagnose-Info bei 0 Ergebnissen zurueck.
 */
export async function searchContactsForUser(userId, query, { language = 'de' } = {}) {
  const token = await getValidToken(userId, 'google_calendar');
  if (!token) return { text: 'Kontakte nicht verbunden. Bitte Google in den Einstellungen verbinden.', contacts: [] };

  const { results, debug } = await searchContacts(token, query);

  if (!results.length) {
    console.warn(`[contacts] No results for "${query}". Debug: ${debug}`);
    return {
      text: `Kein Kontakt "${query}" gefunden. (Debug: ${debug})`,
      contacts: [],
    };
  }

  return { text: formatContactResults(results, language), contacts: results };
}
