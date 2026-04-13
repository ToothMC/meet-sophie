// lib/contacts-fetch.js — Google Contacts Search (People API)
// On-demand Suche: paginiert durch connections.list und filtert lokal.
// Kein Preloading, kein Cache. Geburtstage kommen ueber Google Calendar.

import { getValidToken } from './google-token.js';

const CONNECTIONS_API = 'https://people.googleapis.com/v1/people/me/connections';
const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,birthdays,organizations,nicknames';

/**
 * Sucht Kontakte on-demand: paginiert durch Google Contacts und filtert lokal.
 * Stoppt sobald genug Treffer oder alle Seiten durchsucht.
 */
export async function searchContacts(token, query, maxResults = 10) {
  if (!query || query.length < 2) return [];
  const q = query.toLowerCase();
  const matches = [];

  try {
    const headers = { Authorization: `Bearer ${token}` };
    let pageToken = null;
    let pages = 0;

    do {
      const params = new URLSearchParams({
        personFields: PERSON_FIELDS,
        pageSize: '500',
        sortOrder: 'LAST_NAME_ASCENDING',
      });
      if (pageToken) params.set('pageToken', pageToken);

      const res = await fetch(`${CONNECTIONS_API}?${params}`, {
        headers,
        signal: AbortSignal.timeout(6000),
      });

      if (!res.ok) {
        console.warn(`[contacts] API error: ${res.status}`);
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
    } while (pageToken && matches.length < maxResults && pages < 10);

    console.log(`[contacts] Search "${query}": ${matches.length} matches in ${pages} page(s)`);
  } catch (e) {
    console.warn('[contacts] Search error:', e?.message);
  }

  return matches;
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
