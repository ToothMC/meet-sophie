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

    // -----------------------------
    // Preferred Language Detection + Persist (user_profile.preferred_language)
    // -----------------------------
    function detectPreferredLanguage(transcriptArr) {
      const text = (transcriptArr || [])
        .map(t => String(t?.text || "").toLowerCase())
        .join("\n");

      // German
      if (
        /\b(bitte\s+deutsch|nur\s+deutsch|auf\s+deutsch|sprich\s+deutsch|zukünftig\s+nur\s+noch\s+deutsch)\b/.test(text) ||
        /\b(please\s+in\s+german|in\s+german\s+please|speak\s+german)\b/.test(text)
      ) return "de";

      // English
      if (
        /\b(bitte\s+englisch|nur\s+englisch|auf\s+englisch|sprich\s+englisch|only\s+english)\b/.test(text) ||
        /\b(please\s+in\s+english|in\s+english\s+please|speak\s+english)\b/.test(text)
      ) return "en";

      // Spanish
      if (
        /\b(bitte\s+spanisch|nur\s+spanisch|auf\s+spanisch|sprich\s+spanisch)\b/.test(text) ||
        /\b(please\s+in\s+spanish|in\s+spanish\s+please|speak\s+spanish)\b/.test(text) ||
        /\b(en\s+español|por\s+favor\s+en\s+español|habla\s+español)\b/.test(text)
      ) return "es";

      return null;
    }

    const finalLang = detectPreferredLanguage(transcriptArr);

    if (finalLang) {
      const { error: langErr } = await supabase
        .from("user_profile")
        .upsert(
          { user_id: user.id, preferred_language: finalLang },
          { onConflict: "user_id" }
        );

      if (langErr) console.warn("preferred_language upsert failed:", langErr.message);
    }

    // --- Base session (immer loggen) ---
    // ✅ duration_seconds entfernt (Spalte existiert nicht)
    // ✅ session_date gesetzt (UTC; Anzeige später lokal formatieren)
    const baseSession = {
      user_id: user.id,
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

      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: "No transcript",
        preferred_language_set: finalLang || null,
      });
    }

    // --- Relationship read ---
    const { data: rel, error: relErr } = await supabase
      .from("user_relationship")
      .select("tone_baseline, openness_level, emotional_patterns, last_interaction_summary")
      .eq("user_id", user.id)
      .maybeSingle();
    if (relErr) throw new Error(`user_relationship select failed: ${relErr.message}`);

    // --- Profile read (NEU) ---
    const { data: profile, error: profErr } = await supabase
      .from("user_profile")
      .select("user_id, first_name, age, relationship_status, notes, preferred_language, preferred_name, preferred_addressing, preferred_pronoun, occupation, conversation_style, topics_like, topics_avoid, memory_confidence, last_confirmed_at")
      .eq("user_id", user.id)
      .maybeSingle();
    if (profErr) throw new Error(`user_profile select failed: ${profErr.message}`);

    // --- Helpers für Patch Apply ---
    const uniq = (arr) => Array.from(new Set((arr || []).map(x => String(x || "").trim()).filter(Boolean)));
    const mergeTopics = (oldArr, addArr) => uniq([...(oldArr || []), ...(addArr || [])]).slice(0, 30); // hard cap

    // -----------------------------
    // OpenAI prompt + JSON Schema
    // -----------------------------
    const system =
      "You update Sophie memory.\n" +
      "Output TWO things:\n" +
      "1) relationship memory: observations only, non-creepy, no diagnosis.\n" +
      "2) user_profile patch: only store personal facts that improve conversation.\n\n" +
      "CRITICAL RULES FOR profile_patch:\n" +
      "- preferred_addressing MUST be a nickname/name (e.g., 'Michi', 'Michael'). It must NEVER be 'du' or 'sie'.\n" +
      "- preferred_pronoun is ONLY 'du' or 'sie'.\n" +      
      "- Only set/overwrite sensitive identity fields (preferred_addressing, preferred_pronoun, preferred_name) if the user explicitly states it (explicit=true).\n" +
      "- For topics_like/topics_avoid: only add items, never remove.\n" +
      "- Keep values short. No private addresses, no health/medical details, no employer names.\n" +
      "- If unsure, leave a field null and set confidence low.\n";

    const userMsg = `
CURRENT relationship memory:
tone_baseline: ${rel?.tone_baseline || ""}
openness_level: ${rel?.openness_level || ""}
emotional_patterns: ${rel?.emotional_patterns || ""}
last_interaction_summary: ${rel?.last_interaction_summary || ""}

CURRENT user_profile (known facts):
preferred_name: ${profile?.preferred_name || ""}
preferred_addressing: ${profile?.preferred_addressing || ""}
preferred_pronoun: ${profile?.preferred_pronoun || ""}
first_name: ${profile?.first_name || ""}
age: ${profile?.age ?? ""}
relationship_status: ${profile?.relationship_status || ""}
occupation: ${profile?.occupation || ""}
conversation_style: ${profile?.conversation_style || ""}
topics_like: ${(profile?.topics_like || []).join(", ")}
topics_avoid: ${(profile?.topics_avoid || []).join(", ")}
preferred_language: ${profile?.preferred_language || ""}

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
        profile_patch: {
          type: "object",
          additionalProperties: false,
          properties: {
            set: {
              type: "object",
              additionalProperties: false,
              properties: {
                preferred_name: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: {
                    value: { type: "string" },
                    explicit: { type: "boolean" },
                    confidence: { type: "string", enum: ["low","medium","high"] }
                  },
                  required: ["value","explicit","confidence"]
                },
                preferred_addressing: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: {
                    value: { type: "string" },
                    explicit: { type: "boolean" },
                    confidence: { type: "string", enum: ["low","medium","high"] }
                  },
                  required: ["value","explicit","confidence"]
                },
                preferred_pronoun: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: {
                    value: { type: "string" },
                    explicit: { type: "boolean" },
                    confidence: { type: "string", enum: ["low","medium","high"] }
                  },
                  required: ["value","explicit","confidence"]
                },
                age: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: {
                    value: { type: "integer", minimum: 10, maximum: 110 },
                    explicit: { type: "boolean" },
                    confidence: { type: "string", enum: ["low","medium","high"] }
                  },
                  required: ["value","explicit","confidence"]
                },
                relationship_status: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: {
                    value: { type: "string" },
                    explicit: { type: "boolean" },
                    confidence: { type: "string", enum: ["low","medium","high"] }
                  },
                  required: ["value","explicit","confidence"]
                },
                occupation: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: {
                    value: { type: "string" },
                    explicit: { type: "boolean" },
                    confidence: { type: "string", enum: ["low","medium","high"] }
                  },
                  required: ["value","explicit","confidence"]
                },
                conversation_style: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: {
                    value: { type: "string" },
                    explicit: { type: "boolean" },
                    confidence: { type: "string", enum: ["low","medium","high"] }
                  },
                  required: ["value","explicit","confidence"]
                }
              },
              required: [
                "preferred_name",
                "preferred_addressing",
                "preferred_pronoun",
                "age",
                "relationship_status",
                "occupation",
                "conversation_style"
              ]
            },
            add: {
              type: "object",
              additionalProperties: false,
              properties: {
                topics_like: { type: "array", items: { type: "string" } },
                topics_avoid: { type: "array", items: { type: "string" } }
              },
              required: ["topics_like", "topics_avoid"]
            }
          },
          required: ["set", "add"]
        }
      },
      required: ["relationship", "session", "profile_patch"],
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
              name: "sophie_memory_v2",
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

      return res.status(200).json({
        ok: false,
        skipped: true,
        reason: "Bad JSON",
        preferred_language_set: finalLang || null,
      });
    }

    const relationship = parsed.relationship || {};
    const sessionOut = parsed.session || {};
    const patch = parsed.profile_patch || { set: {}, add: {} };

    // --- Relationship update ---
    const updateRel = {
      tone_baseline: String(relationship.tone_baseline || rel?.tone_baseline || "").slice(0, 200),
      openness_level: String(relationship.openness_level || rel?.openness_level || "").slice(0, 50),
      emotional_patterns: String(relationship.emotional_patterns || rel?.emotional_patterns || "").slice(0, 500),
      last_interaction_summary: String(relationship.last_interaction_summary || rel?.last_interaction_summary || "").slice(0, 600),
      updated_at: new Date().toISOString(),
    };

    await mustUpdate("user_relationship", updateRel, "user_id", user.id, "user_relationship");

    // --- Profile patch apply ---
    const existing = profile || { user_id: user.id };

    const setObj = patch.set || {};
    const addObj = patch.add || {};

    function applyField(key, opts, { requireExplicit = false } = {}) {
      if (!opts || typeof opts !== "object") return { changed: false };
      const val = opts.value;
      const explicit = !!opts.explicit;
      const conf = String(opts.confidence || "low");

      if (requireExplicit && !explicit) return { changed: false };
      if (val === null || val === undefined) return { changed: false };

      // age is number, other fields string
      if (key === "age") {
        if (!Number.isInteger(val)) return { changed: false };
        return { changed: true, value: val, explicit, conf };
      }

      const s = String(val).trim();
      if (!s) return { changed: false };

      const capped =
        key === "occupation" ? s.slice(0, 80) :
        key === "relationship_status" ? s.slice(0, 40) :
        key === "conversation_style" ? s.slice(0, 120) :
        s.slice(0, 80);

      return { changed: true, value: capped, explicit, conf };
    }

    const updates = {};
    let anyExplicit = false;
    let confidenceToStore = existing.memory_confidence || "medium";

    const addr = applyField("preferred_addressing", setObj.preferred_addressing, { requireExplicit: true });
    if (addr.changed) { updates.preferred_addressing = addr.value; anyExplicit = anyExplicit || addr.explicit; confidenceToStore = addr.conf; }

    const pname = applyField("preferred_name", setObj.preferred_name, { requireExplicit: true });
    if (pname.changed) { updates.preferred_name = pname.value; anyExplicit = anyExplicit || pname.explicit; confidenceToStore = pname.conf; }

    const pron = applyField("preferred_pronoun", setObj.preferred_pronoun, { requireExplicit: true });
    if (pron.changed) {
      const v = String(pron.value).toLowerCase();
      if (v === "du" || v === "sie") {
        updates.preferred_pronoun = v;
        anyExplicit = anyExplicit || pron.explicit;
        confidenceToStore = pron.conf;
      }
    }

    const age = applyField("age", setObj.age, { requireExplicit: true });
    if (age.changed) { updates.age = age.value; anyExplicit = true; confidenceToStore = age.conf; }

    const occ = applyField("occupation", setObj.occupation, { requireExplicit: false });
    if (occ.changed) { updates.occupation = occ.value; }

    const cs = applyField("conversation_style", setObj.conversation_style, { requireExplicit: true });
    if (cs.changed) { updates.conversation_style = cs.value; anyExplicit = anyExplicit || cs.explicit; confidenceToStore = cs.conf; }

    const rs = applyField("relationship_status", setObj.relationship_status, { requireExplicit: false });
    if (rs.changed) { updates.relationship_status = rs.value; }

    // topics arrays: union add only
    if (Array.isArray(addObj.topics_like)) {
      updates.topics_like = mergeTopics(existing.topics_like, addObj.topics_like);
    }
    if (Array.isArray(addObj.topics_avoid)) {
      updates.topics_avoid = mergeTopics(existing.topics_avoid, addObj.topics_avoid);
    }

    if (Object.keys(updates).length > 0) {
      if (anyExplicit) updates.last_confirmed_at = new Date().toISOString();

      updates.memory_confidence = (confidenceToStore === "low" || confidenceToStore === "medium" || confidenceToStore === "high")
        ? confidenceToStore
        : (existing.memory_confidence || "medium");

      const { error: upErr } = await supabase
        .from("user_profile")
        .upsert(
          { user_id: user.id, ...updates },
          { onConflict: "user_id" }
        );

      if (upErr) console.warn("user_profile upsert failed:", upErr.message);
    }

    // --- Session log ---
    await mustInsert("user_sessions", {
      user_id: user.id,
      session_date: new Date().toISOString(),
      emotional_tone: String(sessionOut.emotional_tone || "").slice(0, 50),
      stress_level: Number.isFinite(sessionOut.stress_level) ? sessionOut.stress_level : null,
      closeness_level: Number.isFinite(sessionOut.closeness_level) ? sessionOut.closeness_level : null,
      short_summary: String(sessionOut.short_summary || "").slice(0, 300),
    }, "user_sessions(success)");

    return res.status(200).json({
      ok: true,
      preferred_language_set: finalLang || null,
      profile_updated: Object.keys(updates).length > 0,
      profile_fields_updated: Object.keys(updates),
    });
  } catch (err) {
    console.error("memory-update fatal:", err?.message || err, err?.stack || "");
    return res.status(500).json({ error: String(err?.message || err || "Internal server error") });
  }
};
