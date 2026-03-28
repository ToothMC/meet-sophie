// api/ai/tools.js — Echtzeit-Tools: Wetter, Web-Suche, News, Wikipedia
// Bing Search API (primary, needs BING_API_KEY) → DuckDuckGo/Google News RSS (fallback)
// Open-Meteo for weather (kostenlos, kein Key)
// Wikipedia REST API (kostenlos, kein Key)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body && typeof body === 'object' ? body : {};

  const { tool, params } = body;
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

export async function webSearch(query) {
  if (!query) return 'Keine Suchanfrage angegeben.';

  // Primary: Google Custom Search API (if keys are set)
  const googleKey = process.env.GOOGLE_SEARCH_API_KEY;
  const googleCx = process.env.GOOGLE_SEARCH_CX;
  if (googleKey && googleCx) {
    try {
      const gRes = await fetch(
        `https://www.googleapis.com/customsearch/v1?key=${googleKey}&cx=${googleCx}&q=${encodeURIComponent(query)}&num=5&lr=lang_de`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (gRes.ok) {
        const data = await gRes.json();
        const results = (data.items || []).slice(0, 5);
        if (results.length > 0) {
          const items = results.map(r => `- ${r.title}: ${r.snippet}`);
          return `Web-Suchergebnisse für "${query}":\n${items.join('\n')}`;
        }
      }
    } catch (e) { console.error('[tools] Google search error:', e?.message); }
  }

  // Secondary: Bing Search API (if key is set)
  const bingKey = process.env.BING_API_KEY;
  if (bingKey) {
    try {
      const bingRes = await fetch(
        `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=5&mkt=de-DE`,
        { headers: { 'Ocp-Apim-Subscription-Key': bingKey }, signal: AbortSignal.timeout(5000) }
      );
      if (bingRes.ok) {
        const data = await bingRes.json();
        const results = (data.webPages?.value || []).slice(0, 5);
        if (results.length > 0) {
          const items = results.map(r => `- ${r.name}: ${r.snippet}`);
          return `Web-Suchergebnisse für "${query}":\n${items.join('\n')}`;
        }
      }
    } catch (e) { console.error('[tools] Bing search error:', e?.message); }
  }

  // Fallback: DuckDuckGo Instant Answer API (kein Key)
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
      if (ddg.Abstract) parts.push(`${ddg.AbstractSource}: ${ddg.Abstract}`);
      if (ddg.Answer) parts.push(`Antwort: ${ddg.Answer}`);
      if (ddg.RelatedTopics?.length > 0) {
        const topics = ddg.RelatedTopics.filter(t => t.Text).slice(0, 5).map(t => `- ${t.Text}`);
        if (topics.length > 0) parts.push(`Verwandte Ergebnisse:\n${topics.join('\n')}`);
      }
      if (parts.length > 0) return parts.join('\n\n');
    }
  } catch (_) {}

  return `Keine Ergebnisse für "${query}" gefunden.`;
}

// ── News: Bing News API (primary) → Google News RSS (fallback) ──

export async function getNews(topic) {
  if (!topic) topic = 'world';

  // Primary: Google Custom Search for News (if keys are set)
  const googleKey = process.env.GOOGLE_SEARCH_API_KEY;
  const googleCx = process.env.GOOGLE_SEARCH_CX;
  if (googleKey && googleCx) {
    try {
      const gRes = await fetch(
        `https://www.googleapis.com/customsearch/v1?key=${googleKey}&cx=${googleCx}&q=${encodeURIComponent(topic + ' news')}&num=8&lr=lang_de&sort=date`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (gRes.ok) {
        const data = await gRes.json();
        const results = (data.items || []).slice(0, 8);
        if (results.length > 0) {
          const items = results.map(r => `- ${r.title}${r.displayLink ? ` (${r.displayLink})` : ''}`);
          return `Aktuelle Nachrichten zu "${topic}":\n${items.join('\n')}`;
        }
      }
    } catch (e) { console.error('[tools] Google news error:', e?.message); }
  }

  // Secondary: Bing News API (if key is set)
  const bingKey = process.env.BING_API_KEY;
  if (bingKey) {
    try {
      const bingRes = await fetch(
        `https://api.bing.microsoft.com/v7.0/news/search?q=${encodeURIComponent(topic)}&count=8&mkt=de-DE`,
        { headers: { 'Ocp-Apim-Subscription-Key': bingKey }, signal: AbortSignal.timeout(5000) }
      );
      if (bingRes.ok) {
        const data = await bingRes.json();
        const articles = (data.value || []).slice(0, 8);
        if (articles.length > 0) {
          const items = articles.map(a => {
            const date = a.datePublished ? new Date(a.datePublished).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
            return `- ${a.name}${a.provider?.[0]?.name ? ` (${a.provider[0].name})` : ''}${date ? ` — ${date}` : ''}`;
          });
          return `Aktuelle Nachrichten${topic !== 'world' ? ` zu "${topic}"` : ''}:\n${items.join('\n')}`;
        }
      }
    } catch (e) { console.error('[tools] Bing news error:', e?.message); }
  }

  // Fallback: Google News RSS
  const lang = 'de';
  const url = topic === 'world'
    ? `https://news.google.com/rss?hl=${lang}&gl=DE&ceid=DE:de`
    : `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=${lang}&gl=DE&ceid=DE:de`;

  try {
    const rssRes = await fetch(url, { signal: AbortSignal.timeout(5000) });
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

  return `Keine aktuellen Nachrichten zu "${topic}" verfügbar.`;
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

  // Try direct page summary first (fast, clean)
  const slug = encodeURIComponent(query.trim().replace(/\s+/g, '_'));
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
