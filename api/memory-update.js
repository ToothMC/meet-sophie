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
    if (transcript.length === 0) {
      return res.status(200).json({ ok: true, skipped: true, reason: "No transcript" });
    }

    // Load current memory (Variante B)
    const { data: rel, error: relErr } = await supabase
      .from("user_relationship")
      .select("tone_baseline, openness_level, emotional_patterns, last_interaction_summary")
      .eq("user_id", user.id)
      .maybeSingle();

    if (relErr) return res.status(500).json({ error: relErr.message });

    // Limit transcript to avoid huge payloads (keep last ~30 turns)
    const trimmed = transcript.slice(-30).map(t => ({
      role: t.role === "assistant" ? "assistant" : "user",
      text: String(t.text || "").slice(0, 2000)
    }));

    const system = `
You update emotional relationship memory for "Sophie" (a quiet feminine evening presence for men).
You MUST be concise and non-creepy.
Never output diagnosis. Use observations only.

Return ONLY valid JSON (no markdown, no extra text) with this schema:
{
  "relationship": {
    "tone_baseline": "short phrase (max 120 chars) or empty",
    "openness_level": "low|medium|high|mixed (or empty)",
    "emotional_patterns": "semi-colon separated patterns, max 240 chars, or empty",
    "last_interaction_summary": "2-4 short sentences, max 420 chars"
  },
  "session": {
    "emotional_tone": "1-3 words",
    "stress_level": 0-10,
    "closeness_level": 0-10,
    "short_summary": "1-2 sentences, max 240 chars"
  }
}

Rules:
- Keep relationship fields stable; update gently.
- Do not mention storage, databases, or 'I remember'.
- No sexual content. Subtle intimacy only.
- If uncertain, keep fields unchanged or vague.
`;

    const userMsg = `
CURRENT relationship memory:
tone_baseline: ${rel?.tone_baseline || ""}
openness_level: ${rel?.openness_level || ""}
emotional_patterns: ${rel?.emotional_patterns || ""}
last_interaction_summary: ${rel?.last_interaction_summary || ""}

NEW conversation transcript (most recent turns):
${trimmed.map(t => `${t.role.toUpperCase()}: ${t.text}`).join("\n")}
`;

    // Use Responses API (stable). If your account uses another endpoint, tell me.
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
      return res.status(r.status).json({ error: errorText });
    }

    const out = await r.json();

    // Extract the model text
    const text =
      out?.output?.[0]?.content?.find?.(c => c.type === "output_text")?.text
      || out?.output_text
      || "";

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      // If model returns junk, don't destroy memory
      return res.status(200).json({ ok: false, skipped: true, reason: "Bad JSON from model", raw: text.slice(0, 500) });
    }

    const relationship = parsed?.relationship || {};
    const session = parsed?.session || {};

    // Update relationship
    const updateRel = {
      tone_baseline: String(relationship.tone_baseline || rel?.tone_baseline || "").slice(0, 200),
      openness_level: String(relationship.openness_level || rel?.openness_level || "").slice(0, 50),
      emotional_patterns: String(relationship.emotional_patterns || rel?.emotional_patterns || "").slice(0, 500),
      last_interaction_summary: String(relationship.last_interaction_summary || rel?.last_interaction_summary || "").slice(0, 600),
      updated_at: new Date().toISOString(),
    };

    const { error: upErr } = await supabase
      .from("user_relationship")
      .update(updateRel)
      .eq("user_id", user.id);

    if (upErr) return res.status(500).json({ error: upErr.message });

    // Insert session history (optional but useful)
    const ins = {
      user_id: user.id,
      emotional_tone: String(session.emotional_tone || "").slice(0, 50),
      stress_level: Number.isFinite(session.stress_level) ? session.stress_level : null,
      closeness_level: Number.isFinite(session.closeness_level) ? session.closeness_level : null,
      short_summary: String(session.short_summary || "").slice(0, 300),
    };

    await supabase.from("user_sessions").insert(ins);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
