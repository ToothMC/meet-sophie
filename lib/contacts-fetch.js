// lib/contacts-fetch.js — Google Contacts Search (People API)
// Search-only: keine Preloads, keine Pagination, kein Cache.
// Geburtstage kommen ueber den Google Calendar Geburtstags-Kalender.

import { getValidToken } from './google-token.js';

const SEARCH_API = 'https://people.googleapis.com/v1/people:searchContacts';
const READ_MASK = 'names,emailAddresses,phoneNumbers,birthdays,organizations,nicknames';

/**
 * Sucht Kontakte serverseitig via Google People API.
 * Google sucht auf ihrer Seite — kein lokales Laden noetig.
 * @param {string} token — gueltiger Google Access Token
 * @param {string} query — Suchbegriff (Name, Email, Telefon)
 * @param {number} maxResults — max Ergebnisse (default 10)
 * @returns {Array} — normalisierte Kontakte
 */
export async function searchContacts(token, query, maxResults = 10) {
  try {
    const params = new URLSearchParams({
      query,
      readMask: READ_MASK,
      pageSize: String(Math.min(maxResults, 30)),
    });

    const res = await fetch(`${SEARCH_API}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.warn(`[contacts] Search API error: ${res.status} ${res.statusText}`);
      return [];
    }

    const data = await res.json();
    return (data.results || [])
      .map(r => normalizePerson(r.person))
      .filter(c => c.name);
  } catch (e) {
    console.warn('[contacts] Search error:', e?.message);
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
