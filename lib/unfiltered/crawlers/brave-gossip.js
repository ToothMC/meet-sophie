// lib/unfiltered/crawlers/brave-gossip.js — Direkter Brave-Search-Aufruf
// mit Gossip-Query-Templates pro Interest. Bewusst KEIN webSearch() aus
// api/ai/tools.js — der macht enrichTopResults (pro Treffer Page-Fetch),
// das wäre für 4–6 parallele Queries zu langsam und zu teuer.

const QUERY_TEMPLATES = {
  royals: country => [
    `royal family news ${country || ""} today`.trim(),
    "british royal family controversy",
    "european royals scandal week",
  ],
  "reality-tv": country => [
    `reality tv drama ${country || ""} this week`.trim(),
    "love island bachelor housewives controversy",
  ],
  celebs: country => [
    `celebrity gossip ${country || ""} today`.trim(),
    "celebrity feud rumor this week",
  ],
  music: () => [
    "pop music drama feud this week",
  ],
  sport: country => [
    `sport scandal rumor ${country || ""} week`.trim(),
  ],
};

const MAX_QUERIES = 5;
const RESULTS_PER_QUERY = 5;

export async function fetchBraveGossip({ interests = [], country = "DE" } = {}) {
  const braveKey = (process.env.BING_API_KEY || process.env.BRAVE_API_KEY || "").trim();
  if (!braveKey) return [];

  const queries = Array.from(new Set(
    (Array.isArray(interests) ? interests : [])
      .flatMap(i => (QUERY_TEMPLATES[i] || (() => []))(country))
      .map(q => String(q).trim())
      .filter(Boolean)
  )).slice(0, MAX_QUERIES);

  if (!queries.length) return [];

  const signals = [];
  for (const q of queries) {
    try {
      const r = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${RESULTS_PER_QUERY}`,
        {
          headers: { "Accept": "application/json", "X-Subscription-Token": braveKey },
          signal: AbortSignal.timeout(5000),
        }
      );
      if (!r.ok) {
        console.warn(`[unf/brave] HTTP ${r.status} for "${q}"`);
        continue;
      }
      const j = await r.json();
      const results = Array.isArray(j?.web?.results) ? j.web.results : [];
      for (const it of results.slice(0, RESULTS_PER_QUERY)) {
        const url = it?.url || "";
        const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
        signals.push({
          source:    "brave",
          publisher: host || it?.profile?.name || "web",
          headline:  String(it?.title || "").slice(0, 240),
          url,
          text:      String(it?.description || "").slice(0, 400),
          query:     q,
          confidence: "boulevard",  // default — guards.js entscheidet was als 'news' durchgeht
          fetched_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.warn(`[unf/brave] failed for "${q}":`, err?.message || err);
    }
  }
  return signals;
}
