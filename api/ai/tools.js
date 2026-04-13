// api/ai/tools.js — Echtzeit-Tools: Wetter, Web-Suche, News, Wikipedia, Flugstatus
// Bing Search API (primary, needs BING_API_KEY) → DuckDuckGo/Google News RSS (fallback)
// Open-Meteo for weather (kostenlos, kein Key)
// Wikipedia REST API (kostenlos, kein Key)

// Dynamic imports fuer calendar + contacts (vermeidet crypto-Chain beim Cold-Start)
async function getCalendarModule() { return import('../../lib/calendar-fetch.js'); }
async function getContactsModule() { return import('../../lib/contacts-fetch.js'); }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body && typeof body === 'object' ? body : {};

  const { tool, params, userId } = body;
  if (!tool || !params) return res.status(400).json({ error: 'Missing tool or params' });

  try {
    let result;
    switch (tool) {
      case 'weather':
        result = await getWeather(params.location);
        break;
      case 'search':
        result = await webSearch(params.query);
        break;
      case 'news':
        result = await getNews(params.topic);
        break;
      case 'wiki':
        result = await getWikipedia(params.query);
        break;
      case 'flight':
        result = await getFlightStatus(params.flight_number);
        break;
      case 'arrivals':
        result = await getAirportFlights(params.airport_iata, 'arr');
        break;
      case 'departures':
        result = await getAirportFlights(params.airport_iata, 'dep');
        break;
      case 'calendar': {
        if (!userId) { result = 'Kalender nicht verfuegbar (nicht angemeldet).'; break; }
        const { getCalendarEventsForUser } = await getCalendarModule();
        const calResult = await getCalendarEventsForUser(userId, {
          days: params.days || 7,
          language: params.language || 'de',
          forceRefresh: !!params.forceRefresh,
        });
        result = calResult?.text || 'Kalender nicht verbunden. Bitte in den Einstellungen verbinden.';
        break;
      }
      case 'calendar_create': {
        if (!userId) { result = 'Nicht angemeldet.'; break; }
        const { calendarWrite: cwCreate } = await getCalendarModule();
        const cr = await cwCreate(userId, 'create', params);
        result = cr.success
          ? `Termin erstellt: "${cr.event.title}" am ${cr.event.start}`
          : `Fehler beim Erstellen: ${cr.error}`;
        break;
      }
      case 'calendar_update': {
        if (!userId) { result = 'Nicht angemeldet.'; break; }
        const { calendarWrite: cwUpdate } = await getCalendarModule();
        const ur = await cwUpdate(userId, 'update', params);
        result = ur.success
          ? `Termin aktualisiert: "${ur.event.title}" — ${ur.event.start}`
          : `Fehler beim Aktualisieren: ${ur.error}`;
        break;
      }
      case 'contacts': {
        if (!userId) { result = 'Nicht angemeldet.'; break; }
        if (!params.query) { result = 'Bitte einen Suchbegriff angeben (Name, Email oder Telefon).'; break; }
        const { searchContactsForUser } = await getContactsModule();
        const contactsResult = await searchContactsForUser(userId, params.query, { language: params.language || 'de' });
        result = contactsResult?.text || 'Kontakte nicht verfuegbar. Bitte Google neu verbinden.';
        break;
      }
      case 'calendar_delete': {
        if (!userId) { result = 'Nicht angemeldet.'; break; }
        const { calendarWrite: cwDelete } = await getCalendarModule();
        const dr = await cwDelete(userId, 'delete', params);
        result = dr.success
          ? 'Termin geloescht.'
          : `Fehler beim Loeschen: ${dr.error}`;
        break;
      }
      default:
        return res.status(400).json({ error: `Unknown tool: ${tool}` });
    }
    return res.status(200).json({ result });
  } catch (err) {
    console.error(`[tools] ${tool} error:`, err?.message);
    return res.status(500).json({ error: err?.message || 'Tool execution failed' });
  }
}

// ── Weather: Open-Meteo (kostenlos, kein API-Key) ──

