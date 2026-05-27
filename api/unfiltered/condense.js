// api/unfiltered/condense.js — Extrahiert nach einer Voice-Session,
// in der der Unfiltered-Substate aktiv war, Vorschläge für neue
// Story-Threads, Updates an bestehenden Threads, und Resolutions.
//
// Liefert NUR Vorschläge (dry-run) — das Frontend zeigt sie im Memory-
// Proposal-Modal, der User wählt (Merken / Nur heute / Vergessen /
// Anonymisieren), und das Frontend ruft danach explizit
// /api/unfiltered/threads (POST/PATCH) und /api/unfiltered/events (POST).
//
// Body:
//   { session_id: string, transcript: string, language?: "de"|"en" }
//
// Response:
//   {
//     new_threads: [{title, people[], context?, suspected_dynamic?, sophie_take, first_event}],
//     updates:     [{thread_id, what, sophie_take, next_watch_signal?}],
//     resolutions: [{thread_id, why}],
//     skipped_sensitive: number    // wieviele extracted items wurden wegen
//                                  // sensitivity gefiltert
//   }

import { createClient } from "@supabase/supabase-js";

const EXTRACTION_MODEL = "gpt-4o-mini";

function buildExtractionPrompt(transcript, activeThreads, language) {
  const isEN = language === "en";
  const threadList = activeThreads.length
    ? activeThreads.map(t =>
        `- id=${t.id} | "${t.title}" | people: ${(t.people || []).join(", ") || "—"} | suspected: ${t.suspected_dynamic || "—"} | status: ${t.status}`
      ).join("\n")
    : "(none)";

  const de = `Du extrahierst aus dem folgenden Voice-Gespräch zwischen User und Sophie (Unfiltered-Substate) drei Listen:

1. NEW_THREADS — Story-Threads, die der User in diesem Gespräch NEU aufgemacht hat
   (Personen aus seinem Umfeld + Verdachtsmoment + Kontext).
2. UPDATES — Neue Events / Beobachtungen, die zu einem der unten gelisteten BESTEHENDEN Threads passen.
3. RESOLUTIONS — Threads, die der User explizit abgeschlossen oder geklärt hat.

REGELN
- Nur tatsächlich genannte Personen aus dem User-Umfeld. KEINE Promis. KEINE Minderjährige.
- KEINE Threads über Krankheit/Schwangerschaft/Outing/Straftat realer Personen — auch wenn der User darüber spekuliert. Markiere solche Stellen NICHT als Thread.
- Wenn unsicher → weglassen.
- thread_id in UPDATES und RESOLUTIONS muss exakt einer der id-Werte unten sein.
- Schreibe sophie_take in DEUTSCH, freche Lesart in einem Satz.
- Halte alles knapp: max 3 NEW_THREADS, max 5 UPDATES, max 3 RESOLUTIONS pro Session.

BESTEHENDE THREADS DIESES USERS
${threadList}

GESPRÄCH (User + Sophie, abwechselnd)
${transcript}

Liefere JSON in diesem Schema:
{
  "new_threads": [
    {
      "title": "string (kurz, z.B. 'Lisa wirkt komisch bei Anna-Themen')",
      "people": ["Lisa", "Anna"],
      "context": "Freundeskreis|Familie|Arbeit|Nachbarschaft|Verein|sonstiges",
      "suspected_dynamic": "Eifersucht|Konkurrenz|Affäre-Verdacht|passive Aggression|Manipulation|Unsicherheit|...",
      "sophie_take": "deine ehrliche Lesart in einem Satz",
      "first_event": { "what": "was ist passiert", "quote": null, "user_feeling": "genervt|verunsichert|...", "next_watch_signal": null }
    }
  ],
  "updates": [
    { "thread_id": "uuid aus der Liste oben", "what": "neue Beobachtung", "sophie_take": "neue Lesart in einem Satz", "next_watch_signal": "worauf der User als nächstes achten soll" }
  ],
  "resolutions": [
    { "thread_id": "uuid aus der Liste oben", "why": "warum jetzt erledigt" }
  ],
  "skipped_sensitive": 0
}

Wenn nichts zu extrahieren ist, liefere alle drei Listen als []. NIE Felder erfinden.`;

  const en = `Extract from the following voice conversation between user and Sophie (Unfiltered substate) three lists:

1. NEW_THREADS — story threads the user NEWLY opened in this conversation
   (people from their circle + suspected dynamic + context).
2. UPDATES — new events / observations that fit one of the EXISTING threads listed below.
3. RESOLUTIONS — threads the user explicitly closed or clarified.

RULES
- Only actually mentioned people from the user's circle. NO celebrities. NO minors.
- NO threads about illness / pregnancy / outing / crime of real people — even if the user speculates. Do NOT capture such moments.
- When in doubt → skip.
- thread_id in UPDATES and RESOLUTIONS must be one of the id values listed below.
- Write sophie_take in ENGLISH, cheeky one-sentence read.
- Keep it short: max 3 NEW_THREADS, max 5 UPDATES, max 3 RESOLUTIONS per session.

EXISTING THREADS FOR THIS USER
${threadList}

CONVERSATION (user + Sophie, alternating)
${transcript}

Return JSON in this schema:
{
  "new_threads": [
    {
      "title": "string (short, e.g. 'Lisa acts weird on Anna topics')",
      "people": ["Lisa", "Anna"],
      "context": "friends|family|work|neighborhood|club|other",
      "suspected_dynamic": "jealousy|competition|suspected affair|passive aggression|manipulation|insecurity|...",
      "sophie_take": "your honest one-sentence read",
      "first_event": { "what": "what happened", "quote": null, "user_feeling": "annoyed|insecure|...", "next_watch_signal": null }
    }
  ],
  "updates": [
    { "thread_id": "uuid from the list above", "what": "new observation", "sophie_take": "new read in one sentence", "next_watch_signal": "what user should watch next" }
  ],
  "resolutions": [
    { "thread_id": "uuid from the list above", "why": "why resolved now" }
  ],
  "skipped_sensitive": 0
}

If nothing to extract, return all three as []. NEVER invent fields.`;

  return isEN ? en : de;
}

