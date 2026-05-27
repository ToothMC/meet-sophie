// lib/unfiltered/crawlers/news-api.js — wiederverwendete News-Quellen
// aus Sophie's bestehenden Tools statt eigenem Brave-/RSS-Stack.
//
// Nutzt zwei Pfade aus api/ai/tools.js:
//
//  1. getNews(topic):
//     - PRIMÄR: Brave News Search (X-Subscription-Token)
//     - FALLBACK: Google News RSS — KEIN Key nötig, funktioniert auch
//       wenn Brave-Key invalid ist
//     - Liefert formatierten String "- Title (Publisher) — Date\n..."
//
//  2. groundedSearch(query):
//     - Google Gemini mit `google_search` Tool
//     - Liefert { facts: [], sources: [{title, url}], confidence }
//     - URLs sind ECHT (kommen aus Google-Search-Grounding)
//
// Wir parsen getNews-Strings und kombinieren mit groundedSearch.facts/sources
// zu Signal-Objekten mit url-Feld — Synthesizer-URL-Grounding erkennt sie.

import { getNews, groundedSearch } from "../../../api/ai/tools.js";

// Pro Interest mehrere Topic-Variationen (Brave News bzw. Google News RSS)
const TOPICS_BY_INTEREST = {
  royals:        ["royal family", "british royals", "europäische royals"],
  "reality-tv":  ["reality tv drama", "love island", "germany's next topmodel"],
  celebs:        ["celebrity gossip", "promi news", "celebrity drama"],
  music:         ["pop music drama", "musik promi"],
  sport:         ["sport rumor", "fußball klatsch"],
};

const GROUNDED_QUERIES_BY_COUNTRY = {
  DE: [
    "aktueller Promi-Klatsch heute",
    "Royal Family aktuelle Nachrichten heute",
    "Reality TV Drama diese Woche",
  ],
  AT: [
    "aktueller Promi-Klatsch Österreich heute",
    "Royal Family aktuelle Nachrichten heute",
  ],
  CH: [
    "aktueller Promi-Klatsch Schweiz heute",
  ],
  GB: [
    "celebrity gossip UK today",
    "royal family news this week",
  ],
  US: [
    "celebrity gossip today",
    "reality TV drama this week",
  ],
};

// Parser für die getNews-Antwortstrings ("- Title (Publisher) — Date")
function parseNewsLines(text) {
  if (typeof text !== "string") return [];
  const lines = text.split("\n").map(l => l.trim()).filter(l => l.startsWith("-"));
  return lines.map(l => {
    const body = l.replace(/^[-•]\s*/, "");
    // Match "Title (Publisher) — Date"  ODER  "Title (Publisher)"  ODER  "Title"
    const m = body.match(/^(.+?)\s*(?:\((.+?)\))?\s*(?:[—–-]\s*(.+))?$/);
    if (!m) return null;
    const title = (m[1] || "").trim();
    const publisher = (m[2] || "").trim();
    const date = (m[3] || "").trim();
    if (!title) return null;
    return { title, publisher, date };
  }).filter(Boolean);
}

/**
 * Holt Daily-Briefing-Signale primär über die bestehenden Sophie-APIs.
 * @param {Object} opts
 * @param {Array<string>} opts.interests
 * @param {string} opts.country
 * @returns {Promise<Array>} signal[]
 */
export async function fetchNewsApiSignals({ interests = [], country = "DE" } = {}) {
  const signals = [];

  // ── 1. getNews — pro Interest mehrere Topics, parallel ─────────────────
  const topics = Array.from(new Set(
    (Array.isArray(interests) ? interests : [])
      .flatMap(i => TOPICS_BY_INTEREST[i] || [])
  )).slice(0, 6); // Cap: max 6 getNews-Calls pro Briefing

  if (topics.length) {
    const results = await Promise.allSettled(topics.map(t => getNews(t)));
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status !== "fulfilled" || typeof r.value !== "string") continue;
      if (r.value.includes("[NEWS-TOOL FEHLGESCHLAGEN]")) continue;
      const parsed = parseNewsLines(r.value);
      for (const item of parsed) {
        // getNews liefert leider keine URLs zurück — Sophie kann die
        // Story nicht zu einer einzigen Source pinnen. Wir setzen die
        // Topic-Query als pseudo-url (eindeutig pro Lauf) damit das URL-
        // Grounding im Synthesizer matchen kann.
        const pseudoUrl = `news:${topics[i]}#${encodeURIComponent(item.title.slice(0, 80))}`;
        signals.push({
          source:    "news",
          publisher: item.publisher || "news",
          headline:  item.title,
          url:       pseudoUrl,
          text:      item.date ? `Veröffentlicht: ${item.date}` : "",
          query:     topics[i],
          confidence: "news",
          fetched_at: new Date().toISOString(),
        });
      }
    }
  }

  // ── 2. groundedSearch — pro Country 2–3 fokussierte Queries ────────────
  const groundedQueries = GROUNDED_QUERIES_BY_COUNTRY[country] || GROUNDED_QUERIES_BY_COUNTRY.DE;
  const groundedResults = await Promise.allSettled(
    groundedQueries.slice(0, 3).map(q => groundedSearch(q))
  );

  for (let i = 0; i < groundedResults.length; i++) {
    const r = groundedResults[i];
    if (r.status !== "fulfilled" || !r.value) continue;
    const { facts = [], sources = [] } = r.value;
    if (!Array.isArray(facts) || !facts.length) continue;
    // groundingMetadata gibt uns echte URLs zurück — pro Fact mit der
    // (vermutlich passenden) ersten source verknüpfen.
    for (let f = 0; f < facts.length && f < 5; f++) {
      const factText = String(facts[f] || "").trim();
      if (!factText) continue;
      const src = sources[Math.min(f, sources.length - 1)];
      signals.push({
        source:    "gemini",
        publisher: src?.title || "google search",
        headline:  factText.slice(0, 200),
        url:       src?.url || `gemini:${groundedQueries[i]}#${f}`,
        text:      factText,
        query:     groundedQueries[i],
        confidence: "rumor",
        fetched_at: new Date().toISOString(),
      });
    }
  }

  return signals;
}