export async function getWeather(location) {
  if (!location) return 'Kein Ort angegeben.';

  // Step 1: Geocode location
  const geoRes = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=de`
  );
  if (!geoRes.ok) return `Wetter-Suche für "${location}" fehlgeschlagen.`;
  const geoData = await geoRes.json();

  if (!geoData.results?.length) return `Ort "${location}" nicht gefunden.`;
  const { latitude, longitude, name, country } = geoData.results[0];

  // Step 2: Get weather
  const weatherRes = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code` +
    `&timezone=auto&forecast_days=3`
  );
  if (!weatherRes.ok) return `Wetterdaten für ${name} nicht verfügbar.`;
  const weather = await weatherRes.json();

  const current = weather.current;
  const daily = weather.daily;

  const weatherCodes = {
    0: 'Klar', 1: 'Überwiegend klar', 2: 'Teilweise bewölkt', 3: 'Bewölkt',
    45: 'Nebel', 48: 'Reifnebel', 51: 'Leichter Nieselregen', 53: 'Nieselregen',
    55: 'Starker Nieselregen', 61: 'Leichter Regen', 63: 'Regen', 65: 'Starker Regen',
    71: 'Leichter Schneefall', 73: 'Schneefall', 75: 'Starker Schneefall',
    80: 'Regenschauer', 81: 'Starke Regenschauer', 85: 'Schneeschauer',
    95: 'Gewitter', 96: 'Gewitter mit Hagel', 99: 'Starkes Gewitter mit Hagel',
  };

  const desc = weatherCodes[current.weather_code] || 'Unbekannt';
  let result = `Wetter in ${name}, ${country} (jetzt):\n`;
  result += `${desc}, ${current.temperature_2m}°C (gefühlt ${current.apparent_temperature}°C)\n`;
  result += `Wind: ${current.wind_speed_10m} km/h, Luftfeuchtigkeit: ${current.relative_humidity_2m}%\n\n`;
  result += `3-Tage-Vorhersage:\n`;

  for (let i = 0; i < Math.min(3, daily.time.length); i++) {
    const dayDesc = weatherCodes[daily.weather_code[i]] || 'Unbekannt';
    result += `${daily.time[i]}: ${dayDesc}, ${daily.temperature_2m_min[i]}–${daily.temperature_2m_max[i]}°C`;
    if (daily.precipitation_sum[i] > 0) result += `, ${daily.precipitation_sum[i]}mm Niederschlag`;
    result += '\n';
  }
  return result.trim();
}

// ── Web Search: Bing Search API (primary) → DuckDuckGo (fallback) ──

