// api/unfiltered/wipe.js — Löscht alle Unfiltered-Memory des Users.
//
// POST /api/unfiltered/wipe
//   Body: { confirm: "WIPE" }    // expliziter Confirmation-Token gegen Versehen
//
// Cascade: unf_threads → unf_events (FK ON DELETE CASCADE).
// Boundaries bleiben (das sind User-Präferenzen, keine Memory).
// Briefings bleiben (Public-Briefing-Cache, kein User-Material).

import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

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

    const confirm = (req.body || {}).confirm;
    if (confirm !== "WIPE") {
      return res.status(400).json({ error: "confirm token missing (expected 'WIPE')" });
    }

    // Count before, damit das UI dem User sagen kann was weg ist
    const { count: threadCount } = await supabase
      .from("unf_threads")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);

    const { count: eventCount } = await supabase
      .from("unf_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);

    const { error } = await supabase
      .from("unf_threads")
      .delete()
      .eq("user_id", user.id);
    if (error) {
      console.warn("[unf/wipe] delete failed:", error.message);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({
      ok: true,
      deleted_threads: threadCount || 0,
      deleted_events:  eventCount  || 0,
    });
  } catch (err) {
    console.error("[unf/wipe] error:", err);
    return res.status(500).json({ error: err?.message || "internal_error" });
  }
}
