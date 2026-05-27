// api/unfiltered/diag.js — Diagnose-Endpoint für die Daily-Briefing-
// Pipeline. Ruft jeden Crawler einzeln auf und meldet:
//  - wie viele Signale gekommen sind
//  - die ersten paar Headlines pro Quelle
//  - ob der Brave-Key gültig ist (HTTP-Status)
//
// GET /api/unfiltered/diag        — eigene Boundaries werden geladen
// GET /api/unfiltered/diag?interests=royals,reality-tv&country=DE

import { createClient } from "@supabase/supabase-js";
import { fetchRedditGossip }  from "../../lib/unfiltered/crawlers/reddit.js";
import { fetchRSSBoulevard }  from "../../lib/unfiltered/crawlers/rss-boulevard.js";
import { loadBoundaries }     from "../../lib/unfiltered/memory.js";

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

    // ─── 1. Brave: direkter Ping mit Header-Status ───────────────────────
    const braveKey = (process.env.BING_API_KEY || process.env.BRAVE_API_KEY || "").trim();
    let brave = { key_present: !!braveKey, hits: 0, status: null, sample: [], error: null };
    if (braveKey) {
      try {
        const r = await fetch(
          `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(`royal family news ${country} today`)}&count=3`,
          { headers: { "Accept": "application/json", "X-Subscription-Token": braveKey }, signal: AbortSignal.timeout(5000) }
        );
        brave.status = r.status;
        if (r.ok) {
          const j = await r.json();
          const items = Array.isArray(j?.web?.results) ? j.web.results : [];
          brave.hits = items.length;
          brave.sample = items.slice(0, 3).map(it => ({ title: it.title, url: it.url, host: (() => { try { return new URL(it.url).hostname; } catch { return ""; } })() }));
        } else {
          const t = await r.text().catch(() => "");
          brave.error = t.slice(0, 200);
        }
      } catch (e) { brave.error = e?.message || String(e); }
    }

    // ─── 2. Reddit: erster Sub, header-check ─────────────────────────────
    const redditSignals = await fetchRedditGossip({ interests });
    const reddit = {
      signal_count: redditSignals.length,
      subs_tried: interests,
      sample: redditSignals.slice(0, 3).map(s => ({ headline: s.headline, publisher: s.publisher, score: s.score })),
    };

    // ─── 3. RSS: erster Feed, header-check ───────────────────────────────
    const rssSignals = await fetchRSSBoulevard({ country });
    const rss = {
      signal_count: rssSignals.length,
      country,
      sample: rssSignals.slice(0, 3).map(s => ({ headline: s.headline, publisher: s.publisher })),
    };

    return res.status(200).json({
      ok: true,
      interests,
      country,
      brave,
      reddit,
      rss,
      total_signals: (brave.hits || 0) + reddit.signal_count + rss.signal_count,
      env: {
        BING_API_KEY:  process.env.BING_API_KEY  ? "set" : "missing",
        BRAVE_API_KEY: process.env.BRAVE_API_KEY ? "set" : "missing",
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ? "set" : "missing",
      },
    });
  } catch (err) {
    console.error("[unf/diag] error:", err);
    return res.status(500).json({ error: err?.message || "internal_error" });
  }
}
