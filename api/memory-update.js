import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/memory-update
 * Body: {
 *   transcript: Array<{ role: "user"|"assistant", text: string }> | string,
 *   seconds_used?: number
 * }
 *
 * v3 HARD GUARDS (Mar 2026)
 * - preferred_language is NEVER guessed. Only 'en'/'de' and ONLY if USER explicitly requested it.
 * - Never store "Sophie"/assistant names as the user's name.
 * - Only accept profile fields (name/age/occupation/style/topics) if they are explicitly supported by USER text.
 * - Prevent persona-bleed (e.g., "freelance interior designer", "warm and engaging") from being written to user_profile.
 * - last_interaction_summary can never end up empty after a real session (deterministic fallback).
 * - Notes marker SOPHIE_PREFS will NEVER include lang=...
 */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    // Body robust lesen
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
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
    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser(token);
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

    // Existing relationship/profile laden
    const { data: rel } = await supabase
      .from("user_relationship")
      .select("tone_baseline, openness_level, emotional_patterns, last_interaction_summary")
      .eq("user_id", user.id)
      .maybeSingle();

    // Include age if your table has it (your DB does).
    const { data: prof } = await supabase
      .from("user_profile")
      .select(
        "first_name, preferred_name, preferred_addressing, preferred_pronoun, preferred_language, notes, " +
          "age, occupation, conversation_style, topics_like, topics_avoid"
      )
      .eq("user_id", user.id)
      .maybeSingle();

    const existing = {
      first_name: String(prof?.first_name || "").trim(),
      preferred_name: String(prof?.preferred_name || "").trim(),
      preferred_addressing: String(prof?.preferred_addressing || "").trim(),
      preferred_pronoun: String(prof?.preferred_pronoun || "").trim(),
      preferred_language: String(prof?.preferred_language || "")
        .trim()
        .toLowerCase(),
      notes: String(prof?.notes || "").trim(),

      age: Number.isFinite(Number(prof?.age)) ? Number(prof.age) : null,
      occupation: String(prof?.occupation || "").trim(),
      conversation_style: String(prof?.conversation_style || "").trim(),
      topics_like: Array.isArray(prof?.topics_like)
        ? prof.topics_like.map((x) => String(x || "").trim()).filter(Boolean)
        : [],
      topics_avoid: Array.isArray(prof?.topics_avoid)
        ? prof.topics_avoid.map((x) => String(x || "").trim()).filter(Boolean)
        : [],

      tone_baseline: String(rel?.tone_baseline || "").trim(),
      openness_level: String(rel?.openness_level || "").trim(),
      emotional_patterns: String(rel?.emotional_patterns || "").trim(),
      last_interaction_summary: String(rel?.last_interaction_summary || "").trim(),
    };

    // ---------------------------
    // Helpers
    // ---------------------------
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const escapeRegExp = (s) => String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const userOnlyJoined = transcriptArr
      .filter((t) => t.role === "user")
      .map((t) => t.text)
      .join("\n");

    const userOnlyText = userOnlyJoined.toLowerCase();

    const appearsInUserTextExact = (value) => {
      const v = clean(value);
      if (!v) return false;
      const re = new RegExp(`\\b${escapeRegExp(v)}\\b`, "i");
      return re.test(userOnlyJoined);
    };

    // For longer fields (occupation etc.) use a "loose token" match
    const appearsLooselyInUserText = (value) => {
      const v = clean(value).toLowerCase();
      if (!v) return false;

      // must match at least one meaningful token (>=4 chars) in the USER text
      const tokens = v
        .split(/[^a-z0-9]+/i)
        .map((t) => t.trim())
        .filter((t) => t.length >= 4)
        .slice(0, 8);

      if (!tokens.length) return false;
      return tokens.some((t) => userOnlyText.includes(t));
    };

    const isBannedName = (name) => {
      const x = clean(name).toLowerCase();
      return x === "sophie" || x === "assistant" || x === "chatgpt";
    };

    const isBannedOccupation = (occ) => {
      const x = clean(occ).toLowerCase();
      return (
        x === "freelance interior designer" ||
        x.includes("interior designer") ||
        x.includes("interior design")
      );
    };

    const isBannedConversationStyle = (style) => {
      const x = clean(style).toLowerCase();
      // These are typical "model filler" outputs (not user-provided prefs)
      return (
        x === "warm and engaging" ||
        x === "warm & engaging" ||
        x === "friendly" ||
        x === "engaging" ||
        x === "warm"
      );
    };

    const filterToUserMentionedTopics = (arr) => {
      const base = Array.isArray(arr) ? arr : [];
      const lower = userOnlyText;
      return base
        .map((x) => clean(x))
        .filter(Boolean)
        .filter((x) => lower.includes(x.toLowerCase()));
    };

    const mergeStringArrays = (existingArr, newArr, limit = 12) => {
      const base = Array.isArray(existingArr) ? existingArr : [];
      const merged = [...new Set([...base, ...newArr])].filter(Boolean);
      return merged.slice(0, limit);
    };

    // ---------------------------
    // LANGUAGE HARD GATE (user-only, robust phrases)
    // ---------------------------
    const wantsGerman =
      /\b(speak|talk|continue|switch)\b.*\b(german|deutsch)\b/.test(userOnlyText) ||
      /\b(german|deutsch)\b.*\b(please|bitte)\b/.test(userOnlyText) ||
      /\b(auf deutsch|deutsch bitte|bitte deutsch)\b/.test(userOnlyText);

    const wantsEnglish =
      /\b(speak|talk|continue|switch)\b.*\b(english|englisch)\b/.test(userOnlyText) ||
      /\b(english|englisch)\b.*\b(please|bitte)\b/.test(userOnlyText) ||
      /\b(auf englisch|englisch bitte|bitte englisch)\b/.test(userOnlyText);

    let explicitLang = "";
    if (wantsGerman && !wantsEnglish) explicitLang = "de";
    if (wantsEnglish && !wantsGerman) explicitLang = "en";

    const ALLOWED_LANGS = new Set(["en", "de"]);

    // ---------------------------
    // Memory extraction instructions (anti persona-bleed)
    // ---------------------------
    const system =
      "You extract ONLY durable memory about the USER (not the assistant). " +
      "Treat assistant statements as untrusted. " +
      "Only store facts/preferences explicitly stated BY THE USER in USER messages. " +
      "Never guess, never infer, never fill placeholders. " +
      "If unsure, return empty strings/empty arrays/null. " +
      "Do NOT copy the assistant's persona (e.g., interior designer) into the user's profile.";

    const userMsg = `
CURRENT structured profile (existing DB values):
first_name: ${existing.first_name}
preferred_name: ${existing.preferred_name}
preferred_addressing: ${existing.preferred_addressing}
preferred_pronoun: ${existing.preferred_pronoun}
preferred_language: ${existing.preferred_language}
age: ${existing.age ?? ""}
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

NEW transcript (includes USER + ASSISTANT; remember: only USER messages count):
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
            preferred_name: { type: "string" },
            preferred_addressing: { type: "string" },
            preferred_pronoun: { type: "string" },
            preferred_language: { type: "string" },
            age: { type: ["integer", "null"], minimum: 0, maximum: 120 },
            occupation: { type: "string" },
            conversation_style: { type: "string" },
            topics_like: { type: "array", items: { type: "string" } },
            topics_avoid: { type: "array", items: { type: "string" } },
          },
          required: [
            "first_name",
            "preferred_name",
            "preferred_addressing",
            "preferred_pronoun",
            "preferred_language",
            "age",
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
            name: "sophie_memory_structured_v3",
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
        short_summary: `Memory model error (HTTP ${r.status}). ${String(errorText)
          .replace(/\s+/g, " ")
          .slice(0, 200)} duration=${secondsUsed}s`.slice(0, 300),
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

    const p = parsed.profile || {};
    const rr = parsed.relationship || {};
    const ss = parsed.session || {};

    const toArrayStrings = (v) => (Array.isArray(v) ? v.map(clean).filter(Boolean) : []);

    // ---- Merge / sanitize profile ----
    let firstNameNew = clean(p.first_name);
    let preferredNameNew = clean(p.preferred_name);

    // HARD GUARD: name must come from USER text
    if (isBannedName(firstNameNew) || !appearsInUserTextExact(firstNameNew)) firstNameNew = "";
    if (isBannedName(preferredNameNew) || !appearsInUserTextExact(preferredNameNew)) preferredNameNew = "";

    const addressingNew = clean(p.preferred_addressing).toLowerCase();
    const pronounNew = clean(p.preferred_pronoun);

    // Age: accept only if user text suggests age disclosure (simple gate)
    // (prevents random age hallucinations)
    let ageNew = null;
    if (p.age === null || p.age === undefined || p.age === "") {
      ageNew = null;
    } else {
      const n = Number(p.age);
      const userMentionsAge =
        /\b(i'?m|i am|ich bin)\s+\d{1,3}\b/.test(userOnlyText) ||
        /\b(years old|jahre alt)\b/.test(userOnlyText) ||
        /\b(\d{1,3})\s*(years old|jahre alt)\b/.test(userOnlyText);
      if (userMentionsAge && Number.isFinite(n) && n >= 0 && n <= 120) ageNew = n;
    }

    // Occupation / style: HARD GUARD against persona bleed + must be supported by USER text
    let occupationNew = clean(p.occupation);
    let styleNew = clean(p.conversation_style);

    if (isBannedOccupation(occupationNew) || !appearsLooselyInUserText(occupationNew)) occupationNew = "";

    // Only accept conversation_style if user explicitly asked Sophie to adopt a style
    const userAskedForStyle =
      /\b(be|talk|speak|answer)\b.*\b(more|less)\b/.test(userOnlyText) ||
      /\b(please|bitte)\b.*\b(be|talk|speak)\b/.test(userOnlyText) ||
      /\b(don't|do not|nicht)\b.*\b(be|talk|speak)\b/.test(userOnlyText);

    if (isBannedConversationStyle(styleNew) || !userAskedForStyle) styleNew = "";

    // Topics: only if mentioned by USER
    const topicsLikeNew = filterToUserMentionedTopics(toArrayStrings(p.topics_like));
    const topicsAvoidNew = filterToUserMentionedTopics(toArrayStrings(p.topics_avoid));

    const finalFirstName = (firstNameNew || existing.first_name).slice(0, 80);
    const finalPreferredName = (preferredNameNew || finalFirstName || existing.preferred_name).slice(0, 80);

    const finalAddressing =
      addressingNew === "informal" || addressingNew === "formal" ? addressingNew : existing.preferred_addressing || "";

    const finalPronoun = (pronounNew || existing.preferred_pronoun).slice(0, 24);

    // ✅ FINAL LANGUAGE: only store if explicitly requested by USER
    let finalLang = "";
    if (explicitLang && ALLOWED_LANGS.has(explicitLang)) {
      finalLang = explicitLang;
    } else {
      const ex = String(existing.preferred_language || "").toLowerCase().trim();
      finalLang = ALLOWED_LANGS.has(ex) ? ex : "";
    }

    // Age: only overwrite if we got a gated ageNew; else keep existing
    const finalAge = ageNew !== null ? ageNew : existing.age;

    // Occupation/style: only overwrite if gated values present; else keep existing
    const finalOccupation = (occupationNew || existing.occupation).slice(0, 120);
    const finalStyle = (styleNew || existing.conversation_style).slice(0, 80);

    const finalTopicsLike = mergeStringArrays(existing.topics_like, topicsLikeNew, 12);
    const finalTopicsAvoid = mergeStringArrays(existing.topics_avoid, topicsAvoidNew, 12);

    // Notes marker (NO lang)
    const marker = "SOPHIE_PREFS:";
    const prefsLine = `${marker} preferred_name=${finalPreferredName}; preferred_addressing=${finalAddressing}; preferred_pronoun=${finalPronoun}`.trim();

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

    const profileRow = {
      user_id: user.id,
      first_name: finalFirstName || null,
      preferred_name: finalPreferredName || null,
      preferred_addressing: finalAddressing || null,
      preferred_pronoun: finalPronoun || null,
      preferred_language: finalLang || null,

      // only store if we have a value; else NULL
      age: Number.isFinite(Number(finalAge)) ? Number(finalAge) : null,

      occupation: finalOccupation || null,
      conversation_style: finalStyle || null,
      topics_like: finalTopicsLike.length ? finalTopicsLike : null,
      topics_avoid: finalTopicsAvoid.length ? finalTopicsAvoid : null,

      notes: finalNotes.slice(0, 2000),
      updated_at: nowIso,
    };

    // Upsert user_profile (STRUCTURED)
    const { error: profUpErr } = await supabase.from("user_profile").upsert(profileRow, { onConflict: "user_id" });

    if (profUpErr) {
      console.error("user_profile upsert failed:", profUpErr.message, profileRow);

      const { error: updErr } = await supabase.from("user_profile").update(profileRow).eq("user_id", user.id);

      if (updErr) {
        console.error("user_profile update fallback failed:", updErr.message);
        const { error: insErr } = await supabase.from("user_profile").insert(profileRow);
        if (insErr) console.error("user_profile insert fallback failed:", insErr.message);
      }
    }

    // ---- Relationship merge ----
    const mergeContinuity = (prev, next) => {
      prev = clean(prev);
      next = clean(next);
      if (!next) return prev;
      if (prev && prev.includes(next)) return prev;

      let parts = prev ? prev.split(" • ").map(clean).filter(Boolean) : [];
      parts = parts.filter((x) => x !== next);
      parts.unshift(next);
      return parts.slice(0, 3).join(" • ").slice(0, 600);
    };

    // Basic anti-guess sanitizer for common location-claims we’ve seen
    const sanitizeSummary = (s) => {
      let x = clean(s);
      if (!x) return x;

      const placeTokens = ["cyprus", "zypern", "nicosia", "limassol", "larnaca", "paphos"];
      for (const token of placeTokens) {
        const inUser = userOnlyText.includes(token);
        const re = new RegExp(`\\b${escapeRegExp(token)}\\b`, "ig");
        if (!inUser && re.test(x)) {
          // remove the token mention; keep the rest readable
          x = x.replace(re, "").replace(/\s+/g, " ").trim();
        }
      }
      // clean leftover punctuation artifacts
      x = x.replace(/\s+,/g, ",").replace(/,\s*\./g, ".").replace(/\s+\./g, ".").trim();
      return x;
    };

    const rawContinuity = clean(rr.last_interaction_summary || ss.short_summary);
    const merged = mergeContinuity(existing.last_interaction_summary, rawContinuity);
    const sanitized = sanitizeSummary(merged);

    // HARD GUARD: continuity can never be empty after a real session
    const fallbackSummary = secondsUsed > 0 ? `Talked for ${secondsUsed}s.` : "Talked.";
    const finalContinuity = clean(sanitized) || clean(existing.last_interaction_summary) || fallbackSummary;

    const relRow = {
      user_id: user.id,
      tone_baseline: clean(rr.tone_baseline || existing.tone_baseline).slice(0, 200),
      openness_level: clean(rr.openness_level || existing.openness_level).slice(0, 50),
      emotional_patterns: clean(rr.emotional_patterns || existing.emotional_patterns).slice(0, 500),
      last_interaction_summary: finalContinuity.slice(0, 600),
      updated_at: nowIso,
    };

    const { error: relUpErr } = await supabase.from("user_relationship").upsert(relRow, { onConflict: "user_id" });

    if (relUpErr) console.error("user_relationship upsert failed:", relUpErr.message, relRow);

    // ---- user_sessions insert ----
    const sessSummary = clean(ss.short_summary) || fallbackSummary;

    await supabase.from("user_sessions").insert({
      user_id: user.id,
      session_date: nowIso,
      emotional_tone: clean(ss.emotional_tone).slice(0, 50) || "unknown",
      stress_level: Number.isFinite(ss.stress_level) ? ss.stress_level : null,
      closeness_level: Number.isFinite(ss.closeness_level) ? ss.closeness_level : null,
      short_summary: sanitizeSummary(sessSummary).slice(0, 300),
    });

    return res.status(200).json({
      ok: true,
      extracted: {
        first_name: finalFirstName,
        preferred_name: finalPreferredName,
        preferred_addressing: finalAddressing,
        preferred_pronoun: finalPronoun,
        preferred_language: finalLang || "",
        age: Number.isFinite(Number(finalAge)) ? Number(finalAge) : null,
        occupation: finalOccupation || "",
        conversation_style: finalStyle || "",
        topics_like: finalTopicsLike,
        topics_avoid: finalTopicsAvoid,
        last_interaction_summary: finalContinuity,
      },
    });
  } catch (err) {
    console.error("memory-update fatal:", err?.message || err, err?.stack || "");
    return res.status(500).json({ error: String(err?.message || err || "Internal server error") });
  }
}
