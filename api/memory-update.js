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

    // Body robust lesen
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

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // User validieren
    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) return res.status(401).json({ error: "Invalid token" });

    const secondsUsed = Number(body.seconds_used ?? 0) || 0;
    const nowIso = new Date().toISOString();

    // Transcript normalisieren
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
      .slice(-80)
      .map((t) => `${t.role.toUpperCase()}: ${t.text.slice(0, 2000)}`)
      .join("\n");

    const baseSession = { user_id: user.id, session_date: nowIso };

    // Wenn kein Transcript: Session loggen & fertig
    if (!transcriptText || transcriptText.trim().length < 10) {
      await supabase.from("user_sessions").insert({
        ...baseSession,
        emotional_tone: "unknown",
        stress_level: null,
        closeness_level: null,
        short_summary: `No transcript captured. duration=${secondsUsed}s`.slice(0, 300),
      });
      return res.status(200).json({ ok: true, skipped: true, reason: "No transcript" });
    }

    // Existing relationship/profile laden (inkl. Identity-Felder)
    const { data: rel } = await supabase
      .from("user_relationship")
      .select("tone_baseline, openness_level, emotional_patterns, last_interaction_summary")
      .eq("user_id", user.id)
      .maybeSingle();

    const { data: prof } = await supabase
      .from("user_profile")
      .select(
        "first_name, preferred_name, preferred_addressing, preferred_pronoun, preferred_language, notes, " +
        "occupation, conversation_style, topics_like, topics_avoid"
      )
      .eq("user_id", user.id)
      .maybeSingle();

    const existing = {
      first_name: String(prof?.first_name || "").trim(),
      preferred_name: String(prof?.preferred_name || "").trim(),
      preferred_addressing: String(prof?.preferred_addressing || "").trim(),
      preferred_pronoun: String(prof?.preferred_pronoun || "").trim(),
      preferred_language: String(prof?.preferred_language || "").trim().toLowerCase(),
      notes: String(prof?.notes || "").trim(),

      occupation: String(prof?.occupation || "").trim(),
      conversation_style: String(prof?.conversation_style || "").trim(),
      topics_like: Array.isArray(prof?.topics_like) ? prof.topics_like.map((x) => String(x || "").trim()).filter(Boolean) : [],
      topics_avoid: Array.isArray(prof?.topics_avoid) ? prof.topics_avoid.map((x) => String(x || "").trim()).filter(Boolean) : [],

      tone_baseline: String(rel?.tone_baseline || "").trim(),
      openness_level: String(rel?.openness_level || "").trim(),
      emotional_patterns: String(rel?.emotional_patterns || "").trim(),
      last_interaction_summary: String(rel?.last_interaction_summary || "").trim(),
    };

    const system =
      "Extract structured long-term user identity and relationship memory for Sophie. " +
      "Only store information that is clearly and explicitly stated. " +
      "Never guess. Never infer. If unsure, return empty values. " +
      "Extract occupation if clearly mentioned. " +
      "Extract topics_like only when the user expresses a clear positive preference. " +
      "Extract topics_avoid only when the user expresses a clear dislike/avoidance. " +
      "Infer conversation_style only if the user's communication style is obvious (e.g., analytical, direct, playful, reserved) — otherwise empty. " +
      "preferred_addressing must be either 'informal' or 'formal' (or empty).";

    const userMsg = `
CURRENT structured profile:
first_name: ${existing.first_name}
preferred_name: ${existing.preferred_name}
preferred_addressing: ${existing.preferred_addressing}
preferred_pronoun: ${existing.preferred_pronoun}
preferred_language: ${existing.preferred_language}
occupation: ${existing.occupation}
conversation_style: ${existing.conversation_style}
topics_like: ${existing.topics_like.join(", ")}
topics_avoid: ${existing.topics_avoid.join(", ")}
notes: ${existing.notes}

CURRENT relationship memory:
tone_baseline: ${existing.tone_baseline}
openness_level: ${existing.openness_level}
emotional_patterns: ${existing.emotional_patterns}
last_interaction_summary: ${existing.last_interaction_summary}

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
            preferred_name: { type: "string", description: "Name Sophie should use to address the user (nickname if preferred)" },
            preferred_addressing: { type: "string", description: "informal or formal (or empty)" },
            preferred_pronoun: { type: "string", description: "e.g. he/him, she/her, they/them, or empty" },
            preferred_language: { type: "string", description: "e.g. en,de,it,... or empty" },

            occupation: { type: "string", description: "User's occupation/job, only if explicitly stated" },
            conversation_style: { type: "string", description: "e.g. analytical, direct, playful, reserved (or empty if unclear)" },
            topics_like: { type: "array", items: { type: "string" } },
            topics_avoid: { type: "array", items: { type: "string" } },
          },
          required: [
            "first_name",
            "preferred_name",
            "preferred_addressing",
            "preferred_pronoun",
            "preferred_language",
            "occupation",
            "conversation_style",
            "topics_like",
            "topics_avoid",
          ],
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

    // OpenAI Responses API call
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
            name: "sophie_memory_structured_v2",
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

    const p = parsed.profile || {};
    const rr = parsed.relationship || {};
    const ss = parsed.session || {};

    // ---- Helpers ----
    const toArrayStrings = (v) =>
      Array.isArray(v) ? v.map(clean).filter(Boolean) : [];

    function mergeStringArrays(existingArr, newArr, limit = 12) {
      const base = Array.isArray(existingArr) ? existingArr : [];
      const merged = [...new Set([...base, ...newArr])].filter(Boolean);
      return merged.slice(0, limit);
    }

    // ---- Merge / sanitize profile ----
    const firstNameNew = clean(p.first_name);
    const preferredNameNew = clean(p.preferred_name);
    const addressingNew = clean(p.preferred_addressing).toLowerCase();
    const pronounNew = clean(p.preferred_pronoun);
    const langNew = clean(p.preferred_language).toLowerCase();

    const occupationNew = clean(p.occupation);
    const styleNew = clean(p.conversation_style);
    const topicsLikeNew = toArrayStrings(p.topics_like);
    const topicsAvoidNew = toArrayStrings(p.topics_avoid);

    const finalFirstName = (firstNameNew || existing.first_name).slice(0, 80);
    const finalPreferredName = (preferredNameNew || finalFirstName || existing.preferred_name).slice(0, 80);

    const finalAddressing =
      (addressingNew === "informal" || addressingNew === "formal")
        ? addressingNew
        : (existing.preferred_addressing || "");

    const finalPronoun = (pronounNew || existing.preferred_pronoun).slice(0, 24);
    const finalLang = (langNew || existing.preferred_language).slice(0, 12);

    const finalOccupation = (occupationNew || existing.occupation).slice(0, 120);
    const finalStyle = (styleNew || existing.conversation_style).slice(0, 80);

    const finalTopicsLike = mergeStringArrays(existing.topics_like, topicsLikeNew, 12);
    const finalTopicsAvoid = mergeStringArrays(existing.topics_avoid, topicsAvoidNew, 12);

    // Optional: marker line in notes for easy debugging/backward compat
    const marker = "SOPHIE_PREFS:";
    const prefsLine = `${marker} preferred_name=${finalPreferredName}; preferred_addressing=${finalAddressing}; preferred_pronoun=${finalPronoun}; lang=${finalLang}`.trim();
    let finalNotes = existing.notes || "";
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

    // ---- Upsert user_profile (STRUCTURED) ----
    const profileRow = {
      user_id: user.id,
      first_name: finalFirstName || null,
      preferred_name: finalPreferredName || null,
      preferred_addressing: finalAddressing || null,
      preferred_pronoun: finalPronoun || null,
      preferred_language: finalLang || null,

      occupation: finalOccupation || null,
      conversation_style: finalStyle || null,
      topics_like: finalTopicsLike.length ? finalTopicsLike : null,
      topics_avoid: finalTopicsAvoid.length ? finalTopicsAvoid : null,

      notes: finalNotes.slice(0, 2000),
      updated_at: nowIso,
    };

    // Upsert mit Fallback
    const { error: profUpErr } = await supabase
      .from("user_profile")
      .upsert(profileRow, { onConflict: "user_id" });

    if (profUpErr) {
      console.error("user_profile upsert failed:", profUpErr.message, profileRow);

      const { error: updErr } = await supabase
        .from("user_profile")
        .update(profileRow)
        .eq("user_id", user.id);

      if (updErr) {
        console.error("user_profile update fallback failed:", updErr.message);

        const { error: insErr } = await supabase
          .from("user_profile")
          .insert(profileRow);

        if (insErr) console.error("user_profile insert fallback failed:", insErr.message);
      }
    }

    // ---- Relationship merge (keep last 3 bullets) ----
    function mergeContinuity(prev, next) {
      prev = clean(prev);
      next = clean(next);
      if (!next) return prev;
      if (prev && prev.includes(next)) return prev;

      let parts = prev ? prev.split(" • ").map(clean).filter(Boolean) : [];
      parts = parts.filter((x) => x !== next);
      parts.unshift(next);
      return parts.slice(0, 3).join(" • ").slice(0, 600);
    }

    const newContinuity = mergeContinuity(
      existing.last_interaction_summary,
      clean(rr.last_interaction_summary || ss.short_summary)
    );

    const relRow = {
      user_id: user.id,
      tone_baseline: clean(rr.tone_baseline || existing.tone_baseline).slice(0, 200),
      openness_level: clean(rr.openness_level || existing.openness_level).slice(0, 50),
      emotional_patterns: clean(rr.emotional_patterns || existing.emotional_patterns).slice(0, 500),
      last_interaction_summary: clean(newContinuity).slice(0, 600),
      updated_at: nowIso,
    };

    const { error: relUpErr } = await supabase
      .from("user_relationship")
      .upsert(relRow, { onConflict: "user_id" });

    if (relUpErr) console.error("user_relationship upsert failed:", relUpErr.message, relRow);

    // ---- user_sessions insert ----
    await supabase.from("user_sessions").insert({
      user_id: user.id,
      session_date: nowIso,
      emotional_tone: clean(ss.emotional_tone).slice(0, 50) || "unknown",
      stress_level: Number.isFinite(ss.stress_level) ? ss.stress_level : null,
      closeness_level: Number.isFinite(ss.closeness_level) ? ss.closeness_level : null,
      short_summary: clean(ss.short_summary).slice(0, 300) || "Session captured.",
    });

    return res.status(200).json({
      ok: true,
      extracted: {
        first_name: finalFirstName,
        preferred_name: finalPreferredName,
        preferred_addressing: finalAddressing,
        preferred_pronoun: finalPronoun,
        preferred_language: finalLang,
        occupation: finalOccupation,
        conversation_style: finalStyle,
        topics_like: finalTopicsLike,
        topics_avoid: finalTopicsAvoid,
      },
    });
  } catch (err) {
    console.error("memory-update fatal:", err?.message || err, err?.stack || "");
    return res.status(500).json({ error: String(err?.message || err || "Internal server error") });
  }
}
