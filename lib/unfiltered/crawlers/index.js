// lib/unfiltered/crawlers/index.js — Orchestrator: ruft alle Quellen
// parallel auf, sammelt rohe Signale, filtert via guards.
//
// Reihenfolge der Quellen nach Wertigkeit:
//
//  1. fetchNewsApiSignals — wiederverwendet Sophie's bestehende
//     getNews() + groundedSearch() Tools (api/ai/tools.js). Liefert
//     echte URLs aus Google-Search-Grounding (Gemini), funktioniert
//     auch ohne Brave-Key (Google-News-RSS-Fallback). PRIMÄR.
//
//  2. fetchRedditGossip — public JSON, kein Key, kann von Vercel-IPs
//     gerate-limited werden.
//
//  3. fetchRSSBoulevard — country-spezifische RSS-Feeds (Bunte, Gala,
//     TMZ, Page Six, …). Liefert Boulevard-typische Headlines.
//
// (Der frühere fetchBraveGossip-Pfad ist entfernt — getNews() ruft
//  bereits intern den Brave-News-Endpoint, und ohne Key fällt es auf
//  Google-News-RSS zurück. Redundant.)

import { fetchNewsApiSignals } from "./news-api.js";
import { fetchRedditGossip }   from "./reddit.js";
import { fetchRSSBoulevard }   from "./rss-boulevard.js";
import { filterByGuards }      from "../guards.js";

const HARD_LIMIT_SIGNALS = 80;

export async function runCrawlers({ interests = [], country = "DE", avoid_topics = [] } = {}) {
  const results = await Promise.allSettled([
    fetchNewsApiSignals({ interests, country }),
    fetchRedditGossip({ interests }),
    fetchRSSBoulevard({ country }),
  ]);

  const raw = results
    .filter(r => r.status === "fulfilled" && Array.isArray(r.value))
    .flatMap(r => r.value)
    .slice(0, HARD_LIMIT_SIGNALS);

  const filtered = filterByGuards(raw, { avoid_topics });

  // De-dupe by normalized headline
  const seen = new Set();
  const deduped = [];
  for (const s of filtered) {
    const key = String(s.headline || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(s);
  }

  return deduped;
}
