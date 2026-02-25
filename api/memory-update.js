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

    // User aus Token
    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) return res.status(401).json({ error: "Invalid token" });

    const secondsUsed = Number(body.seconds_used ?? 0) || 0;

    // Transcript normalisieren (Array oder String)
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

    if (!transcriptText.trim()) {
      // Optional: trotzdem Session loggen (wenn Tabelle existiert)
      try {
        await supabase.from("user_sessions").insert({
          user_id: user.id,
          session_date: new Date().toISOString(),
          emotional_tone: "unknown",
          stress_level: null,
          closeness_level: null,
          short_summary: `No transcript. duration=${secondsUsed}s`.slice(0, 300),
        });
      } catch (_) {}

      return res.status(200).json({ ok: true, skipped: true, reason: "No transcript" });
    }

    // Aktuelles Profil laden (für union merge / Kontext)
    const { data: profile, error: profErr } = await supabase
      .from("user_profile")
      .select("user_id, first_name, preferred_name, preferred_addressing, preferred_pronoun, age, relationship_status, occupation, conversation_style, topics_like, topics_avoid")
      .eq("user_id", user.id)
      .maybeSingle();

    if (profErr) console.warn("user_profile select failed:", profErr.message);

    // Aktuelle Relationship laden (falls du es nutzt)
    const { data: rel, error: relErr } = await supabase
      .from("user_relationship")
      .select("tone_baseline, openness_level, emotional_patterns, last_interaction_summary")
      .eq("user_id", user.id)
      .maybeSingle();

    if (relErr) console.warn("user_relationship select failed:", relErr.message);

    const uniq = (arr) => Array.from(new Set((arr || []).map(x => String(x || "").trim()).filter(Boolean)));
    const mergeTopics = (oldArr, addArr) => uniq([...(oldArr || []), ...(addArr || [])]).slice(0, 40);

    const system =
      "You update Sophie memory.\n" +
      "Return relationship memory, session summary, and a user_profile patch.\n\n" +
      "CRITICAL RULES:\n" +
      "- preferred_addressing MUST be a nickname/name (e.g. 'Michi', 'Michael'). NEVER 'du' or 'sie'.\n" +
      "- preferred_pronoun is ONLY 'du' or 'sie'.\n" +
      "- Facts mapping:\n" +
      "  * first_name: user's first name (e.g. Michael)\n" +
      "  * occupation: user's profession/job (e.g. Zahntechniker)\n" +
      "  * relationship_status: e.g. verheiratet / single / in Beziehung\n" +
      "- topics_like/topics_avoid are ONLY interests/preferences (e.g. Technik, Sport, Reisen).\n" +
      "- NEVER put occupation or relationship_status or name into topics_like/topics_avoid.\n" +
      "- Update fields only if explicitly stated by the user (explicit=true).\n" +
      "- If unsure, set field to null and confidence low.\n";

    const userMsg = `
CURRENT user_profile:
first_name: ${profile?.first_name || ""}
preferred_name: ${profile?.preferred_name || ""}
preferred_addressing: ${profile?.preferred_addressing || ""}
preferred_pronoun: ${profile?.preferred_pronoun || ""}
age: ${profile?.age ?? ""}
relationship_status: ${profile?.relationship_status || ""}
occupation: ${profile?.occupation || ""}
conversation_style: ${profile?.conversation_style || ""}
topics_like: ${(profile?.topics_like || []).join(", ")}
topics_avoid: ${(profile?.topics_avoid || []).join(", ")}

CURRENT relationship:
tone_baseline: ${rel?.tone_baseline || ""}
openness_level: ${rel?.openness_level || ""}
emotional_patterns: ${rel?.emotional_patterns || ""}
last_interaction_summary: ${rel?.last_interaction_summary || ""}

NEW transcript:
${transcriptText}
`.trim();

    // ✅ Strict schema: relationship + session + profile_patch
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
          required: ["tone_baseline", "openness_level", "emotional_patterns", "last_interaction_summary"]
        },
        session: {
          type: "object",
          additionalProperties: false,
          properties: {
            emotional_tone: { type: "string" },
            stress_level: { type: "integer", minimum: 0, maximum: 10 },
            closeness_level: { type: "integer", minimum: 0, maximum: 10 },
            short_summary: { type: "string" }
          },
          required: ["emotional_tone", "stress_level", "closeness_level", "short_summary"]
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
                  properties: { value: { type: "string" }, explicit: { type: "boolean" }, confidence: { type: "string", enum: ["low","medium","high"] } },
                  required: ["value","explicit","confidence"]
                },
                preferred_addressing: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: { value: { type: "string" }, explicit: { type: "boolean" }, confidence: { type: "string", enum: ["low","medium","high"] } },
                  required: ["value","explicit","confidence"]
                },
                preferred_pronoun: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: { value: { type: "string" }, explicit: { type: "boolean" }, confidence: { type: "string", enum: ["low","medium","high"] } },
                  required: ["value","explicit","confidence"]
                },
                first_name: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: { value: { type: "string" }, explicit: { type: "boolean" }, confidence: { type: "string", enum: ["low","medium","high"] } },
                  required: ["value","explicit","confidence"]
                },
                occupation: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: { value: { type: "string" }, explicit: { type: "boolean" }, confidence: { type: "string", enum: ["low","medium","high"] } },
                  required: ["value","explicit","confidence"]
                },
                relationship_status: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: { value: { type: "string" }, explicit: { type: "boolean" }, confidence: { type: "string", enum: ["low","medium","high"] } },
                  required: ["value","explicit","confidence"]
                },
                age: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: { value: { type: "integer", minimum: 10, maximum: 110 }, explicit: { type: "boolean" }, confidence: { type: "string", enum: ["low","medium","high"] } },
                  required: ["value","explicit","confidence"]
                },
                conversation_style: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: { value: { type: "string" }, explicit: { type: "boolean" }, confidence: { type: "string", enum: ["low","medium","high"] } },
                  required: ["value","explicit","confidence"]
                }
              },
              required: [
                "preferred_name",
                "preferred_addressing",
                "preferred_pronoun",
                "first_name",
                "occupation",
                "relationship_status",
                "age",
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
      required: ["relationship", "session", "profile_patch"]
    };

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.MEMORY_MODEL || "gpt-4o-mini",
        input: [
          { role: "system", content: system },
          { role: "user", content: userMsg }
        ],
        temperature: 0.2,
        text: {
          format: {
            type: "json_schema",
            name: "sophie_memory_v4",
            strict: true,
            schema
          }
        },
        truncation: "auto"
      })
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      // Session error log (best effort)
      try {
        await supabase.from("user_sessions").insert({
          user_id: user.id,
          session_date: new Date().toISOString(),
          emotional_tone: "error",
          stress_level: null,
          closeness_level: null,
          short_summary: `Memory model error (HTTP ${r.status}). ${String(errText).replace(/\s+/g, " ").slice(0, 220)} duration=${secondsUsed}s`.slice(0, 300),
        });
      } catch (_) {}

      return res.status(r.status).json({ error: errText });
    }

    const out = await r.json();
    const outputText =
      out?.output_text ||
      out?.output?.[0]?.content?.find?.((c) => c.type === "output_text")?.text ||
      "";

    let parsed;
    try {
      parsed = JSON.parse(String(outputText || "").trim());
    } catch {
      // Session error log (best effort)
      try {
        await supabase.from("user_sessions").insert({
          user_id: user.id,
          session_date: new Date().toISOString(),
          emotional_tone: "error",
          stress_level: null,
          closeness_level: null,
          short_summary: `Bad JSON from model. duration=${secondsUsed}s`.slice(0, 300),
        });
      } catch (_) {}

      return res.status(200).json({ ok: false, skipped: true, reason: "Bad JSON" });
    }

    const setObj = parsed?.profile_patch?.set || {};
    const addObj = parsed?.profile_patch?.add || {};
    const existing = profile || {};
    const updates = {};
    let anyExplicit = false;

    // --- Addressing guardrail: du/sie NEVER as addressing ---
    const addr = setObj.preferred_addressing;
    if (addr && addr !== null && addr.explicit === true) {
      const v = String(addr.value || "").trim();
      const lv = v.toLowerCase();
      if (lv === "du" || lv === "sie") {
        updates.preferred_pronoun = lv;
        anyExplicit = true;
      } else if (v) {
        updates.preferred_addressing = v.slice(0, 80);
        anyExplicit = true;
      }
    }

    const pron = setObj.preferred_pronoun;
    if (pron && pron !== null && pron.explicit === true) {
      const v = String(pron.value || "").toLowerCase().trim();
      if (v === "du" || v === "sie") {
        updates.preferred_pronoun = v;
        anyExplicit = true;
      }
    }

    const pname = setObj.preferred_name;
    if (pname && pname !== null && pname.explicit === true) {
      const v = String(pname.value || "").trim();
      if (v) { updates.preferred_name = v.slice(0, 80); anyExplicit = true; }
    }

    const fn = setObj.first_name;
    if (fn && fn !== null && fn.explicit === true) {
      const v = String(fn.value || "").trim();
      if (v) { updates.first_name = v.slice(0, 80); anyExplicit = true; }
    }

    const occ = setObj.occupation;
    if (occ && occ !== null && occ.explicit === true) {
      const v = String(occ.value || "").trim();
      if (v) { updates.occupation = v.slice(0, 120); anyExplicit = true; }
    }

    const rs = setObj.relationship_status;
    if (rs && rs !== null && rs.explicit === true) {
      const v = String(rs.value || "").trim();
      if (v) { updates.relationship_status = v.slice(0, 80); anyExplicit = true; }
    }

    const age = setObj.age;
    if (age && age !== null && age.explicit === true && Number.isInteger(age.value)) {
      updates.age = age.value;
      anyExplicit = true;
    }

    const cs = setObj.conversation_style;
    if (cs && cs !== null && cs.explicit === true) {
      const v = String(cs.value || "").trim();
      if (v) { updates.conversation_style = v.slice(0, 120); anyExplicit = true; }
    }

    // Topics add-only union
    if (Array.isArray(addObj.topics_like)) {
      const filtered = addObj.topics_like.filter((t) => {
        const s = String(t || "").toLowerCase();
        // hard block: prevent job/status/name leakage into topics
        if (s.includes("zahntechn")) return false;
        if (s.includes("verheirat")) return false;
        if (s.includes("michael")) return false;
        if (s.includes("michi")) return false;
        return true;
      });
      updates.topics_like = mergeTopics(existing.topics_like, filtered);
    }
    if (Array.isArray(addObj.topics_avoid)) {
      updates.topics_avoid = mergeTopics(existing.topics_avoid, addObj.topics_avoid);
    }

    if (Object.keys(updates).length > 0) {
      if (anyExplicit) updates.last_confirmed_at = new Date().toISOString();

      const { error: upErr } = await supabase
        .from("user_profile")
        .upsert({ user_id: user.id, ...updates }, { onConflict: "user_id" });

      if (upErr) {
        console.error("user_profile upsert failed:", upErr.message);
        return res.status(500).json({ error: `user_profile upsert failed: ${upErr.message}` });
      }
    }

    // Relationship update (best effort)
    try {
      const relOut = parsed.relationship || {};
      await supabase.from("user_relationship").update({
        tone_baseline: String(relOut.tone_baseline || rel?.tone_baseline || "").slice(0, 200),
        openness_level: String(relOut.openness_level || rel?.openness_level || "").slice(0, 50),
        emotional_patterns: String(relOut.emotional_patterns || rel?.emotional_patterns || "").slice(0, 500),
        last_interaction_summary: String(relOut.last_interaction_summary || rel?.last_interaction_summary || "").slice(0, 600),
        updated_at: new Date().toISOString(),
      }).eq("user_id", user.id);
    } catch (_) {}

    // Session log (best effort)
    try {
      const s = parsed.session || {};
      await supabase.from("user_sessions").insert({
        user_id: user.id,
        session_date: new Date().toISOString(),
        emotional_tone: String(s.emotional_tone || "unknown").slice(0, 50),
        stress_level: Number.isFinite(s.stress_level) ? s.stress_level : null,
        closeness_level: Number.isFinite(s.closeness_level) ? s.closeness_level : null,
        short_summary: String(s.short_summary || "").slice(0, 300),
      });
    } catch (_) {}

    return res.status(200).json({
      ok: true,
      profile_updated: Object.keys(updates).length > 0,
      profile_fields_updated: Object.keys(updates),
    });
  } catch (err) {
    console.error("memory-update fatal:", err?.message || err, err?.stack || "");
    return res.status(500).json({ error: String(err?.message || err || "Internal error") });
  }
}
