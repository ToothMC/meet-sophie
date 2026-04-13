// lib/contacts-fetch.js — Google People API Wrapper + Cache
// Holt Kontakte, normalisiert, formatiert als Prompt-Kontext.
// Cache: 30 Min TTL (Kontakte aendern sich selten).

import { createClient } from '@supabase/supabase-js';
import { getValidToken } from './google-token.js';

const CONTACTS_API = 'https://people.googleapis.com/v1/people/me/connections';
const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,birthdays,organizations,nicknames';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 Minuten

// In-Memory Cache pro User (Vercel Cold-Start = frisch, reicht fuer Burst-Requests)
const memCache = new Map();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Holt Kontakte aus Google People API.
 * @param {string} token — gueltiger Google Access Token
 * @param {object} options
 * @param {number} options.maxResults — max Kontakte (default 200)
 * @returns {{ contacts: Array, fetchedAt: string } | null}
 */
export async function fetchContacts(token, { maxResults = 200 } = {}) {
  try {
    const params = new URLSearchParams({
      personFields: PERSON_FIELDS,
      pageSize: String(Math.min(maxResults, 1000)),
      sortOrder: 'LAST_NAME_ASCENDING',
    });

    const res = await fetch(`${CONTACTS_API}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.warn(`[contacts] API error: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = await res.json();
    const contacts = (data.connections || []).map(person => {
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
    }).filter(c => c.name);

    return { contacts, fetchedAt: new Date().toISOString() };
  } catch (e) {
    console.warn('[contacts] Fetch error:', e?.message);
    return null;
  }
}

/**
 * Formatiert Kontakte als kompakter Prompt-Block.
 * Fokus: Geburtstage der naechsten 30 Tage + Kontakt-Uebersicht.
 */
export function formatContactsContext(contacts, language = 'de') {
  if (!contacts?.length) return '';

  const now = new Date();
  const monthDay = (m, d) => m * 100 + d;
  const today = monthDay(now.getMonth() + 1, now.getDate());

  // Geburtstage in den naechsten 30 Tagen
  const upcomingBirthdays = contacts
    .filter(c => c.birthday)
    .map(c => {
      const [m, d] = c.birthday.split('-').map(Number);
      const bd = monthDay(m, d);
      // Tage bis Geburtstag (zirkulaer)
      const diff = bd >= today ? bd - today : (bd + 1231) - today;
      return { name: c.firstName || c.name, month: m, day: d, diff };
    })
    .filter(b => b.diff <= 30)
    .sort((a, b) => a.diff - b.diff);

  const header = language === 'de'
    ? `KONTAKTE: ${contacts.length} Kontakte gespeichert.`
    : `CONTACTS: ${contacts.length} contacts stored.`;

  let result = header;

  if (upcomingBirthdays.length > 0) {
    const bdLabel = language === 'de' ? 'Geburtstage bald' : 'Upcoming birthdays';
    const bdList = upcomingBirthdays.slice(0, 10).map(b => {
      const dayStr = `${String(b.day).padStart(2, '0')}.${String(b.month).padStart(2, '0')}.`;
      const tag = b.diff === 0 ? (language === 'de' ? ' (HEUTE!)' : ' (TODAY!)') : '';
      return `${b.name} (${dayStr}${tag})`;
    }).join(', ');
    result += `\n${bdLabel}: ${bdList}`;
  }

  return result;
}

/**
 * Sucht in Kontakten nach Name, Email oder Telefon.
 */
export function searchContacts(contacts, query) {
  if (!contacts?.length || !query) return [];
  const q = query.toLowerCase();
  return contacts.filter(c =>
    c.name.toLowerCase().includes(q) ||
    c.firstName.toLowerCase().includes(q) ||
    c.lastName.toLowerCase().includes(q) ||
    c.nickname.toLowerCase().includes(q) ||
    c.email.toLowerCase().includes(q) ||
    c.phone.includes(q)
  ).slice(0, 10);
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
 * Cache-first: liest aus Memory-Cache, bei Miss holt von Google API.
 * Kontakte aendern sich selten → 30 Min TTL, In-Memory + DB Fallback.
 */
export async function getContactsForUser(userId, { language = 'de', forceRefresh = false } = {}) {
  // 1. In-Memory Cache
  const cacheKey = `contacts:${userId}`;
  if (!forceRefresh && memCache.has(cacheKey)) {
    const cached = memCache.get(cacheKey);
    if (cached.expiresAt > Date.now()) {
      return { text: formatContactsContext(cached.contacts, language), contacts: cached.contacts, cached: true };
    }
    memCache.delete(cacheKey);
  }

  // 2. Google API
  const token = await getValidToken(userId, 'google_calendar');
  if (!token) return null;

  const data = await fetchContacts(token);
  if (!data?.contacts) return null;

  // 3. Cache schreiben
  memCache.set(cacheKey, {
    contacts: data.contacts,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  const text = formatContactsContext(data.contacts, language);
  return { text, contacts: data.contacts, cached: false };
}
