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
