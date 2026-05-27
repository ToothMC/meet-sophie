// api/unfiltered/boundaries.js — User-Präferenzen für Unfiltered.
//
// GET   → liefert die unf_boundaries-Row des Users (oder Defaults wenn leer)
// PATCH → upsert mit partiellem Update
//
// Wird vom Frontend gerufen (Settings-Panel später, Memory-Proposal-Modal
// nutzt no_memory_people / blocked_people / anonymize_names).

import { createClient } from "@supabase/supabase-js";

const DEFAULTS = {
  blocked_people:         [],
  avoid_topics:           [],
  no_memory_people:       [],
  default_retention_days: null,
  anonymize_names:        false,
  interests:              [],
  geo_country:            "DE",
  custom_feeds:           [],
  custom_feeds_meta:      {},
};

function arr(v) {
  if (!Array.isArray(v)) return null;
  return v.map(x => String(x).trim().slice(0, 80)).filter(Boolean).slice(0, 50);
}

// custom_feeds dürfen länger sein (URLs) und behalten ihre Originalcase
function feedArr(v) {
  if (!Array.isArray(v)) return null;
  return v.map(x => String(x).trim().slice(0, 500)).filter(Boolean).slice(0, 25);
}
function intOrNull(v) {
  if (v == null) return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : null;
}
function cleanCountry(v) {
  if (typeof v !== "string") return null;
  const c = v.trim().toUpperCase().slice(0, 2);
  return /^[A-Z]{2}$/.test(c) ? c : null;
}

export default async function handler(req, res) {
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

    if (req.method === "GET") {
      const { data, error } = await supabase
        .from("unf_boundaries")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) {
        console.warn("[unf/boundaries GET] failed:", error.message);
        return res.status(500).json({ error: error.message });
      }
      return res.status(200).json({ boundaries: data || { user_id: user.id, ...DEFAULTS } });
    }

    if (req.method === "PATCH") {
      const body = req.body || {};
      const patch = { user_id: user.id, updated_at: new Date().toISOString() };

      if (body.blocked_people   !== undefined) { const v = arr(body.blocked_people);   if (v) patch.blocked_people   = v; }
      if (body.avoid_topics     !== undefined) { const v = arr(body.avoid_topics);     if (v) patch.avoid_topics     = v; }
      if (body.no_memory_people !== undefined) { const v = arr(body.no_memory_people); if (v) patch.no_memory_people = v; }
      if (body.interests        !== undefined) { const v = arr(body.interests);        if (v) patch.interests        = v; }
      if (body.anonymize_names  !== undefined) patch.anonymize_names = !!body.anonymize_names;
      if (body.default_retention_days !== undefined) patch.default_retention_days = intOrNull(body.default_retention_days);
      if (body.geo_country      !== undefined) { const c = cleanCountry(body.geo_country); if (c) patch.geo_country = c; }

      const { data, error } = await supabase
        .from("unf_boundaries")
        .upsert(patch, { onConflict: "user_id" })
        .select()
        .single();
      if (error) {
        console.warn("[unf/boundaries PATCH] failed:", error.message);
        return res.status(500).json({ error: error.message });
      }
      return res.status(200).json({ boundaries: data });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[unf/boundaries] error:", err);
    return res.status(500).json({ error: err?.message || "internal_error" });
  }
}
