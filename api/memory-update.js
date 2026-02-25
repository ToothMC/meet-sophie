const { createClient } = require("@supabase/supabase-js");

/**
 * POST /api/memory-update
 * Body: {
 *   transcript: Array<{ role: "user"|"assistant", text: string }> | string,
 *   seconds_used?: number
 * }
 */
module.exports = async function handler(req, res) {
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

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const openaiKey   = process.env.OPENAI_API_KEY;

    if (!supabaseUrl || !serviceKey) {
      return res.status(500).json({ error: "Missing SUPABASE env vars" });
    }
    if (!openaiKey) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    const supabase = createClient(supabaseUrl, serviceKey);

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
      .slice(-30)
      .map((t) => `${t.role.toUpperCase()}: ${t.text.slice(0, 2000)}`)
      .join("\n");

    // ---------- Base Session ----------
    const baseSession = {
      user_id: user.id,
      session_date: new Date().toISOString(),
    };

    if (!transcriptText || transcriptText.length < 10) {
      await supabase.from("user_sessions").insert({
        ...baseSession,
        emotional_tone: "unknown",
        stress_level: null,
        closeness_level: null,
        short_summary: `No transcript captured. duration=${secondsUsed}s`,
      });

      return res.status(200).json({ ok: true, skipped: true });
    }

    // ---------- Relationship lesen ----------
    const { data: rel } = await supabase
      .from("user_relationship")
      .select("tone_baseline, openness_level, emotional_patterns, last_interaction_summary")
      .eq("user_id", user.id)
      .maybeSingle();

    const system =
      "You update emotional relationship memory for Sophie. Be concise. Observations only.";

    const userMsg = `
CURRENT relationship memory:
tone_baseline: ${rel?.tone_baseline || ""}
openness_level: ${rel?.openness_level || ""}
emotional_patterns: ${rel?.emotional_patterns || ""}
last_interaction_summary: ${rel?.last_interaction_summary || ""}

NEW transcript:
${transcriptText}
`.trim();

    // ---------- OpenAI Call ----------
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
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
      const t = await r.text().catch(() => "");
      return res.status(500).json({ error: t });
    }

    const out = await r.json();
    const text =
      out?.output_text ||
      out?.output?.[0]?.content?.[0]?.text ||
      "";

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return res.status(200).json({ ok: false, skipped: true });
    }

    const relationship = parsed.relationship || {};
    const sessionOut = parsed.session || {};

    // ---------- 🔥 OPTION B: Laufende Kurz-Kontinuität ----------
    function mergeContinuity(prev, next) {
      const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
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
      relationship.last_interaction_summary || sessionOut.short_summary || ""
    );

    // ---------- Relationship Update ----------
    await supabase.from("user_relationship").upsert({
      user_id: user.id,
      tone_baseline: relationship.tone_baseline || rel?.tone_baseline || "",
      openness_level: relationship.openness_level || rel?.openness_level || "",
      emotional_patterns: relationship.emotional_patterns || rel?.emotional_patterns || "",
      last_interaction_summary: newContinuity,
      updated_at: new Date().toISOString(),
    });

    // ---------- Session speichern ----------
    await supabase.from("user_sessions").insert({
      user_id: user.id,
      session_date: new Date().toISOString(),
      emotional_tone: sessionOut.emotional_tone || "",
      stress_level: sessionOut.stress_level ?? null,
      closeness_level: sessionOut.closeness_level ?? null,
      short_summary: sessionOut.short_summary || "",
    });

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("memory-update fatal:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
