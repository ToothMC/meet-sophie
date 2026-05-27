// api/unfiltered/events.js — Story-Events.
//
// POST /api/unfiltered/events
//   Body: {
//     thread_id?: uuid  // wenn fehlt + title gegeben → neuer Thread wird erzeugt
//     title?:     string
//     people?:    string[]
//     what:       string  // required
//     quote?:     string
//     user_feeling?: string
//     sophie_take?: string
//     next_watch_signal?: string
//     source?:    "voice"|"chat"|"receipts"   default "voice"
//   }
//
// Wird sowohl vom Frontend (Memory-Proposal-Modal) als auch vom save_thread_event
// Tool-Handler in talk/index.html aufgerufen.

import { createClient } from "@supabase/supabase-js";

const ALLOWED_SOURCES = ["voice", "chat", "receipts"];

function s(v, max = 500) { return typeof v === "string" ? v.trim().slice(0, max) : null; }
function arr(v) {
  if (!Array.isArray(v)) return [];
  return v.map(x => String(x).trim().slice(0, 80)).filter(Boolean).slice(0, 20);
}

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

    const body  = req.body || {};
    const what  = s(body.what, 1000);
    if (!what) return res.status(400).json({ error: "what required" });

    const source = ALLOWED_SOURCES.includes(body.source) ? body.source : "voice";

    let threadId = s(body.thread_id, 64);
    let thread   = null;

    // Wenn kein thread_id geliefert wurde, brauchen wir mindestens einen
    // Titel — sonst können wir keinen Thread anlegen, an dem das Event
    // hängen kann. (save_thread_event-Tool liefert das, Memory-Modal liefert
    // immer eine ID weil der Thread vorher angelegt wurde.)
    if (!threadId) {
      const title  = s(body.title, 200);
      const people = arr(body.people);
      if (!title) return res.status(400).json({ error: "thread_id or title required" });

      const { data: createdThread, error: tErr } = await supabase
        .from("unf_threads")
        .insert({
          user_id: user.id,
          title,
          people,
          context:           s(body.context, 200),
          suspected_dynamic: s(body.suspected_dynamic, 200),
        })
        .select()
        .single();
      if (tErr) {
        console.warn("[unf/events] auto-create thread failed:", tErr.message);
        return res.status(500).json({ error: tErr.message });
      }
      thread   = createdThread;
      threadId = createdThread.id;
    } else {
      // Verifizieren dass dieser Thread dem User gehört (RLS deckt das,
      // aber wir wollen einen sauberen 404 statt eines stillen Insert-Fehlers).
      const { data: existing } = await supabase
        .from("unf_threads")
        .select("id, user_id")
        .eq("id", threadId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (!existing) return res.status(404).json({ error: "thread_not_found" });
      thread = existing;
    }

    const insert = {
      thread_id:         threadId,
      user_id:           user.id,
      what,
      quote:             s(body.quote, 1000),
      user_feeling:      s(body.user_feeling, 200),
      sophie_take:       s(body.sophie_take, 1000),
      next_watch_signal: s(body.next_watch_signal, 500),
      source,
    };

    const { data: event, error: eErr } = await supabase
      .from("unf_events")
      .insert(insert)
      .select()
      .single();
    if (eErr) {
      console.warn("[unf/events] insert failed:", eErr.message);
      return res.status(500).json({ error: eErr.message });
    }

    // Thread-last_update bumpen, damit loadRelevantThreads() den Thread
    // nach oben sortiert.
    await supabase
      .from("unf_threads")
      .update({ last_update: new Date().toISOString() })
      .eq("id", threadId)
      .eq("user_id", user.id);

    return res.status(201).json({ event, thread });
  } catch (err) {
    console.error("[unf/events] error:", err);
    return res.status(500).json({ error: err?.message || "internal_error" });
  }
}