export async function webSearch(query, { withSources = false } = {}) {
  if (!query) return withSources ? { text: 'Keine Suchanfrage angegeben.', sources: [] } : 'Keine Suchanfrage angegeben.';

  const wrap = (text, sources) => withSources ? { text, sources } : text;

  // Primary: Brave Search API (full web search, no domain restrictions)
  const braveKey = (process.env.BING_API_KEY || process.env.BRAVE_API_KEY || "").trim();
  if (braveKey) {
    try {
      const braveRes = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`,
        { headers: { 'Accept': 'application/json', 'X-Subscription-Token': braveKey }, signal: AbortSignal.timeout(5000) }
      );
      if (braveRes.ok) {
        const data = await braveRes.json();
        const results = (data.web?.results || []).slice(0, 8).map(r => ({
          title: r.title, snippet: r.description, link: r.url,
        }));
        if (results.length > 0) {
          const enriched = await enrichTopResults(results, 3);
          const sources = results.slice(0, 5).map(r => ({ title: r.title || 'Quelle', url: r.link })).filter(s => s.url);
          return wrap(`Web-Suchergebnisse für "${query}":\n\n${enriched}`, sources);
        }
      } else {
        const errBody = await braveRes.text().catch(() => "");
        console.error(`[tools] Brave HTTP ${braveRes.status}: ${errBody.slice(0, 200)}`);
      }
    } catch (e) { console.error('[tools] Brave search error:', e?.message); }
  }

  // Fallback: DuckDuckGo Instant Answer API (kein Key, nur strukturierte Daten)
  try {
    const ddgRes = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (ddgRes.ok) {
      const text = await ddgRes.text();
      let ddg;
      try { ddg = JSON.parse(text); } catch { ddg = {}; }
      const parts = [];
      const sources = [];
      if (ddg.AbstractURL) sources.push({ title: ddg.AbstractSource || 'Quelle', url: ddg.AbstractURL });
      if (ddg.Abstract) parts.push(`${ddg.AbstractSource}: ${ddg.Abstract}`);
      if (ddg.Answer) parts.push(`Antwort: ${ddg.Answer}`);
      if (ddg.RelatedTopics?.length > 0) {
        const topics = ddg.RelatedTopics.filter(t => t.Text).slice(0, 5).map(t => `- ${t.Text}`);
        if (topics.length > 0) parts.push(`Verwandte Ergebnisse:\n${topics.join('\n')}`);
        for (const t of ddg.RelatedTopics.filter(t => t.FirstURL).slice(0, 3)) {
          sources.push({ title: t.Text?.slice(0, 60) || 'Quelle', url: t.FirstURL });
        }
      }
      if (parts.length > 0) return wrap(parts.join('\n\n'), sources);
    }
  } catch (_) {}

  return wrap(`Keine Ergebnisse für "${query}" gefunden.`, []);
}

// Fetch actual page content for top N results to give Sophie more context
async function enrichTopResults(results, topN) {
  const lines = [];

  // Fetch page content for top N in parallel (3s timeout each)
  const fetchPromises = results.slice(0, topN).map(async (r) => {
    const url = r.link || r.formattedUrl;
    if (!url) return null;
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(3000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SophieBot/1.0)' },
      });
      if (!resp.ok) return null;
      const html = await resp.text();
      return extractTextContent(html);
    } catch { return null; }
  });

  const pageContents = await Promise.all(fetchPromises);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const title = r.title || r.name || '';
    const snippet = r.snippet || '';
    const url = r.link || r.formattedUrl || '';

    if (i < topN && pageContents[i]) {
      // Rich result with page content (max 800 chars)
      lines.push(`### ${title}\n${url}\n${pageContents[i]}`);
    } else {
      // Snippet-only result
      lines.push(`- ${title}: ${snippet}`);
    }
  }

  return lines.join('\n\n');
}

// Extract readable text from HTML (no external deps)
function extractTextContent(html) {
  if (!html) return null;
  // Remove script, style, nav, header, footer tags and their content
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '');
  // Replace block-level tags with newlines
  text = text.replace(/<\/?(p|div|br|h[1-6]|li|tr|blockquote)[^>]*>/gi, '\n');
  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');
  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ');
  // Collapse whitespace and trim
  text = text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
  // Return first ~800 chars (enough context without bloating)
  if (text.length < 50) return null;
  return text.length > 800 ? text.slice(0, 800) + '...' : text;
}

// ── News: Bing News API (primary) → Google News RSS (fallback) ──