function trimTranscript(t, max = 12000) {
  if (typeof t !== "string") return "";
  const cleaned = t.replace(/\s+\n/g, "\n").trim();
  if (cleaned.length <= max) return cleaned;
  // Tail behalten — späteres ist meist relevanter für Resolutions
  return "[…earlier content trimmed…]\n" + cleaned.slice(-max);
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
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: "Invalid token" });

    const { session_id, transcript, language = "de" } = req.body || {};
    if (!session_id || typeof session_id !== "string") {
      return res.status(400).json({ error: "session_id required" });
    }
    if (!transcript || typeof transcript !== "string" || transcript.length < 20) {
      return res.status(400).json({ error: "transcript required (min 20 chars)" });
    }
    const lang = language === "en" ? "en" : "de";

    // Bestehende Threads laden — für Update/Resolution-Zuordnung
    const { data: activeThreads } = await supabase
      .from("unf_threads")
      .select("id, title, people, suspected_dynamic, status")
      .eq("user_id", user.id)
      .in("status", ["open", "paused"])
      .order("last_update", { ascending: false })
      .limit(20);

    const trimmed = trimTranscript(transcript);
    const promptText = buildExtractionPrompt(trimmed, activeThreads || [], lang);

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EXTRACTION_MODEL,
        response_format: { type: "json_object" },
        temperature: 0.2,
        messages: [
          { role: "system", content: "You are an extraction engine. Output only valid JSON matching the schema. Never invent. Never include sensitive claims about real people." },
          { role: "user", content: promptText },
        ],
      }),
    });

    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.warn("[unf/condense] LLM failed:", r.status, text.slice(0, 200));
      return res.status(502).json({ error: "extraction_failed" });
    }

    const j = await r.json();
    let parsed;
    try {
      parsed = JSON.parse(j.choices?.[0]?.message?.content || "{}");
    } catch (e) {
      console.warn("[unf/condense] JSON parse failed:", e.message);
      return res.status(502).json({ error: "extraction_invalid_json" });
    }

    // Sanity-Cleanup — niemals fremde thread_ids durchlassen
    const validIds = new Set((activeThreads || []).map(t => t.id));
    const updates = Array.isArray(parsed.updates) ? parsed.updates.filter(u => validIds.has(u.thread_id)) : [];
    const resolutions = Array.isArray(parsed.resolutions) ? parsed.resolutions.filter(u => validIds.has(u.thread_id)) : [];
    const new_threads = Array.isArray(parsed.new_threads) ? parsed.new_threads.slice(0, 3) : [];

    // ?apply=1 → direkt in DB schreiben (Auto-Save-Pfad, von stopVoice
    // aufgerufen). Ohne den Param: nur Vorschläge zurückgeben (dry-run,
    // z.B. für interne Tools oder spätere Settings-Vorschau).
    const apply = req.query?.apply === "1";
    let saved_new_threads = 0;
    let saved_events      = 0;
    let saved_resolutions = 0;

    if (apply) {
      // Neue Threads + initial event jeweils anlegen
      for (const nt of new_threads) {
        if (!nt?.title) continue;
        try {
          const { data: created, error: tErr } = await supabase
            .from("unf_threads")
            .insert({
              user_id:           user.id,
              title:             String(nt.title).slice(0, 500),
              people:            Array.isArray(nt.people) ? nt.people.slice(0, 20).map(p => String(p).slice(0, 80)) : [],
              context:           nt.context ? String(nt.context).slice(0, 500) : null,
              suspected_dynamic: nt.suspected_dynamic ? String(nt.suspected_dynamic).slice(0, 500) : null,
            })
            .select("id")
            .single();
          if (tErr || !created?.id) {
            console.warn("[unf/condense apply] new thread insert failed:", tErr?.message);
            continue;
          }
          saved_new_threads++;

          const fe = nt.first_event || {};
          if (fe.what) {
            await supabase.from("unf_events").insert({
              thread_id:         created.id,
              user_id:           user.id,
              what:              String(fe.what).slice(0, 1000),
              quote:             fe.quote ? String(fe.quote).slice(0, 1000) : null,
              user_feeling:      fe.user_feeling ? String(fe.user_feeling).slice(0, 200) : null,
              sophie_take:       nt.sophie_take ? String(nt.sophie_take).slice(0, 1000) : null,
              next_watch_signal: fe.next_watch_signal ? String(fe.next_watch_signal).slice(0, 500) : null,
              source:            "voice",
            });
            saved_events++;
          }
        } catch (err) {
          console.warn("[unf/condense apply] new thread loop threw:", err?.message);
        }
      }

      // Updates → Event an bestehenden Thread + last_update bump
      for (const up of updates) {
        if (!up?.what || !up?.thread_id) continue;
        try {
          const { error: eErr } = await supabase.from("unf_events").insert({
            thread_id:         up.thread_id,
            user_id:           user.id,
            what:              String(up.what).slice(0, 1000),
            sophie_take:       up.sophie_take ? String(up.sophie_take).slice(0, 1000) : null,
            next_watch_signal: up.next_watch_signal ? String(up.next_watch_signal).slice(0, 500) : null,
            source:            "voice",
          });
          if (!eErr) {
            saved_events++;
            await supabase
              .from("unf_threads")
              .update({ last_update: new Date().toISOString() })
              .eq("id", up.thread_id)
              .eq("user_id", user.id);
          }
        } catch (err) {
          console.warn("[unf/condense apply] update loop threw:", err?.message);
        }
      }

      // Resolutions → status='resolved'
      for (const re of resolutions) {
        if (!re?.thread_id) continue;
        try {
          await supabase
            .from("unf_threads")
            .update({ status: "resolved", last_update: new Date().toISOString() })
            .eq("id", re.thread_id)
            .eq("user_id", user.id);
          saved_resolutions++;
        } catch (err) {
          console.warn("[unf/condense apply] resolution loop threw:", err?.message);
        }
      }
    }

    return res.status(200).json({
      new_threads,
      updates,
      resolutions,
      skipped_sensitive: Number(parsed.skipped_sensitive) || 0,
      applied: apply,
      saved_new_threads,
      saved_events,
      saved_resolutions,
      model: EXTRACTION_MODEL,
    });
  } catch (err) {
    console.error("[unf/condense] error:", err);
    return res.status(500).json({ error: err?.message || "internal_error" });
  }
}
