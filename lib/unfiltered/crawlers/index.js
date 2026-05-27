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
//  2. fetchRedditGossip — public JSON, kein Key.
//
//  3. fetchRSSBoulevard — country-spezifische RSS-Feeds.
//
//  4. fetchCustomFeeds — User-spezifische RSS-/Domain-Einträge aus
//     unf_boundaries.custom_feeds. Auto-Discover via HTML-<link rel=
//     "alternate"> oder Common-Path-Fallback (/feed, /rss, /atom.xml).
//     Resolved-URLs werden in custom_feeds_meta gecached.

import { fetchNewsApiSignals } from "./news-api.js";
import { fetchRedditGossip }   from "./reddit.js";
import { fetchRSSBoulevard }   from "./rss-boulevard.js";
import { fetchCustomFeeds }    from "./custom-feeds.js";
import { filterByGuards }      from "../guards.js";

const HARD_LIMIT_SIGNALS = 100;

/**
 * @param {Object} opts
 * @param {Array<string>} [opts.interests]
 * @param {string}        [opts.country]
 * @param {Array<string>} [opts.avoid_topics]
 * @param {Array<string>} [opts.custom_feeds]   — User-spezifische Feed-URLs/Domains
 * @param {Object}        [opts.custom_meta]    — lazy cache der resolved-URLs
 * @returns {Promise<{signals: Array, custom_resolved_map: Object}>}
 */
export async function runCrawlers({
  interests = [],
  country = "DE",
  avoid_topics = [],
  custom_feeds = [],
  custom_meta = {},
} = {}) {
  const [newsRes, redditRes, rssRes, customRes] = await Promise.allSettled([
    fetchNewsApiSignals({ interests, country }),
    fetchRedditGossip({ interests }),
    fetchRSSBoulevard({ country }),
    fetchCustomFeeds({ custom_feeds, meta: custom_meta }),
  ]);

  const pick = (r) => (r.status === "fulfilled" && r.value != null ? r.value : null);
  const customPayload = pick(customRes) || { signals: [], resolved_map: {} };

  const raw = [
    ...(pick(newsRes)   || []),
    ...(pick(redditRes) || []),
    ...(pick(rssRes)    || []),
    ...customPayload.signals,
  ].slice(0, HARD_LIMIT_SIGNALS);

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

  return {
    signals: deduped,
    custom_resolved_map: customPayload.resolved_map,
  };
}
