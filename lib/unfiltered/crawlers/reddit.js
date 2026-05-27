// lib/unfiltered/crawlers/reddit.js — Holt Top-Posts aus Klatsch-Subs.
//
// Reddit's öffentliche JSON-Endpoints brauchen keinen Key; nur einen
// freundlichen User-Agent. Wir limitieren bewusst auf wenige Subs pro
// Lauf (Cache-Schonung + Rate-Limits).

const SUBS_BY_INTEREST = {
  royals:        ["SaintMeghanMarkle", "royalgossip", "royalsgossip"],
  "reality-tv":  ["BravoRealHousewives", "LoveIslandTV", "thebachelor", "rupaulsdragrace"],
  celebs:        ["Fauxmoi", "popculturechat", "popheads"],
  music:         ["popheads", "popculturechat"],
  sport:         ["soccer", "formula1", "nba"],
};

const MAX_SUBS_PER_RUN = 6;
const POSTS_PER_SUB    = 5;
const MIN_SCORE        = 50;

export async function fetchRedditGossip({ interests = [] } = {}) {
  const subs = Array.from(new Set(
    (Array.isArray(interests) ? interests : [])
      .flatMap(i => SUBS_BY_INTEREST[i] || [])
  )).slice(0, MAX_SUBS_PER_RUN);

  if (!subs.length) return [];

  const signals = [];
  for (const sub of subs) {
    try {
      const url = `https://www.reddit.com/r/${sub}/hot.json?limit=${POSTS_PER_SUB}`;
      const r = await fetch(url, {
        headers: { "User-Agent": "sophie-unfiltered/1.0" },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) {
        console.warn(`[unf/reddit] ${sub} HTTP ${r.status}`);
        continue;
      }
      const j = await r.json();
      const children = Array.isArray(j?.data?.children) ? j.data.children : [];

      for (const post of children) {
        const p = post?.data || {};
        if (p.over_18 || p.stickied) continue;
        if ((p.score || 0) < MIN_SCORE) continue;
        signals.push({
          source:    "reddit",
          publisher: `r/${sub}`,
          headline:  String(p.title || "").slice(0, 240),
          url:       p.permalink ? `https://reddit.com${p.permalink}` : null,
          score:     Number(p.score) || 0,
          comments:  Number(p.num_comments) || 0,
          text:      String(p.selftext || "").slice(0, 600),
          confidence: "rumor",
          fetched_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.warn(`[unf/reddit] ${sub} failed:`, err?.message || err);
    }
  }
  return signals;
}
