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
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing Authorization Bearer token" });

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) return res.status(401).json({ error: "Invalid token" });

    const secondsUsed = Number(req.body?.seconds_used ?? 0) || 0;

    // -----------------------------
    // Transcript normalisieren
    // -----------------------------
    const rawTranscript = req.body?.transcript;

    /** @type {Array<{role:"user"|"assistant", text:string}>} */
    let transcriptArr = [];

    if (Array.isArray(rawTranscript)) {
      transcriptArr = rawTranscript
        .map((t) => ({
          role: t?.role === "assistant" ? "assistant" : "user",
          text: String(t?.text || "").trim(),
        }))
        .filter((t) => t.text.length > 0);
    } else if (typeof rawTranscript === "string") {
      const s = rawTranscript.trim();
      if (s) transcriptArr = [{ role: "user", text: s }];
    }

    // für OpenAI: als Textblock
    const transcriptText = transcriptArr
      .slice(-30)
      .map((t) => `${t.role.toUpperCase()}: ${t.text.slice(0, 2000)}`)
      .join("\n");

    // -----------------------------
    // Language preference (persisted)
    // -----------------------------
    function detectPreferredLanguageExplicit(transcriptArr) {
      const t = (transcriptArr || [])
        .filter((x) => x && x.role === "user")
        .map((x) => String(x.text || "").toLowerCase())
        .join("\n");

      const wantsGerman =
        /\b(bitte\s+deutsch|auf\s+deutsch|nur\s+deutsch|deutsch\s+bitte|sprich\s+deutsch)\b/.test(t) ||
        /\b(please\s+in\s+german|in\s+german\s+please|speak\s+german)\b/.test(t);

      const wantsEnglish =
        /\b(bitte\s+englisch|auf\s+englisch|nur\s+englisch|englisch\s+bitte|sprich\s+englisch)\b/.test(t) ||
        /\b(please\s+in\s+english|in\s+english\s+please|speak\s+english)\b/.test(t);

      const wantsSpanish =
        /\b(bitte\s+spanisch|auf\s+spanisch|nur\s+spanisch|spanisch\s+bitte|sprich\s+spanisch)\b/.test(t) ||
        /\b(please\s+in\s+spanish|in\s+spanish\s+please|speak\s+spanish)\b/.test(t) ||
        /\b(en\s+español|por\s+favor\s+en\s+español|habla\s+español)\b/.test(t);

      const count = [wantsGerman, wantsEnglish, wantsSpanish].filter(Boolean).length;
      if (count !== 1) return null;

      if (wantsGerman) return "de";
      if (wantsEnglish) return "en";
      if (wantsSpanish) return "es";
      return null;
    }

    function autoDetectLanguageFromLastUserText(transcriptArr) {
      const lastUser = [...(transcriptArr || [])]
        .reverse()
        .find((x) => x?.role === "user" && typeof x?.text === "string" && x.text.trim().length > 0);

      const txt = String(lastUser?.text || "").toLowerCase();
      if (!txt) return null;

      const hasGermanChars = /[äöüß]/.test(txt);
      const hasSpanishChars = /[ñáéíóú¿¡]/.test(txt);

      const germanWords = /\b(und|aber|doch|nicht|ich|du|wir|bitte|heute|genau|kannst|möchte)\b/.test(txt);
      const spanishWords = /\b(hola|gracias|por favor|buenas|sí|no|yo|tú|nosotros|vale|claro)\b/.test(txt);
      const englishWords = /\b(the|and|but|not|please|today|i|you|we|yeah|okay|really)\b/.test(txt);

      const germanScore = (hasGermanChars ? 2 : 0) + (germanWords ? 1 : 0);
      const spanishScore = (hasSpanishChars ? 2 : 0) + (spanishWords ? 1 : 0);
      const englishScore = englishWords ? 1 : 0;

      const max = Math.max(germanScore, spanishScore, englishScore);
      if (max === 0) return null;

      const winners = [
        germanScore === max ? "de" : null,
        spanishScore === max ? "es" : null,
        englishScore === max ? "en" : null,
      ].filter(Boolean);

      if (winners.length !== 1) return null;
      return winners[0];
    }

    let finalLang = detectPreferredLanguageExplicit(transcriptArr);
    if (!finalLang && transcriptArr.length >= 2) {
      finalLang = autoDetectLanguageFromLastUserText(transcriptArr);
    }

    if (finalLang) {
      const { error: langErr } = await supabase
        .from("user_profile")
        .update({ preferred_language: finalLang })
        .eq("user_id", user.id);

      if (langErr) console.warn("preferred_language update failed:", langErr.message);
    }

    // -----------------------------
    // Always: log a user session row (Fallback)
    // -----------------------------
    const baseSession = {
      user_id: user.id,
      emotional_tone: null,
      stress_level: null,
      closeness_level: null,
      short_summary: null,
      // falls die Spalte existiert, sonst entfernen:
      duration_seconds: secondsUsed,
    };

    // Wenn kein Transcript: Session nur loggen, aber nicht crashen
    if (!transcriptText || transcriptText.trim().length < 10) {
      await supabase.from("user_sessions").insert({
        ...baseSession,
        emotional_tone: "unknown",
        short_summary: `No transcript captured. duration=${secondsUsed}s`,
      });

      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: "No transcript (session logged)",
        preferred_language_set: finalLang || null,
      });
    }

    // -----------------------------
    // Relationship memory update
    // -----------------------------
    const { data: rel, error: relErr } = await supabase
      .from("user_relationship")
      .select("tone_baseline, openness_level, emotional_patterns, last_interaction_summary")
      .eq("user_id", user.id)
      .maybeSingle();
    if (relErr) return res.status(500).json({ error: relErr.message });

    const system = `
You update emotional relationship memory for "Sophie" (quiet feminine evening presence).
Be concise and non-creepy. Observations only. No diagnosis.
`;

    const userMsg = `
CURRENT relationship memory:
tone_baseline: ${rel?.tone_baseline || ""}
openness_level: ${rel?.openness_level || ""}
emotional_patterns: ${rel?.emotional_patterns || ""}
last_interaction_summary: ${rel?.last_interaction_summary || ""}

NEW transcript:
${transcriptText}
`.trim();

    // ✅ Structured Outputs Schema (strict)
    const schema = {
      name: "sophie_relationship_memory_v1",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
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
        required: ["relationship", "session"],
      },
    };

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
        // ✅ Responses API: JSON/Schema via text.format (nicht response_format)
        text: {
          format: { type: "json_schema", json_schema: schema },
        },
      }),
    });

    if (!r.ok) {
      const errorText = await r.text().catch(() => "");
      const brief = String(errorText || "").replace(/\s+/g, " ").slice(0, 180);

      await supabase.from("user_sessions").insert({
        ...baseSession,
        short_summary: `Memory model error (HTTP ${r.status}). ${brief} duration=${secondsUsed}s`,
      });

      return res.status(r.status).json({ error: errorText });
    }

    const out = await r.json();

    // Responses API liefert häufig output_text als Helper (aber wir bleiben robust)
    const text =
      out?.output_text ||
      out?.output?.[0]?.content?.find?.((c) => c.type === "output_text")?.text ||
      "";

    let parsed = null;
    try {
      parsed = JSON.parse(String(text || "").trim());
    } catch (e) {
      await supabase.from("user_sessions").insert({
        ...baseSession,
        short_summary: `Bad JSON from model. duration=${secondsUsed}s`,
      });

      return res.status(200).json({
        ok: false,
        skipped: true,
        reason: "Bad JSON from model",
        raw: String(text || "").slice(0, 500),
        preferred_language_set: finalLang || null,
      });
    }

    const relationship = parsed?.relationship || {};
    const sessionOut = parsed?.session || {};

    const updateRel = {
      tone_baseline: String(relationship.tone_baseline || rel?.tone_baseline || "").slice(0, 200),
      openness_level: String(relationship.openness_level || rel?.openness_level || "").slice(0, 50),
      emotional_patterns: String(relationship.emotional_patterns || rel?.emotional_patterns || "").slice(0, 500),
      last_interaction_summary: String(relationship.last_interaction_summary || rel?.last_interaction_summary || "").slice(0, 600),
      updated_at: new Date().toISOString(),
    };

    await supabase.from("user_relationship").update(updateRel).eq("user_id", user.id);

    await supabase.from("user_sessions").insert({
      user_id: user.id,
      emotional_tone: String(sessionOut.emotional_tone || "").slice(0, 50),
      stress_level: Number.isFinite(sessionOut.stress_level) ? sessionOut.stress_level : null,
      closeness_level: Number.isFinite(sessionOut.closeness_level) ? sessionOut.closeness_level : null,
      short_summary: String(sessionOut.short_summary || "").slice(0, 300),
      // falls die Spalte existiert, sonst entfernen:
      duration_seconds: secondsUsed,
    });

    return res.status(200).json({
      ok: true,
      preferred_language_set: finalLang || null,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
