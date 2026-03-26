// api/ai/tools.js — Echtzeit-Tools: Wetter, Web-Suche, News
// Kostenlose APIs: Open-Meteo (Wetter), DuckDuckGo (Suche/News)

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

// ── Web Search: DuckDuckGo Instant Answer (kostenlos, kein API-Key) ──

export async function webSearch(query) {
  if (!query) return 'Keine Suchanfrage angegeben.';

  // DuckDuckGo Instant Answer API
  const ddgRes = await fetch(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
  );
  if (!ddgRes.ok) return `Suche nach "${query}" fehlgeschlagen.`;
  const ddg = await ddgRes.json();

  const parts = [];

  // Abstract (Wikipedia-style answer)
  if (ddg.Abstract) {
    parts.push(`${ddg.AbstractSource}: ${ddg.Abstract}`);
  }

  // Answer (direct answer)
  if (ddg.Answer) {
    parts.push(`Antwort: ${ddg.Answer}`);
  }

  // Related topics
  if (ddg.RelatedTopics?.length > 0) {
    const topics = ddg.RelatedTopics
      .filter(t => t.Text)
      .slice(0, 5)
      .map(t => `- ${t.Text}`);
    if (topics.length > 0) {
      parts.push(`Verwandte Ergebnisse:\n${topics.join('\n')}`);
    }
  }

  if (parts.length === 0) {
    // Fallback: try wttr.in style or return no results
    return `Keine direkten Ergebnisse für "${query}" gefunden. Sophie sollte mit eigenem Wissen antworten.`;
  }

  return parts.join('\n\n');
}

// ── News: DuckDuckGo News (kostenlos, kein API-Key) ──

export async function getNews(topic) {
  if (!topic) topic = 'world';

  // Use wttr.in-style approach: fetch from a simple news API
  // Primary: DuckDuckGo Instant Answer (robust JSON)
  try {
    const ddgRes = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(topic)}&format=json&no_html=1&skip_disambig=1`,
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
        const topics = ddg.RelatedTopics
          .filter(t => t && t.Text)
          .slice(0, 8)
          .map(t => `- ${t.Text}`);
        if (topics.length > 0) parts.push(`Themen zu "${topic}":\n${topics.join('\n')}`);
      }
      if (parts.length > 0) return parts.join('\n\n');
    }
  } catch (_) {}

  // Fallback: return what we know
  return `Aktuelle Nachrichten zu "${topic}" konnten nicht abgerufen werden. Sophie sollte mit eigenem Wissen antworten und erwähnen, dass sie keine Echtzeit-News hat.`;
}
