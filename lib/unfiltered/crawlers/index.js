// lib/unfiltered/crawlers/index.js — Orchestrator: ruft alle Crawler
// parallel auf, sammelt rohe Signale, filtert via guards.

import { fetchRedditGossip }   from "./reddit.js";
import { fetchBraveGossip }    from "./brave-gossip.js";
import { fetchRSSBoulevard }   from "./rss-boulevard.js";
import { filterByGuards }      from "../guards.js";

const HARD_LIMIT_SIGNALS = 80;

export async function runCrawlers({ interests = [], country = "DE", avoid_topics = [] } = {}) {
  const results = await Promise.allSettled([
    fetchBraveGossip({ interests, country }),
    fetchRedditGossip({ interests }),
    fetchRSSBoulevard({ country }),
  ]);

  const raw = results
    .filter(r => r.status === "fulfilled" && Array.isArray(r.value))
    .flatMap(r => r.value)
    .slice(0, HARD_LIMIT_SIGNALS);

  const filtered = filterByGuards(raw, { avoid_topics });

  // De-dupe by headline (case-insensitive normalized)
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