export async function getNews(topic) {
  if (!topic) topic = 'world';

  // Primary: Brave News Search
  const braveKey = (process.env.BING_API_KEY || process.env.BRAVE_API_KEY || "").trim();
  if (braveKey) {
    try {
      const braveRes = await fetch(
        `https://api.search.brave.com/res/v1/news/search?q=${encodeURIComponent(topic)}&count=8`,
        { headers: { 'Accept': 'application/json', 'X-Subscription-Token': braveKey }, signal: AbortSignal.timeout(5000) }
      );
      if (braveRes.ok) {
        const data = await braveRes.json();
        const articles = (data.results || []).slice(0, 8);
        if (articles.length > 0) {
          const items = articles.map(a => {
            const source = a.meta_url?.hostname || "";
            const date = a.age || "";
            return `- ${a.title}${source ? ` (${source})` : ''}${date ? ` — ${date}` : ''}`;
          });
          return `Aktuelle Nachrichten${topic !== 'world' ? ` zu "${topic}"` : ''}:\n${items.join('\n')}`;
        }
      }
    } catch (e) { console.error('[tools] Brave news error:', e?.message); }
  }

  // Fallback: Google News RSS (may be blocked on some serverless platforms)
  const lang = 'de';
  const url = topic === 'world'
    ? `https://news.google.com/rss?hl=${lang}&gl=DE&ceid=DE:de`
    : `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=${lang}&gl=DE&ceid=DE:de`;

  try {
    const rssRes = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SophieBot/1.0)' },
    });
    if (!rssRes.ok) throw new Error(`RSS fetch failed: ${rssRes.status}`);
    const xml = await rssRes.text();

    // Split by <item> tags and parse each
    const items = [];
    const chunks = xml.split('<item>').slice(1); // skip everything before first <item>
    for (const chunk of chunks) {
      if (items.length >= 8) break;
      const endIdx = chunk.indexOf('</item>');
      const itemXml = endIdx > -1 ? chunk.slice(0, endIdx) : chunk;

      // Extract title — Google News uses plain <title>, not CDATA
      const tMatch = itemXml.match(/<title>(.*?)<\/title>/s);
      const sMatch = itemXml.match(/<source[^>]*>(.*?)<\/source>/s);
      const dMatch = itemXml.match(/<pubDate>(.*?)<\/pubDate>/s);

      const title = (tMatch?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
      const source = (sMatch?.[1] || '').trim();
      const pubDate = dMatch?.[1] || '';

      if (title) {
        const dateStr = pubDate ? new Date(pubDate).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
        items.push(`- ${title}${source ? ` (${source})` : ''}${dateStr ? ` — ${dateStr}` : ''}`);
      }
    }

    if (items.length > 0) {
      return `Aktuelle Nachrichten${topic !== 'world' ? ` zu "${topic}"` : ''}:\n${items.join('\n')}`;
    }
  } catch (e) {
    console.error('[tools] news RSS error:', e?.message);
  }

  return `[NEWS-TOOL FEHLGESCHLAGEN] Nachrichten konnten nicht geladen werden (alle Quellen nicht erreichbar). Sag dem Nutzer ehrlich, dass die Nachrichten-Suche gerade nicht funktioniert hat, und biete an es später nochmal zu versuchen. Erfinde KEINE Nachrichten.`;
}

// ── Wikipedia: REST API + MediaWiki API (kostenlos, kein API-Key) ──

// Helper: normalize common abbreviations to full German names (for Wikipedia slugs)
function _normalizeQuery(q) {
  const monthMap = {
    jan: 'Januar', feb: 'Februar', mär: 'März', mar: 'März', apr: 'April',
    mai: 'Mai', jun: 'Juni', jul: 'Juli', aug: 'August', sep: 'September',
    okt: 'Oktober', oct: 'Oktober', nov: 'November', dez: 'Dezember', dec: 'Dezember',
  };
  return q.replace(/\b(jan|feb|mär|mar|apr|mai|jun|jul|aug|sep|okt|oct|nov|dez|dec)\b/gi, (m) => {
    return monthMap[m.toLowerCase()] || m;
  });
}

