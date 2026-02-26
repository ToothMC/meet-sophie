import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/memory-update
 * Body: {
 *   transcript: Array<{ role: "user"|"assistant", text: string }> | string,
 *   seconds_used?: number
 * }
 */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // ---------- Body robust lesen ----------
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body && typeof body === "object" ? body : {};

    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing Authorization Bearer token" });

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // ---------- User validieren ----------
    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) return res.status(401).json({ error: "Invalid token" });

    const secondsUsed = Number(body.seconds_used ?? 0) || 0;

    // ---------- Transcript normalisieren ----------
    const rawTranscript = body.transcript;
    let transcriptArr = [];

    if (Array.isArray(rawTranscript)) {
      transcriptArr = rawTranscript
        .map((t) => ({
          role: t?.role === "assistant" ? "assistant" : "user",
          text: String(t?.text || "").trim(),
        }))
        .filter((t) => t.text.length > 0);
    } else if (typeof rawTranscript === "string" && rawTranscript.trim()) {
      transcriptArr = [{ role: "user", text: rawTranscript.trim() }];
    }

    const transcriptText = transcriptArr
      .slice(-50)
      .map((t) => `${t.role.toUpperCase()}: ${t.text.slice(0, 2000)}`)
      .join("\n");

    const nowIso = new Date().toISOString();

    // ---------- Base Session ----------
    const baseSession = {
      user_id: user.id,
      session_date: nowIso,
    };

    // Wenn kein Transcript: Session loggen & fertig
    if (!transcriptText || transcriptText.trim().length < 10) {
      const { error } = await supabase.from("user_sessions").insert({
        ...baseSession,
        emotional_tone: "unknown",
        stress_level: null,
        closeness_level: null,
        short_summary: `No transcript captured. duration=${secondsUsed}s`.slice(0, 300),
      });
      if (error) console.error("user_sessions(no_transcript) insert failed:", error.message);
      return res.status(200).json({ ok: true, skipped: true, reason: "No transcript" });
    }

    // ---------- Relationship lesen ----------
    const { data: rel, error: relErr } = await supabase
      .from("user_relationship")
      .select("tone_baseline, openness_level, emotional_patterns, last_interaction_summary")
      .eq("user_id", user.id)
      .maybeSingle();

    if (relErr) console.warn("user_relationship select error:", relErr.message);

    // ---------- Profile lesen (für Merge/Upsert) ----------
    const { data: prof, error: profErr } = await supabase
      .from("user_profile")
      .select("first_name, notes, preferred_language")
      .eq("user_id", user.id)
      .maybeSingle();

    if (profErr) console.warn("user_profile select error:", profErr.message);

    const existingFirstName = String(prof?.first_name || "").trim();
    const existingNotes = String(prof?.notes || "").trim();
    const existingLang = String(prof?.preferred_language || "").trim().toLowerCase();

    const system =
      "You extract and update lightweight user memory for Sophie. " +
      "Be concise and non-creepy. Observations only. No diagnosis. " +
      "If unsure about a profile field, return an empty string.";

    const userMsg = `
CURRENT profile memory:
first_name: ${existingFirstName}
preferred_language: ${existingLang}
notes: ${existingNotes}

CURRENT relationship memory:
tone_baseline: ${rel?.tone_baseline || ""}
openness_level: ${rel?.openness_level || ""}
emotional_patterns: ${rel?.emotional_patterns || ""}
last_interaction_summary: ${rel?.last_interaction_summary || ""}

NEW transcript:
${transcriptText}
`.trim();

    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        profile: {
          type: "object",
          additionalProperties: false,
          properties: {
            first_name: { type: "string" },
            nickname: { type: "string" },
            formality: { type: "string", description: "informal or formal (or empty)" },
            preferred_language: { type: "string", description: "e.g. en,de,it,fr,... or empty" },
          },
          required: ["first_name", "nickname", "formality", "preferred_language"],
        },
        relationship: {
          type: "object",
          additionalProperties: false,
          properties: {
            tone_baseline: { type: "string" },
            openness_level: { type: "string" },
            emotional_patterns: { type: "string" },
            last_interaction_summary: { type: "string" },
          },
          required: ["tone_baseline", "openness_level", "emotional_patterns", "last_interaction_summary"],
        },
        session: {
          type: "object",
          additionalProperties: false,
          properties: {
            emotional_tone: { type: "string" },
            stress_level: { type: "integer", minimum: 0, maximum: 10 },
            closeness_level: { type: "integer", minimum: 0, maximum: 10 },
            short_summary: { type: "string" },
          },
          required: ["emotional_tone", "stress_level", "closeness_level", "short_summary"],
        },
      },
      required: ["profile", "relationship", "session"],
    };

    // ---------- OpenAI Call ----------
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.MEMORY_MODEL || "gpt-4o-mini",
        input: [
          { role: "system", content: system },
          { role: "user", content: userMsg },
        ],
        temperature: 0.2,
        text: {
          format: {
            type: "json_schema",
            name: "sophie_memory_v2",
            strict: true,
            schema,
          },
        },
        truncation: "auto",
      }),
    });

    if (!r.ok) {
      const errorText = await r.text().catch(() => "");
      console.error("OpenAI memory error:", r.status, errorText);

      await supabase.from("user_sessions").insert({
        ...baseSession,
        emotional_tone: "error",
        stress_level: null,
        closeness_level: null,
        short_summary: `Memory model error (HTTP ${r.status}). ${String(errorText).replace(/\s+/g, " ").slice(0, 200)} duration=${secondsUsed}s`.slice(0, 300),
      });

      return res.status(r.status).json({ error: errorText });
    }

    const out = await r.json();

    const text =
      out?.output_text ||
      out?.output?.[0]?.content?.find?.((c) => c.type === "output_text")?.text ||
      "";

    let parsed;
    try {
      parsed = JSON.parse(String(text || "").trim());
    } catch (e) {
      console.error("Bad JSON from memory model:", text);

      await supabase.from("user_sessions").insert({
        ...baseSession,
        emotional_tone: "error",
        stress_level: null,
        closeness_level: null,
        short_summary: `Bad JSON from model. duration=${secondsUsed}s`.slice(0, 300),
      });

      return res.status(200).json({ ok: false, skipped: true, reason: "Bad JSON" });
    }

    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

    const profileOut = parsed.profile || {};
    const relationshipOut = parsed.relationship || {};
    const sessionOut = parsed.session || {};

    const newFirstName = clean(profileOut.first_name);
    const newNickname = clean(profileOut.nickname);
    const newFormality = clean(profileOut.formality);
    const newLang = clean(profileOut.preferred_language).toLowerCase();

    const finalFirstName = newFirstName ? newFirstName.slice(0, 80) : existingFirstName;
    const finalLang = newLang ? newLang.slice(0, 12) : existingLang;

    // Store nickname/formality/lang in notes (no schema changes required)
    const marker = "SOPHIE_PREFS:";
    const prefsLine = `${marker} nickname=${newNickname || ""}; formality=${newFormality || ""}; lang=${finalLang || ""}`.trim();

    let finalNotes = existingNotes;
    if (!finalNotes) {
      finalNotes = prefsLine;
    } else if (finalNotes.includes(marker)) {
      finalNotes = finalNotes
        .split("\n")
        .map((ln) => (ln.includes(marker) ? prefsLine : ln))
        .join("\n")
        .trim();
    } else {
      finalNotes = (finalNotes + "\n" + prefsLine).trim();
    }

    // ---------- user_profile upsert ----------
    // IMPORTANT: If your table does NOT have updated_at, remove it here.
    const profileRow = {
      user_id: user.id,
      first_name: finalFirstName,
      preferred_language: finalLang || null,
      notes: finalNotes.slice(0, 2000),
      updated_at: nowIso,
    };

    const { error: profUpErr } = await supabase
      .from("user_profile")
      .upsert(profileRow, { onConflict: "user_id" });

    if (profUpErr) {
      console.error("user_profile upsert failed:", profUpErr.message, profileRow);

      // Fallback: try update then insert (handles missing unique constraint sometimes)
      const { error: updErr } = await supabase
        .from("user_profile")
        .update({
          first_name: finalFirstName,
          preferred_language: finalLang || null,
          notes: finalNotes.slice(0, 2000),
          updated_at: nowIso,
        })
        .eq("user_id", user.id);

      if (updErr) {
        console.error("user_profile update fallback failed:", updErr.message);

        const { error: insErr } = await supabase
          .from("user_profile")
          .insert(profileRow);

        if (insErr) {
          console.error("user_profile insert fallback failed:", insErr.message);
        }
      }
    }

    // ---------- Relationship merge ----------
    function mergeContinuity(prev, next) {
      prev = clean(prev);
      next = clean(next);
      if (!next) return prev;
      if (prev && prev.includes(next)) return prev;

      let parts = prev ? prev.split(" • ").map(clean).filter(Boolean) : [];
      parts = parts.filter((p) => p !== next);
      parts.unshift(next);
      parts = parts.slice(0, 3);
      return parts.join(" • ").slice(0, 600);
    }

    const newContinuity = mergeContinuity(
      rel?.last_interaction_summary || "",
      relationshipOut.last_interaction_summary || sessionOut.short_summary || ""
    );

    const relRow = {
      user_id: user.id,
      tone_baseline: clean(relationshipOut.tone_baseline || rel?.tone_baseline || "").slice(0, 200),
      openness_level: clean(relationshipOut.openness_level || rel?.openness_level || "").slice(0, 50),
      emotional_patterns: clean(relationshipOut.emotional_patterns || rel?.emotional_patterns || "").slice(0, 500),
      last_interaction_summary: clean(newContinuity || "").slice(0, 600),
      updated_at: nowIso,
    };

    const { error: relUpErr } = await supabase
      .from("user_relationship")
      .upsert(relRow, { onConflict: "user_id" });

    if (relUpErr) {
      console.error("user_relationship upsert failed:", relUpErr.message, relRow);
    }

    // ---------- Session speichern ----------
    const { error: sessErr } = await supabase.from("user_sessions").insert({
      user_id: user.id,
      session_date: nowIso,
      emotional_tone: clean(sessionOut.emotional_tone || "").slice(0, 50) || "unknown",
      stress_level: Number.isFinite(sessionOut.stress_level) ? sessionOut.stress_level : null,
      closeness_level: Number.isFinite(sessionOut.closeness_level) ? sessionOut.closeness_level : null,
      short_summary: clean(sessionOut.short_summary || "").slice(0, 300) || "Session captured.",
    });

    if (sessErr) console.error("user_sessions(success) insert failed:", sessErr.message);

    return res.status(200).json({
      ok: true,
      extracted: {
        first_name: finalFirstName,
        nickname: newNickname,
        formality: newFormality,
        preferred_language: finalLang,
      },
    });
  } catch (err) {
    console.error("memory-update fatal:", err?.message || err, err?.stack || "");
    return res.status(500).json({ error: String(err?.message || err || "Internal server error") });
  }
}
