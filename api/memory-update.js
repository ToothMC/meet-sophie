import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/memory-update
 * Body: {
 *   transcript: Array<{ role: "user"|"assistant", text: string }>,
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

    const transcript = Array.isArray(req.body?.transcript) ? req.body.transcript : [];
    const secondsUsed = Number(req.body?.seconds_used ?? 0) || 0;

    // -----------------------------
    // Language preference (persisted)
    // -----------------------------

    // Explicit language request detection (keyword-based, low risk)
    function detectPreferredLanguageExplicit(transcriptArr) {
      const t = (transcriptArr || [])
        .filter(x => x && x.role === "user")
        .map(x => String(x.text || "").toLowerCase())
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

      // If user asks for multiple languages explicitly, don't guess
      const count = [wantsGerman, wantsEnglish, wantsSpanish].filter(Boolean).length;
      if (count !== 1) return null;

      if (wantsGerman) return "de";
      if (wantsEnglish) return "en";
      if (wantsSpanish) return "es";
      return null;
    }

    // Very simple heuristic for auto-detecting the last user language (only if we have text)
    function autoDetectLanguageFromLastUserText(transcriptArr) {
      const lastUser = [...(transcriptArr || [])]
        .reverse()
        .find(x => x?.role === "user" && typeof x?.text === "string" && x.text.trim().length > 0);

      const txt = String(lastUser?.text || "").toLowerCase();
      if (!txt) return null;

      // Heuristics: good enough for de/en/es; avoids overwriting when mixed
      const hasGermanChars = /[äöüß]/.test(txt);
      const hasSpanishChars = /[ñáéíóú¿¡]/.test(txt);

      const germanWords = /\b(und|aber|doch|nicht|ich|du|wir|bitte|heute|genau|kannst|möchte)\b/.test(txt);
      const spanishWords = /\b(hola|gracias|por favor|buenas|sí|no|yo|tú|nosotros|vale|claro)\b/.test(txt);
      const englishWords = /\b(the|and|but|not|please|today|i|you|we|yeah|okay|really)\b/.test(txt);

      const germanScore = (hasGermanChars ? 2 : 0) + (germanWords ? 1 : 0);
      const spanishScore = (hasSpanishChars ? 2 : 0) + (spanishWords ? 1 : 0);
      const englishScore = (englishWords ? 1 : 0);

      // Require a clear winner, otherwise return null (don't overwrite preference)
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

    // Determine which language (if any) to persist this session
    let finalLang = detectPreferredLanguageExplicit(transcript);

    // If not explicit and we have enough transcript, try auto-detect
    if (!finalLang && transcript.length >= 2) {
      finalLang = autoDetectLanguageFromLastUserText(transcript);
    }

    if (finalLang) {
      const { error: langErr } = await supabase
        .from("user_profile")
        .update({ preferred_language: finalLang })
        .eq("user_id", user.id);

      if (langErr) console.warn("preferred_language update failed:", langErr.message);
    }

    // -----------------------------
    // Always: log a user session row
    // -----------------------------
    const baseSession = {
      user_id: user.id,
      emotional_tone: transcript.length ? null : "unknown",
      stress_level: null,
      closeness_level: null,
      short_summary: transcript.length ? null : `No transcript captured. duration=${secondsUsed}s`,
    };

    // If no transcript: just log session + return
    if (transcript.length === 0) {
      await supabase.from("user_sessions").insert(baseSession);
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

    const trimmed = transcript.slice(-30).map(t => ({
      role: t.role === "assistant" ? "assistant" : "user",
      text: String(t.text || "").slice(0, 2000),
    }));

    const system = `
You update emotional relationship memory for "Sophie" (quiet feminine evening presence).
Be concise and non-creepy. Observations only. No diagnosis.

Return ONLY valid JSON:
{
  "relationship": {
    "tone_baseline": "max 120 chars or empty",
    "openness_level": "low|medium|high|mixed (or empty)",
    "emotional_patterns": "semi-colon patterns max 240 chars or empty",
    "last_interaction_summary": "2-4 short sentences max 420 chars"
  },
  "session": {
    "emotional_tone": "1-3 words",
    "stress_level": 0-10,
    "closeness_level": 0-10,
    "short_summary": "1-2 sentences max 240 chars"
  }
}
`;

    const userMsg = `
CURRENT relationship memory:
tone_baseline: ${rel?.tone_baseline || ""}
openness_level: ${rel?.openness_level || ""}
emotional_patterns: ${rel?.emotional_patterns || ""}
last_interaction_summary: ${rel?.last_interaction_summary || ""}

NEW transcript:
${trimmed.map(t => `${t.role.toUpperCase()}: ${t.text}`).join("\n")}
`;

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
      }),
    });

    if (!r.ok) {
      const errorText = await r.text();
      await supabase.from("user_sessions").insert({
        ...baseSession,
        short_summary: `Memory model error. duration=${secondsUsed}s`,
      });
      return res.status(r.status).json({ error: errorText });
    }

    const out = await r.json();
    const text =
      out?.output?.[0]?.content?.find?.(c => c.type === "output_text")?.text ||
      out?.output_text ||
      "";

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      await supabase.from("user_sessions").insert({
        ...baseSession,
        short_summary: `Bad JSON from model. duration=${secondsUsed}s`,
      });
      return res.status(200).json({
        ok: false,
        skipped: true,
        reason: "Bad JSON from model",
        raw: text.slice(0, 500),
        preferred_language_set: finalLang || null,
      });
    }

    const relationship = parsed?.relationship || {};
    const session = parsed?.session || {};

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
      emotional_tone: String(session.emotional_tone || "").slice(0, 50),
      stress_level: Number.isFinite(session.stress_level) ? session.stress_level : null,
      closeness_level: Number.isFinite(session.closeness_level) ? session.closeness_level : null,
      short_summary: String(session.short_summary || "").slice(0, 300),
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