// Helper: full article extract via MediaWiki API (for overview/event pages)
async function _wikiFullExtract(title) {
  try {
    const res = await fetch(
      `https://de.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}` +
      `&prop=extracts&explaintext=1&exsectionformat=plain&exchars=4000&format=json&origin=*`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const pages = data.query?.pages || {};
    const page = Object.values(pages)[0];
    return page?.extract || null;
  } catch { return null; }
}

export async function getWikipedia(query) {
  if (!query) return 'Kein Suchbegriff angegeben.';

  // Normalize abbreviations (feb → Februar, etc.)
  query = _normalizeQuery(query.trim());

  // Try direct page summary first (fast, clean)
  const slug = encodeURIComponent(query.replace(/\s+/g, '_'));
  try {
    const summaryRes = await fetch(
      `https://de.wikipedia.org/api/rest_v1/page/summary/${slug}`,
      { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(5000) }
    );
    if (summaryRes.ok) {
      const data = await summaryRes.json();
      if (data.type === 'standard' && data.extract) {
        let extract = data.extract;
        // If summary is too short (overview/event pages), fetch full article
        if (extract.length < 300) {
          const full = await _wikiFullExtract(data.title);
          if (full && full.length > extract.length) extract = full;
        }
        let result = `Wikipedia: ${data.title}\n\n${extract}`;
        if (data.content_urls?.desktop?.page) {
          result += `\n\nQuelle: ${data.content_urls.desktop.page}`;
        }
        return result;
      }
    }
  } catch (e) { console.error('[tools] Wikipedia summary error:', e?.message); }

  // Fallback: search API → then get summary/full extract of best match
  try {
    const searchRes = await fetch(
      `https://de.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=3&format=json&origin=*`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!searchRes.ok) return `Wikipedia-Suche für "${query}" fehlgeschlagen.`;
    const searchData = await searchRes.json();
    const results = searchData.query?.search || [];

    if (results.length === 0) return `Kein Wikipedia-Artikel zu "${query}" gefunden.`;

    // Get summary of top result, with full extract fallback
    const topTitle = results[0].title;
    const topSlug = encodeURIComponent(topTitle.replace(/\s+/g, '_'));
    const topRes = await fetch(
      `https://de.wikipedia.org/api/rest_v1/page/summary/${topSlug}`,
      { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(5000) }
    );
    if (topRes.ok) {
      const data = await topRes.json();
      if (data.extract) {
        let extract = data.extract;
        if (extract.length < 300) {
          const full = await _wikiFullExtract(data.title);
          if (full && full.length > extract.length) extract = full;
        }
        let result = `Wikipedia: ${data.title}\n\n${extract}`;
        if (data.content_urls?.desktop?.page) {
          result += `\n\nQuelle: ${data.content_urls.desktop.page}`;
        }
        if (results.length > 1) {
          result += `\n\nWeitere Artikel: ${results.slice(1).map(r => r.title).join(', ')}`;
        }
        return result;
      }
    }

    // Last resort: return search snippets
    const snippets = results.map(r => {
      const clean = r.snippet.replace(/<[^>]+>/g, '');
      return `- ${r.title}: ${clean}`;
    });
    return `Wikipedia-Suchergebnisse für "${query}":\n${snippets.join('\n')}`;
  } catch (e) {
    console.error('[tools] Wikipedia search error:', e?.message);
  }

  return `Keine Wikipedia-Informationen zu "${query}" gefunden.`;
}

// ── Flight Status: AirLabs API ──

async function getFlightStatus(flightNumber) {
  if (!flightNumber) return 'Keine Flugnummer angegeben.';

  const apiKey = process.env.AIRLABS_API_KEY;
  if (!apiKey) return 'Flugstatus nicht verfügbar (API-Key fehlt).';

  // Normalize: "LH 1234" → "LH1234", "lh1234" → "LH1234"
  const normalized = String(flightNumber).replace(/\s+/g, '').toUpperCase();

  try {
    const res = await fetch(
      `https://airlabs.co/api/v9/flight?flight_iata=${encodeURIComponent(normalized)}&api_key=${apiKey}`,
      { signal: AbortSignal.timeout(8000) }
    );

    if (!res.ok) {
      console.error(`[tools] AirLabs HTTP ${res.status}`);
      return `Flugstatus für ${normalized} konnte nicht abgerufen werden.`;
    }

    const data = await res.json();
    const f = data?.response;

    if (!f || (Array.isArray(f) && f.length === 0)) {
      return `Kein aktiver Flug mit der Nummer ${normalized} gefunden. Der Flug ist möglicherweise noch nicht gestartet oder bereits gelandet.`;
    }

    // Build human-readable summary
    const flight = Array.isArray(f) ? f[0] : f;
    const parts = [];

    parts.push(`Flug ${flight.flight_iata || normalized}`);
    if (flight.airline_name) parts[0] += ` (${flight.airline_name})`;

    // Status
    const statusMap = {
      'en-route': 'unterwegs',
      'landed': 'gelandet',
      'scheduled': 'geplant',
      'active': 'aktiv',
      'cancelled': 'storniert',
      'incident': 'Zwischenfall',
      'diverted': 'umgeleitet',
      'unknown': 'unbekannt',
    };
    const status = statusMap[flight.status] || flight.status || 'unbekannt';
    parts.push(`Status: ${status}`);

    // Route
    if (flight.dep_iata || flight.arr_iata) {
      const dep = flight.dep_city || flight.dep_iata || '?';
      const arr = flight.arr_city || flight.arr_iata || '?';
      parts.push(`Route: ${dep} → ${arr}`);
    }

    // Departure info
    if (flight.dep_time) parts.push(`Abflug (geplant): ${flight.dep_time}`);
    if (flight.dep_actual) parts.push(`Abflug (tatsächlich): ${flight.dep_actual}`);
    if (flight.dep_delayed) parts.push(`Abflug-Verspätung: ${flight.dep_delayed} Minuten`);
    if (flight.dep_terminal) parts.push(`Terminal: ${flight.dep_terminal}`);
    if (flight.dep_gate) parts.push(`Gate: ${flight.dep_gate}`);

    // Arrival info
    if (flight.arr_time) parts.push(`Ankunft (geplant): ${flight.arr_time}`);
    if (flight.arr_estimated) parts.push(`Ankunft (geschätzt): ${flight.arr_estimated}`);
    if (flight.arr_actual) parts.push(`Ankunft (tatsächlich): ${flight.arr_actual}`);
    if (flight.arr_delayed) parts.push(`Ankunft-Verspätung: ${flight.arr_delayed} Minuten`);
    if (flight.arr_terminal) parts.push(`Ankunfts-Terminal: ${flight.arr_terminal}`);
    if (flight.arr_gate) parts.push(`Ankunfts-Gate: ${flight.arr_gate}`);
    if (flight.arr_baggage) parts.push(`Gepäckband: ${flight.arr_baggage}`);

    // Position (if en-route)
    if (flight.alt && flight.speed) {
      parts.push(`Höhe: ${Math.round(flight.alt * 0.3048)}m (${flight.alt} ft)`);
      parts.push(`Geschwindigkeit: ${flight.speed} km/h`);
    }

    // Aircraft
    if (flight.aircraft_icao) parts.push(`Flugzeugtyp: ${flight.aircraft_icao}`);

    return parts.join('\n');
  } catch (err) {
    console.error('[tools] AirLabs error:', err?.message);
    return `Flugstatus für ${normalized} konnte nicht abgerufen werden.`;
  }
}

export async function getAirportFlights(airportIata, direction = 'arr') {
  if (!airportIata) return 'Kein Flughafen angegeben.';

  const apiKey = process.env.AIRLABS_API_KEY;
  if (!apiKey) return 'Flugdaten nicht verfügbar (API-Key fehlt).';

  const normalized = String(airportIata).replace(/\s+/g, '').toUpperCase();
  const param = direction === 'arr' ? 'arr_iata' : 'dep_iata';
  const label = direction === 'arr' ? 'Ankünfte' : 'Abflüge';

  try {
    const res = await fetch(
      `https://airlabs.co/api/v9/flights?${param}=${encodeURIComponent(normalized)}&api_key=${apiKey}`,
      { signal: AbortSignal.timeout(8000) }
    );

    if (!res.ok) {
      console.error(`[tools] AirLabs airport HTTP ${res.status}`);
      return `${label} für ${normalized} konnten nicht abgerufen werden.`;
    }

    const data = await res.json();
    const flights = data?.response;

    if (!flights || flights.length === 0) {
      return `Keine aktuellen ${label} für ${normalized} gefunden.`;
    }

    // Show up to 8 flights, sorted by scheduled time
    const sorted = flights
      .filter(f => f.flight_iata)
      .sort((a, b) => {
        const tA = direction === 'arr' ? (a.arr_time || '') : (a.dep_time || '');
        const tB = direction === 'arr' ? (b.arr_time || '') : (b.dep_time || '');
        return tA.localeCompare(tB);
      })
      .slice(0, 8);

    const statusMap = {
      'en-route': 'unterwegs', 'landed': 'gelandet', 'scheduled': 'geplant',
      'active': 'aktiv', 'cancelled': 'storniert', 'diverted': 'umgeleitet', 'unknown': '?',
    };

    const lines = sorted.map(f => {
      const status = statusMap[f.status] || f.status || '?';
      const time = direction === 'arr'
        ? (f.arr_actual || f.arr_estimated || f.arr_time || '?')
        : (f.dep_actual || f.dep_estimated || f.dep_time || '?');
      const origin = direction === 'arr' ? (f.dep_city || f.dep_iata || '?') : (f.arr_city || f.arr_iata || '?');
      const delay = direction === 'arr' ? f.arr_delayed : f.dep_delayed;
      const delayStr = delay ? ` (+${delay} Min)` : '';
      return `${f.flight_iata} | ${origin} | ${time}${delayStr} | ${status}`;
    });

    return `${label} ${normalized}:\n${lines.join('\n')}`;
  } catch (err) {
    console.error('[tools] AirLabs airport error:', err?.message);
    return `${label} für ${normalized} konnten nicht abgerufen werden.`;
  }
}

// ── Grounded Search: Gemini 2.5 Flash + google_search (Search Isolation) ──
// Architecture Rule #1: Gemini darf nie direkt an den User sprechen.
// Returns structured search_result — kein answer-Feld.

export async function groundedSearch(query) {
  if (!query) return { facts: [], sources: [], confidence: 0, freshness_required: true, grounding_detected: false };

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  if (!apiKey) {
    console.error('[tools] grounded_search: GEMINI_API_KEY / GOOGLE_AI_API_KEY not set');
    return { facts: [], sources: [], confidence: 0, freshness_required: true, grounding_detected: false };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `Recherchiere die folgende Frage. Antworte NUR als JSON-Objekt ohne Markdown:\n{\n  "facts": ["Fakt 1", "Fakt 2"],\n  "confidence": 0.85\n}\n\nFrage: ${query}`
            }]
          }],
          tools: [{ google_search: {} }]
        })
      }
    );

    clearTimeout(timeout);

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error(`[tools] grounded_search Gemini HTTP ${geminiRes.status}:`, errText);
      return { facts: [], sources: [], confidence: 0, freshness_required: true, grounding_detected: false };
    }

    const geminiData = await geminiRes.json();

    // parts[0].text is a STRING, not an object
    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const chunks = geminiData?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];

    // Parse JSON from text — Gemini may wrap in markdown fences
    let parsed = { facts: [], confidence: 0.5 };
    try {
      const clean = rawText
        .replace(/```json\s*/gi, '')
        .replace(/```/g, '')
        .trim();
      parsed = JSON.parse(clean);
    } catch {
      // Fallback: treat entire text as a single fact
      if (rawText) parsed.facts = [rawText.slice(0, 400)];
    }

    // Extract sources from groundingChunks — deduplicated
    const seenUrls = new Set();
    const sources = chunks
      .filter(c => c?.web?.uri)
      .reduce((acc, c) => {
        if (!seenUrls.has(c.web.uri)) {
          seenUrls.add(c.web.uri);
          acc.push({ title: c.web.title ?? 'Quelle', url: c.web.uri });
        }
        return acc;
      }, []);

    // Normalized search_result — no answer field
    return {
      facts: (parsed.facts ?? []).slice(0, 6),
      sources,
      confidence: parsed.confidence ?? 0.7,
      freshness_required: true,
      grounding_detected: chunks.length > 0,
      retrieved_at: new Date().toISOString()
    };

  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      console.error('[tools] grounded_search timeout 12s');
    } else {
      console.error('[tools] grounded_search error:', err?.message);
    }
    return { facts: [], sources: [], confidence: 0, freshness_required: true, grounding_detected: false };
  }
}
