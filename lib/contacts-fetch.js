// lib/contacts-fetch.js — Google Contacts Search (People API)
// Durchsucht "Meine Kontakte" + "Weitere Kontakte" + connections.list Fallback.
// Gibt Diagnose-Info zurueck wenn keine Ergebnisse gefunden werden.

import { getValidToken } from './google-token.js';

const SEARCH_CONTACTS_API = 'https://people.googleapis.com/v1/people:searchContacts';
const SEARCH_OTHER_API = 'https://people.googleapis.com/v1/otherContacts:search';
const CONNECTIONS_API = 'https://people.googleapis.com/v1/people/me/connections';
const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,birthdays,organizations,nicknames';

/**
 * Phonetische Normalisierung fuer deutsche Namen.
 * "Maike" und "Meike" werden gleich, "Stefan" und "Stephan" werden gleich.
 */
function phoneticNormalize(str) {
  return str.toLowerCase()
    .replace(/ai/g, 'ei')    // Maike → Meike
    .replace(/ay/g, 'ei')    // Mayer → Meier
    .replace(/ey/g, 'ei')    // Meyer → Meier
    .replace(/ph/g, 'f')     // Stephan → Stefan
    .replace(/th/g, 't')     // Thomas → Tomas
    .replace(/sch/g, 's')    // leichte Vereinfachung
    .replace(/ck/g, 'k')     // Beck → Bek
    .replace(/dt/g, 't')     // Schmidt → Schmit
    .replace(/ß/g, 'ss')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue');
}

/**
 * Prueft ob ein Kontakt zur Suchanfrage passt.
 * Wortweise: "Maike Hammer" matcht wenn EINER der Begriffe passt.
 * Phonetisch: "Maike" findet auch "Meike".
 */
function contactMatchesQuery(contact, query) {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
  const fields = [
    contact.name, contact.firstName, contact.lastName,
    contact.nickname, contact.email, contact.phone,
  ].map(f => (f || '').toLowerCase());
  const phoneticFields = fields.map(phoneticNormalize);

  return words.some(word => {
    const pWord = phoneticNormalize(word);
    return fields.some(f => f.includes(word)) ||
           phoneticFields.some(f => f.includes(pWord));
  });
}

/**
 * Durchsucht alle Kontakt-Quellen parallel mit Diagnose.
 */
export async function searchContacts(token, query, maxResults = 10) {
  if (!query || query.length < 2) return { results: [], debug: 'query too short' };

  // Auch phonetische Variante an Google Search APIs schicken
  // "Maike" → auch "Meike" suchen, "Mayer" → auch "Meier"
  const altQuery = phoneticNormalize(query) !== query.toLowerCase()
    ? query.toLowerCase().replace(/ai/g, 'ei').replace(/ay/g, 'ei').replace(/ey/g, 'ei')
    : null;

  const searches = [
    searchMyContacts(token, query, maxResults),
    searchOtherContacts(token, query, maxResults),
    searchViaConnectionsList(token, query, maxResults),
  ];
  // Wenn phonetische Variante anders ist, auch damit suchen
  if (altQuery && altQuery !== query.toLowerCase()) {
    searches.push(searchMyContacts(token, altQuery, maxResults));
    searches.push(searchOtherContacts(token, altQuery, maxResults));
  }

  const results = await Promise.all(searches);
  const myResult = results[0];
  const otherResult = results[1];
  const listResult = results[2];

  // Merge + Deduplizierung (alle Ergebnisse inkl. phonetische Varianten)
  const allContacts = [];
  for (const r of results) {
    allContacts.push(...(r.contacts || []));
  }

  const seen = new Set();
  const merged = [];
  for (const c of allContacts) {
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
        if (contactMatchesQuery(c, query)) {
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
