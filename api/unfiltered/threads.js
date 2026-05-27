// api/unfiltered/threads.js — Story-Threads CRUD.
//
// GET    /api/unfiltered/threads                → liste Threads des Users
//        ?include_events=1                       (optional: nested events inline)
//        ?status=open|paused|resolved|archived   (optional filter)
// POST   /api/unfiltered/threads                → neuer Thread
// PATCH  /api/unfiltered/threads                → update {id, ...fields}
// DELETE /api/unfiltered/threads?id=<uuid>      → hard-delete (cascade auf events)
//
// Auth: Bearer Supabase JWT. RLS in der DB verhindert Cross-User-Zugriff
// (wir nutzen den Service-Role-Client, daher zusätzlich user_id-Filter
// in jedem Statement als Defense-in-Depth).

import { createClient } from "@supabase/supabase-js";

const ALLOWED_STATUS      = ["open", "paused", "resolved", "archived"];
const ALLOWED_CONFIDENCE  = ["low", "medium", "high"];
const ALLOWED_SENSITIVITY = ["normal", "sensitive"];

function clean(v) { return typeof v === "string" ? v.trim().slice(0, 500) : null; }
function cleanArr(v) {
  if (!Array.isArray(v)) return null;
  return v.map(x => String(x).trim().slice(0, 80)).filter(Boolean).slice(0, 20);
}
function scoreOrNull(v) {
  if (v == null) return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(10, n));
}
function intOrNull(v) {
  if (v == null) return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : null;
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

    // ── GET — list ────────────────────────────────────────────────────────
    if (req.method === "GET") {
      const status = req.query?.status;
      const includeEvents = req.query?.include_events === "1";

      let q = supabase
        .from("unf_threads")
        .select(includeEvents ? "*, unf_events(*)" : "*")
        .eq("user_id", user.id)
        .order("last_update", { ascending: false })
        .limit(50);

      if (status && ALLOWED_STATUS.includes(status)) q = q.eq("status", status);

      const { data, error } = await q;
      if (error) {
        console.warn("[unf/threads GET] failed:", error.message);
        return res.status(500).json({ error: error.message });
      }
      return res.status(200).json({ threads: data || [] });
    }

    // ── POST — create ─────────────────────────────────────────────────────
    if (req.method === "POST") {
      const body = req.body || {};
      const title = clean(body.title);
      if (!title) return res.status(400).json({ error: "title required" });

      const insert = {
        user_id:           user.id,
        title,
        people:            cleanArr(body.people) || [],
        context:           clean(body.context),
        suspected_dynamic: clean(body.suspected_dynamic),
        sensitivity:       ALLOWED_SENSITIVITY.includes(body.sensitivity) ? body.sensitivity : "normal",
        confidence:        ALLOWED_CONFIDENCE.includes(body.confidence)   ? body.confidence  : "medium",
        story_score:       scoreOrNull(body.story_score),
        evidence_score:    scoreOrNull(body.evidence_score),
        retention_days:    intOrNull(body.retention_days),
        // status default 'open' via DB constraint
      };

      const { data, error } = await supabase
        .from("unf_threads")
        .insert(insert)
        .select()
        .single();
      if (error) {
        console.warn("[unf/threads POST] failed:", error.message);
        return res.status(500).json({ error: error.message });
      }
      return res.status(201).json({ thread: data });
    }

    // ── PATCH — update ────────────────────────────────────────────────────
    if (req.method === "PATCH") {
      const body = req.body || {};
      const id = clean(body.id);
      if (!id) return res.status(400).json({ error: "id required" });

      const patch = { last_update: new Date().toISOString() };

      if (body.title          !== undefined) patch.title          = clean(body.title);
      if (body.people         !== undefined) patch.people         = cleanArr(body.people) || [];
      if (body.context        !== undefined) patch.context        = clean(body.context);
      if (body.suspected_dynamic !== undefined) patch.suspected_dynamic = clean(body.suspected_dynamic);
      if (body.status         !== undefined && ALLOWED_STATUS.includes(body.status)) patch.status = body.status;
      if (body.confidence     !== undefined && ALLOWED_CONFIDENCE.includes(body.confidence)) patch.confidence = body.confidence;
      if (body.sensitivity    !== undefined && ALLOWED_SENSITIVITY.includes(body.sensitivity)) patch.sensitivity = body.sensitivity;
      if (body.story_score    !== undefined) patch.story_score    = scoreOrNull(body.story_score);
      if (body.evidence_score !== undefined) patch.evidence_score = scoreOrNull(body.evidence_score);
      if (body.retention_days !== undefined) patch.retention_days = intOrNull(body.retention_days);

      const { data, error } = await supabase
        .from("unf_threads")
        .update(patch)
        .eq("id", id)
        .eq("user_id", user.id) // defense-in-depth, RLS deckt das schon
        .select()
        .maybeSingle();
      if (error) {
        console.warn("[unf/threads PATCH] failed:", error.message);
        return res.status(500).json({ error: error.message });
      }
      if (!data) return res.status(404).json({ error: "not_found" });
      return res.status(200).json({ thread: data });
    }

    // ── DELETE ────────────────────────────────────────────────────────────
    if (req.method === "DELETE") {
      const id = clean(req.query?.id);
      if (!id) return res.status(400).json({ error: "id required" });
      const { error } = await supabase
        .from("unf_threads")
        .delete()
        .eq("id", id)
        .eq("user_id", user.id);
      if (error) {
        console.warn("[unf/threads DELETE] failed:", error.message);
        return res.status(500).json({ error: error.message });
      }
      return res.status(204).end();
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[unf/threads] error:", err);
    return res.status(500).json({ error: err?.message || "internal_error" });
  }
}
