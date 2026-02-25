const { createClient } = require("@supabase/supabase-js");

/**
 * POST /api/memory-update
 */
module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body && typeof body === "object" ? body : {};

    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (!token)
      return res.status(401).json({ error: "Missing Authorization Bearer token" });

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey)
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    const { data: { user }, error: userErr } =
      await supabase.auth.getUser(token);

    if (userErr || !user)
      return res.status(401).json({ error: "Invalid token" });

    const transcriptArr = Array.isArray(body.transcript)
      ? body.transcript
      : [{ role: "user", text: String(body.transcript || "") }];

    const transcriptText = transcriptArr
      .slice(-30)
      .map(t => `${t.role}: ${String(t.text || "").slice(0, 2000)}`)
      .join("\n");

    if (!transcriptText.trim())
      return res.status(200).json({ ok: true, skipped: true });

    // --- Load current profile ---
    const { data: profile } = await supabase
      .from("user_profile")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    const system =
      "You update Sophie memory.\n\n" +
      "Return relationship memory and user_profile patch.\n\n" +
      "CRITICAL RULES:\n" +
      "- preferred_addressing MUST be a nickname/name (e.g. 'Michi'). NEVER 'du' or 'sie'.\n" +
      "- preferred_pronoun is ONLY 'du' or 'sie'.\n" +
      "- Sensitive fields only if explicit=true.\n" +
      "- topics_like/topics_avoid: add only, never remove.\n" +
      "- If unsure → null.\n";

    const schema = {
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
            last_interaction_summary: { type: "string" }
          },
          required: [
            "tone_baseline",
            "openness_level",
            "emotional_patterns",
            "last_interaction_summary"
          ]
        },
        session: {
          type: "object",
          additionalProperties: false,
          properties: {
            emotional_tone: { type: "string" },
            stress_level: { type: "integer" },
            closeness_level: { type: "integer" },
            short_summary: { type: "string" }
          },
          required: [
            "emotional_tone",
            "stress_level",
            "closeness_level",
            "short_summary"
          ]
        },
        profile_patch: {
          type: "object",
          additionalProperties: false,
          properties: {
            set: { type: "object" },
            add: { type: "object" }
          },
          required: ["set", "add"]
        }
      },
      required: ["relationship", "session", "profile_patch"]
    };

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: [
          { role: "system", content: system },
          { role: "user", content: transcriptText }
        ],
        temperature: 0.2,
        text: {
          format: {
            type: "json_schema",
            name: "sophie_memory_v3",
            strict: true,
            schema
          }
        }
      })
    });

    if (!r.ok)
      return res.status(500).json({ error: await r.text() });

    const out = await r.json();
    const text =
      out.output_text ||
      out.output?.[0]?.content?.[0]?.text ||
      "";

    const parsed = JSON.parse(text);

    const patch = parsed.profile_patch || {};
    const setObj = patch.set || {};
    const addObj = patch.add || {};

    const existing = profile || {};
    const updates = {};

    const uniq = arr =>
      Array.from(new Set((arr || []).filter(Boolean)));

    // -------- ADDRESSING GUARDRAIL --------
    if (setObj.preferred_addressing?.explicit) {
      const v = String(setObj.preferred_addressing.value || "").toLowerCase();
      if (v === "du" || v === "sie") {
        updates.preferred_pronoun = v;
      } else {
        updates.preferred_addressing = setObj.preferred_addressing.value;
      }
    }

    if (setObj.preferred_pronoun?.explicit) {
      const v = String(setObj.preferred_pronoun.value || "").toLowerCase();
      if (v === "du" || v === "sie")
        updates.preferred_pronoun = v;
    }

    if (setObj.preferred_name?.explicit)
      updates.preferred_name = setObj.preferred_name.value;

    if (setObj.age?.explicit && Number.isInteger(setObj.age.value))
      updates.age = setObj.age.value;

    if (setObj.conversation_style?.explicit)
      updates.conversation_style = setObj.conversation_style.value;

    if (Array.isArray(addObj.topics_like))
      updates.topics_like = uniq([
        ...(existing.topics_like || []),
        ...addObj.topics_like
      ]);

    if (Array.isArray(addObj.topics_avoid))
      updates.topics_avoid = uniq([
        ...(existing.topics_avoid || []),
        ...addObj.topics_avoid
      ]);

    if (Object.keys(updates).length > 0) {
      updates.user_id = user.id;
      updates.last_confirmed_at = new Date().toISOString();

      await supabase
        .from("user_profile")
        .upsert(updates, { onConflict: "user_id" });
    }

    return res.status(200).json({
      ok: true,
      profile_updated: Object.keys(updates)
    });

  } catch (err) {
    console.error("memory-update fatal:", err);
    return res.status(500).json({ error: "Internal error" });
  }
};
