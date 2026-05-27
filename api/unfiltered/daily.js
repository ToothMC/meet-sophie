// api/unfiltered/daily.js — Tägliches Briefing.
//
// GET  /api/unfiltered/daily               → liefert das heutige Briefing.
//      ?refresh=1                            (optional: Cache ignorieren, neu crawlen)
//      ?language=de|en                       (optional: überschreibt Boundaries)
//
// Cache-Strategie: 1 Briefing pro (user_id, date, language). Cache-Hit
// liefert direkt aus unf_briefings. Miss → runCrawlers → synthesize →
// upsert.
//
// Rate-Limit (cost protection): max 6 frische Synth-Calls pro User pro
// Stunde — sonst zwangsweise gecached.

import { createClient } from "@supabase/supabase-js";
import { runCrawlers }      from "../../lib/unfiltered/crawlers/index.js";
import { synthesizeBriefing } from "../../lib/unfiltered/synthesizer.js";
import { loadBoundaries }   from "../../lib/unfiltered/memory.js";

const FRESH_RATE_LIMIT = 6;             // max refreshes/hour/user
const RATE_WINDOW_MS   = 60 * 60 * 1000;

// in-memory rate window (best effort; serverless: per cold-start)
const _rateLog = new Map();   // user_id -> [timestamp, …]

function rateAllow(userId) {
  const now = Date.now();
  const arr = (_rateLog.get(userId) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (arr.length >= FRESH_RATE_LIMIT) {
    _rateLog.set(userId, arr);
    return false;
  }
  arr.push(now);
  _rateLog.set(userId, arr);
  return true;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing Authorization Bearer token" });
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "Missing env vars" });
    }
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: "Invalid token" });

    const today    = new Date().toISOString().slice(0, 10);
    const wantsFresh = req.query?.refresh === "1";
    const reqLang  = req.query?.language;
    const language = reqLang === "en" ? "en" : reqLang === "de" ? "de" : null;

    // Boundaries laden — bestimmt Interests + Country + Avoid-Topics
    const boundaries = await loadBoundaries(supabase, user.id);
    const interests  = Array.isArray(boundaries?.interests) && boundaries.interests.length
      ? boundaries.interests
      : ["royals", "reality-tv", "celebs"];
    const country    = boundaries?.geo_country || "DE";
    const avoid      = Array.isArray(boundaries?.avoid_topics) ? boundaries.avoid_topics : [];
    const lang       = language || (country === "GB" || country === "US" ? "en" : "de");

    // Cache lookup
    if (!wantsFresh) {
      const { data: cached } = await supabase
        .from("unf_briefings")
        .select("stories, source_count, generated_at")
        .eq("user_id", user.id)
        .eq("briefing_date", today)
        .eq("language", lang)
        .maybeSingle();
      if (cached) {
        return res.status(200).json({
          stories:      cached.stories || [],
          source_count: cached.source_count || 0,
          generated_at: cached.generated_at,
          language:     lang,
          cached:       true,
        });
      }
    }

    // Rate-limit auf frische Synth-Calls
    if (!rateAllow(user.id)) {
      return res.status(429).json({ error: "rate_limited", retry_after_minutes: 10 });
    }

    // Frischer Lauf: crawl + synth
    const rawSignals = await runCrawlers({ interests, country, avoid_topics: avoid });
    const stories    = await synthesizeBriefing(rawSignals, { language: lang, max_stories: 5 });

    // Wenn aus dünnen/leeren Quellen nichts gekommen ist, NICHT im Cache
    // speichern — sonst bleibt der Müll bis Mitternacht stehen und
    // blockiert spätere Versuche. Ehrlich an Sophie melden.
    if (!Array.isArray(stories) || stories.length === 0) {
      console.warn(`[unf/daily] no grounded stories (signals=${rawSignals.length}) — returning empty, NOT caching`);
      return res.status(200).json({
        stories: [],
        source_count: rawSignals.length,
        generated_at: new Date().toISOString(),
        language: lang,
        cached: false,
        empty_reason: rawSignals.length === 0
          ? "no_signals_from_crawlers"
          : "no_groundable_stories",
      });
    }

    // Cache schreiben (upsert auf unique user_id+briefing_date+language)
    try {
      await supabase.from("unf_briefings").upsert({
        user_id:        user.id,
        briefing_date:  today,
        language:       lang,
        stories,
        source_count:   rawSignals.length,
        generated_at:   new Date().toISOString(),
      }, { onConflict: "user_id,briefing_date,language" });
    } catch (err) {
      console.warn("[unf/daily] cache upsert failed:", err?.message || err);
    }

    return res.status(200).json({
      stories,
      source_count: rawSignals.length,
      generated_at: new Date().toISOString(),
      language:     lang,
      cached:       false,
    });
  } catch (err) {
    console.error("[unf/daily] error:", err);
    return res.status(500).json({ error: err?.message || "internal_error" });
  }
}
