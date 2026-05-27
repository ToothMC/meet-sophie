// api/unfiltered/diag.js — Diagnose-Endpoint für die Daily-Briefing-
// Pipeline. Ruft jede Quelle einzeln auf und meldet:
//  - wie viele Signale gekommen sind
//  - die ersten paar Headlines pro Quelle
//  - welche env-Keys gesetzt sind
//
// GET /api/unfiltered/diag
// GET /api/unfiltered/diag?interests=royals,reality-tv&country=DE

import { createClient } from "@supabase/supabase-js";
import { fetchNewsApiSignals } from "../../lib/unfiltered/crawlers/news-api.js";
import { fetchRedditGossip }   from "../../lib/unfiltered/crawlers/reddit.js";
import { fetchRSSBoulevard }   from "../../lib/unfiltered/crawlers/rss-boulevard.js";
import { loadBoundaries }      from "../../lib/unfiltered/memory.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing Authorization Bearer token" });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: "Invalid token" });

    const boundaries = await loadBoundaries(supabase, user.id);
    const interestsRaw = req.query?.interests
      ? String(req.query.interests).split(",")
      : (Array.isArray(boundaries?.interests) && boundaries.interests.length
          ? boundaries.interests
          : ["royals", "reality-tv", "celebs"]);
    const interests = interestsRaw.map(s => String(s).trim()).filter(Boolean);
    const country  = String(req.query?.country || boundaries?.geo_country || "DE").toUpperCase();

    // News-API path (getNews + groundedSearch)
    const newsSignals = await fetchNewsApiSignals({ interests, country });
    const newsBySource = newsSignals.reduce((acc, s) => {
      acc[s.source] = (acc[s.source] || 0) + 1;
      return acc;
    }, {});
    const news = {
      signal_count: newsSignals.length,
      by_source:    newsBySource,
      sample:       newsSignals.slice(0, 5).map(s => ({
        source: s.source, publisher: s.publisher, headline: s.headline?.slice(0, 100), has_url: !!s.url,
      })),
    };

    // Reddit
    const redditSignals = await fetchRedditGossip({ interests });
    const reddit = {
      signal_count: redditSignals.length,
      subs_tried: interests,
      sample: redditSignals.slice(0, 3).map(s => ({ headline: s.headline?.slice(0, 100), publisher: s.publisher })),
    };

    // RSS
    const rssSignals = await fetchRSSBoulevard({ country });
    const rss = {
      signal_count: rssSignals.length,
      country,
      sample: rssSignals.slice(0, 3).map(s => ({ headline: s.headline?.slice(0, 100), publisher: s.publisher })),
    };

    return res.status(200).json({
      ok: true,
      interests,
      country,
      news,
      reddit,
      rss,
      total_signals: news.signal_count + reddit.signal_count + rss.signal_count,
      env: {
        BING_API_KEY:        process.env.BING_API_KEY        ? "set" : "missing",
        BRAVE_API_KEY:       process.env.BRAVE_API_KEY       ? "set" : "missing",
        GEMINI_API_KEY:      process.env.GEMINI_API_KEY      ? "set" : "missing",
        GOOGLE_AI_API_KEY:   process.env.GOOGLE_AI_API_KEY   ? "set" : "missing",
        OPENAI_API_KEY:      process.env.OPENAI_API_KEY      ? "set" : "missing",
      },
    });
  } catch (err) {
    console.error("[unf/diag] error:", err);
    return res.status(500).json({ error: err?.message || "internal_error" });
  }
}
