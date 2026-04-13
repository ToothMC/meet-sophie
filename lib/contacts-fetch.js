// lib/contacts-fetch.js — Google Contacts Search (People API)
// Durchsucht BEIDE Kontakt-Pools:
//   1. "Meine Kontakte" (searchContacts API → contacts.readonly)
//   2. "Weitere Kontakte" (otherContacts.search → contacts.other.readonly)
// Ergebnisse werden gemerged und dedupliziert.

import { getValidToken } from './google-token.js';

const SEARCH_CONTACTS_API = 'https://people.googleapis.com/v1/people:searchContacts';
const SEARCH_OTHER_API = 'https://people.googleapis.com/v1/otherContacts:search';
const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,birthdays,organizations,nicknames';

/**
 * Durchsucht "Meine Kontakte" + "Weitere Kontakte" parallel.
 * Merged und dedupliziert nach Name+Email.
 */
export async function searchContacts(token, query, maxResults = 10) {
  if (!query || query.length < 2) return [];

  // Alle drei Quellen parallel: Google Search APIs + connections.list Vollsuche
  const [myContacts, otherContacts, listContacts] = await Promise.all([
    searchMyContacts(token, query, maxResults),
    searchOtherContacts(token, query, maxResults),
    searchViaConnectionsList(token, query, maxResults),
  ]);

  // Merge + Deduplizierung (Name+Email als Key)
  const seen = new Set();
  const merged = [];

  for (const c of [...myContacts, ...otherContacts, ...listContacts]) {
    const key = `${c.name.toLowerCase()}|${c.email.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(c);
    if (merged.length >= maxResults) break;
  }

  console.log(`[contacts] Search "${query}": ${myContacts.length} searchAPI + ${otherContacts.length} other + ${listContacts.length} list → ${merged.length} merged`);
  return merged;
}

/**
 * Fallback: connections.list komplett durchpaginieren und lokal filtern.
 * Langsamer aber zuverlaessig — kein Suchindex noetig.
 */
async function searchViaConnectionsList(token, query, maxResults) {
  const q = query.toLowerCase();
  const matches = [];

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

      const res = await fetch(`https://people.googleapis.com/v1/people/me/connections?${params}`, {
        headers,
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        console.warn(`[contacts] connections.list error: ${res.status}`);
        break;
      }

      const data = await res.json();
      for (const person of (data.connections || [])) {
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

    console.log(`[contacts] connections.list: ${matches.length} matches in ${pages} page(s), total connections scanned`);
  } catch (e) {
    console.warn('[contacts] connections.list error:', e?.message);
  }

  return matches;
}

/**
 * Durchsucht "Meine Kontakte" via people:searchContacts.
 */
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
      console.warn(`[contacts] searchContacts error: ${res.status}`);
      return [];
    }

    const data = await res.json();
    return (data.results || [])
      .map(r => normalizePerson(r.person))
      .filter(c => c.name);
  } catch (e) {
    console.warn('[contacts] searchContacts error:', e?.message);
    return [];
  }
}

/**
 * Durchsucht "Weitere Kontakte" via otherContacts:search.
 * Braucht contacts.other.readonly Scope.
 */
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
      // 403 = Scope nicht vorhanden (User muss neu verbinden)
      if (res.status !== 403) {
        console.warn(`[contacts] otherContacts.search error: ${res.status}`);
      }
      return [];
    }

    const data = await res.json();
    return (data.results || [])
      .map(r => normalizePerson(r.person))
      .filter(c => c.name);
  } catch (e) {
    console.warn('[contacts] otherContacts.search error:', e?.message);
    return [];
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

/**
 * Formatiert Suchergebnisse als Text fuer Sophie.
 */
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
 */
export async function searchContactsForUser(userId, query, { language = 'de' } = {}) {
  const token = await getValidToken(userId, 'google_calendar');
  if (!token) return { text: 'Kontakte nicht verbunden.', contacts: [] };

  const contacts = await searchContacts(token, query);
  const text = formatContactResults(contacts, language);
  return { text, contacts };
}
