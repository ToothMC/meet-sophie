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
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

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
      .slice(-30)
      .map((t) => `${t.role.toUpperCase()}: ${t.text.slice(0, 2000)}`)
      .join("\n");

    if (!transcriptText.trim()) {
      return res.status(200).json({ ok: true, skipped: true, reason: "No transcript" });
    }

    // Aktuelles Profil laden (für union merge)
    const { data: profile, error: profErr } = await supabase
      .from("user_profile")
      .select("user_id, preferred_name, preferred_addressing, preferred_pronoun, age, conversation_style, topics_like, topics_avoid")
      .eq("user_id", user.id)
      .maybeSingle();

    if (profErr) {
      console.warn("user_profile select failed:", profErr.message);
    }

    const uniq = (arr) => Array.from(new Set((arr || []).map(x => String(x || "").trim()).filter(Boolean)));
    const mergeTopics = (oldArr, addArr) => uniq([...(oldArr || []), ...(addArr || [])]).slice(0, 30);

    const system =
      "You update Sophie memory.\n" +
      "Return ONLY a user_profile patch object.\n\n" +
      "CRITICAL RULES:\n" +
      "- preferred_addressing MUST be a nickname/name (e.g., 'Michi', 'Michael'). NEVER 'du' or 'sie'.\n" +
      "- preferred_pronoun is ONLY 'du' or 'sie'.\n" +
      "- Set sensitive fields only if the user explicitly states it (explicit=true).\n" +
      "- topics_like/topics_avoid: add only, never remove.\n" +
      "- If unsure, set the field to null and confidence low.\n";

    const userMsg = `
CURRENT user_profile:
preferred_name: ${profile?.preferred_name || ""}
preferred_addressing: ${profile?.preferred_addressing || ""}
preferred_pronoun: ${profile?.preferred_pronoun || ""}
age: ${profile?.age ?? ""}
conversation_style: ${profile?.conversation_style || ""}
topics_like: ${(profile?.topics_like || []).join(", ")}
topics_avoid: ${(profile?.topics_avoid || []).join(", ")}

NEW transcript:
${transcriptText}
`.trim();

    // ✅ Strict schema (valid)
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
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
                    confidence: { type: "string", enum: ["low", "medium", "high"] }
                  },
                  required: ["value", "explicit", "confidence"]
                },
                preferred_addressing: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: {
                    value: { type: "string" },
                    explicit: { type: "boolean" },
                    confidence: { type: "string", enum: ["low", "medium", "high"] }
                  },
                  required: ["value", "explicit", "confidence"]
                },
                preferred_pronoun: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: {
                    value: { type: "string" },
                    explicit: { type: "boolean" },
                    confidence: { type: "string", enum: ["low", "medium", "high"] }
                  },
                  required: ["value", "explicit", "confidence"]
                },
                age: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: {
                    value: { type: "integer", minimum: 10, maximum: 110 },
                    explicit: { type: "boolean" },
                    confidence: { type: "string", enum: ["low", "medium", "high"] }
                  },
                  required: ["value", "explicit", "confidence"]
                },
                conversation_style: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: {
                    value: { type: "string" },
                    explicit: { type: "boolean" },
                    confidence: { type: "string", enum: ["low", "medium", "high"] }
                  },
                  required: ["value", "explicit", "confidence"]
                }
              },
              required: ["preferred_name", "preferred_addressing", "preferred_pronoun", "age", "conversation_style"]
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
      required: ["profile_patch"]
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
            name: "sophie_profile_patch_v1",
            strict: true,
            schema
          }
        },
        truncation: "auto"
      })
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
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
    } catch (e) {
      return res.status(200).json({
        ok: false,
        skipped: true,
        reason: "Bad JSON from model",
        raw: String(outputText || "").slice(0, 500),
      });
    }

    const patch = parsed.profile_patch || { set: {}, add: {} };
    const setObj = patch.set || {};
    const addObj = patch.add || {};

    const existing = profile || {};
    const updates = {};
    let anyExplicit = false;

    // preferred_addressing (explicit-only) + guardrail du/sie -> pronoun
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

    // preferred_pronoun (explicit-only)
    const pron = setObj.preferred_pronoun;
    if (pron && pron !== null && pron.explicit === true) {
      const v = String(pron.value || "").toLowerCase().trim();
      if (v === "du" || v === "sie") {
        updates.preferred_pronoun = v;
        anyExplicit = true;
      }
    }

    // preferred_name (explicit-only)
    const pname = setObj.preferred_name;
    if (pname && pname !== null && pname.explicit === true) {
      const v = String(pname.value || "").trim();
      if (v) {
        updates.preferred_name = v.slice(0, 80);
        anyExplicit = true;
      }
    }

    // age (explicit-only)
    const age = setObj.age;
    if (age && age !== null && age.explicit === true && Number.isInteger(age.value)) {
      updates.age = age.value;
      anyExplicit = true;
    }

    // conversation_style (explicit-only)
    const cs = setObj.conversation_style;
    if (cs && cs !== null && cs.explicit === true) {
      const v = String(cs.value || "").trim();
      if (v) {
        updates.conversation_style = v.slice(0, 120);
        anyExplicit = true;
      }
    }

    // topics add-only (union)
    if (Array.isArray(addObj.topics_like)) {
      updates.topics_like = mergeTopics(existing.topics_like, addObj.topics_like);
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
