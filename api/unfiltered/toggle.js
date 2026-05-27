// api/unfiltered/toggle.js — Schaltet den Unfiltered-Substate im
// laufenden Talk-Modus an/aus. Liefert dem Frontend das Overlay
// (Persona-Erweiterung) + die zusätzlichen Realtime-Tools zurück;
// das Frontend baut daraus eine session.update und schickt sie über
// den bestehenden DataChannel an die Realtime-Session.
//
// Request:
//   POST /api/unfiltered/toggle
//   Authorization: Bearer <supabase jwt>
//   Body: { session_id: string, active: boolean, source?: "manual"|"voice" }
//
// Response (active=true):
//   { active: true, overlay: "<string>", tools: [...], language: "de" }
//
// Response (active=false):
//   { active: false, overlay: null, tools: [], language: "de" }
//
// Das Frontend mergt instructions/tools clientseitig mit den initial-
// instructions/tools aus dem /api/session Response (siehe api/session.js
// Patch in derselben PR-Branch).

import { createClient } from "@supabase/supabase-js";
import { buildUnfilteredOverlay } from "../../lib/unfiltered/persona.js";
import { loadRelevantThreads, loadBoundaries, loadTodaysBriefing } from "../../lib/unfiltered/memory.js";
import { getUnfilteredTools } from "../../lib/unfiltered/tools.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

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

    const { session_id, active, source = "manual", include_briefing = false } = req.body || {};
    if (typeof active !== "boolean") {
      return res.status(400).json({ error: "active (boolean) required" });
    }
    if (!session_id || typeof session_id !== "string") {
      return res.status(400).json({ error: "session_id (string) required" });
    }

    // Sprache: aus chat_sessions ableiten, fallback "de"
    let language = "de";
    try {
      const { data: cs } = await supabase
        .from("chat_sessions")
        .select("language")
        .eq("id", session_id)
        .eq("user_id", user.id)
        .maybeSingle();
      if (cs?.language) language = cs.language === "en" ? "en" : "de";
    } catch (_) {
      // egal, fallback gilt
    }

    // user_sessions.unfiltered_active aktualisieren (best-effort).
    // user_sessions wird ggf. erst beim memory-update am Session-Ende
    // angelegt — wir machen daher einen upsert, der die Spalte explizit
    // setzt und keinen FK auf chat_sessions verlangt.
    try {
      await supabase.from("user_sessions").upsert({
        id: session_id,
        user_id: user.id,
        session_date: new Date().toISOString(),
        session_type: "voice",
        unfiltered_active: active,
      }, { onConflict: "id" });
    } catch (err) {
      // Wenn die Spalte noch nicht existiert (Migration nicht applied),
      // soll der Endpoint nicht crashen — Overlay-Auslieferung ist wichtiger
      // als das Persistenz-Flag.
      console.warn("[unfiltered/toggle] user_sessions upsert failed:", err.message);
    }

    if (!active) {
      return res.status(200).json({
        active: false,
        overlay: null,
        tools: [],
        language,
      });
    }

    // active === true: Overlay + Tools zusammenbauen
    const [{ threads, events }, boundaries] = await Promise.all([
      loadRelevantThreads(supabase, user.id, { limit_threads: 5, limit_events: 10 }),
      loadBoundaries(supabase, user.id),
    ]);

    let publicStories = [];
    if (include_briefing) {
      publicStories = await loadTodaysBriefing(supabase, user.id, language);
    }

    const overlay = buildUnfilteredOverlay({
      activeThreads: threads,
      recentEvents:  events,
      publicStories,
      boundaries,
      language,
    });

    return res.status(200).json({
      active: true,
      overlay,
      tools: getUnfilteredTools(),
      language,
      source,
      thread_count: threads.length,
      event_count:  events.length,
    });
  } catch (err) {
    console.error("[unfiltered/toggle] error:", err);
    return res.status(500).json({ error: err?.message || "internal_error" });
  }
}
