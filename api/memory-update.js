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
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    // Body robust lesen (je nach Vercel Runtime kann req.body string oder object sein)
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
      return res.status(500).json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" });
    }
    if (!openaiKey) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    const supabase = createClient(supabaseUrl, serviceKey);

    // Helpers: DB Fehler nicht verschlucken
    async function mustInsert(table, row, label) {
      const { error } = await supabase.from(table).insert(row);
      if (error) {
        console.error(`${label} insert failed:`, error.message, row);
        throw new Error(`${label} insert failed: ${error.message}`);
      }
    }
    async function mustUpdate(table, values, whereCol, whereVal, label) {
      const { error } = await supabase.from(table).update(values).eq(whereCol, whereVal);
      if (error) {
        console.error(`${label} update failed:`, error.message, values);
        throw new Error(`${label} update failed: ${error.message}`);
      }
    }

    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) return res.status(401).json({ error: "Invalid token" });

    const secondsUsed = Number(body.seconds_used ?? 0) || 0;

    // --- Transcript normalisieren: Array oder String akzeptieren ---
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

    // --- Base session (immer loggen) ---
    // ⚠️ Wenn du KEINE duration_seconds Spalte hast: duration_seconds überall entfernen.
    const baseSession = {
      user_id: user.id,
      duration_seconds: secondsUsed,
      // ⚠️ Wenn user_sessions eine NOT NULL session_date hat, diese Zeile drin lassen:
      session_date: new Date().toISOString(),
    };

    // Wenn kein Transcript: Session loggen & fertig
    if (!transcriptText || transcriptText.trim().length < 10) {
      await mustInsert("user_sessions", {
        ...baseSession,
        emotional_tone: "unknown",
        stress_level: null,
        closeness_level: null,
        short_summary: `No transcript captured. duration=${secondsUsed}s`,
      }, "user_sessions(no_transcript)");

      return res.status(200).json({ ok: true, skipped: true, reason: "No transcript" });
    }

    // --- Relationship read ---
    const { data: rel, error: relErr } = await supabase
      .from("user_relationship")
      .select("tone_baseline, openness_level, emotional_patterns, last_interaction_summary")
      .eq("user_id", user.id)
      .maybeSingle();
    if (relErr) throw new Error(`user_relationship select failed: ${relErr.message}`);

    const system =
      "You update emotional relationship memory for Sophie. " +
      "Be concise and non-creepy. Observations only. No diagnosis.";

    const userMsg = `
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
    };

    // --- OpenAI call (Responses API) ---
    let r;
    try {
      r = await fetch("https://api.openai.com/v1/responses", {
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
          text: {
            format: {
              type: "json_schema",
              name: "sophie_memory_v1",
              strict: true,
              schema: schema,
            },
          },
          truncation: "auto",
        }),
      });
    } catch (e) {
      const msg = String(e?.message || e);

      await mustInsert("user_sessions", {
        ...baseSession,
        emotional_tone: "error",
        stress_level: null,
        closeness_level: null,
        short_summary: `OpenAI fetch exception: ${msg} duration=${secondsUsed}s`.slice(0, 300),
      }, "user_sessions(openai_fetch_exception)");

      return res.status(502).json({ error: "OpenAI fetch failed" });
    }

    if (!r.ok) {
      const errorText = await r.text().catch(() => "");
      const brief = String(errorText).replace(/\s+/g, " ").slice(0, 220);

      await mustInsert("user_sessions", {
        ...baseSession,
        emotional_tone: "error",
        stress_level: null,
        closeness_level: null,
        short_summary: `Memory model error (HTTP ${r.status}). ${brief} duration=${secondsUsed}s`.slice(0, 300),
      }, "user_sessions(openai_http_error)");

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
    } catch {
      await mustInsert("user_sessions", {
        ...baseSession,
        emotional_tone: "error",
        stress_level: null,
        closeness_level: null,
        short_summary: `Bad JSON from model. duration=${secondsUsed}s`.slice(0, 300),
      }, "user_sessions(bad_json)");

      return res.status(200).json({ ok: false, skipped: true, reason: "Bad JSON" });
    }

    const relationship = parsed.relationship || {};
    const sessionOut = parsed.session || {};

    const updateRel = {
      tone_baseline: String(relationship.tone_baseline || rel?.tone_baseline || "").slice(0, 200),
      openness_level: String(relationship.openness_level || rel?.openness_level || "").slice(0, 50),
      emotional_patterns: String(relationship.emotional_patterns || rel?.emotional_patterns || "").slice(0, 500),
      last_interaction_summary: String(relationship.last_interaction_summary || rel?.last_interaction_summary || "").slice(0, 600),
      updated_at: new Date().toISOString(),
    };

    await mustUpdate("user_relationship", updateRel, "user_id", user.id, "user_relationship");

    await mustInsert("user_sessions", {
      user_id: user.id,
      session_date: new Date().toISOString(), // falls NOT NULL
      emotional_tone: String(sessionOut.emotional_tone || "").slice(0, 50),
      stress_level: Number.isFinite(sessionOut.stress_level) ? sessionOut.stress_level : null,
      closeness_level: Number.isFinite(sessionOut.closeness_level) ? sessionOut.closeness_level : null,
      short_summary: String(sessionOut.short_summary || "").slice(0, 300),
      duration_seconds: secondsUsed, // falls Spalte nicht existiert -> entfernen
    }, "user_sessions(success)");

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("memory-update fatal:", err?.message || err, err?.stack || "");
    return res.status(500).json({ error: String(err?.message || err || "Internal server error") });
  }
};
