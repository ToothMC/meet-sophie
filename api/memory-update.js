import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/memory-update
 * Body: {
 *   transcript: Array<{ role: "user"|"assistant"|string, text: string }> | string,
 *   seconds_used?: number
 * }
 *
 * v4 (Mar 2026) – RLS-correct + hard guards
 * - Uses SUPABASE_ANON_KEY + Authorization Bearer user JWT so auth.uid() works (RLS policies pass)
 * - Never guess preferred_language (only 'en'/'de' if USER explicitly requested)
 * - Never store "Sophie"/assistant as user's name
 * - Deterministic name + nickname extraction from USER text (regex fallback): "Michael/Michi" always saves
 * - Prevent persona bleed into user_profile (occupation/style)
 * - Topics only if user actually mentioned them
 * - last_interaction_summary can never be empty after a real session
 * - Strict role mapping: ONLY role==="user" counts as USER text; everything else is not USER
 */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    // ---- Robust body parsing ----
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    body = body && typeof body === "object" ? body : {};

    // ---- Auth token ----
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing Authorization Bearer token" });

    // ---- Env checks ----
    if (!process.env.SUPABASE_URL) return res.status(500).json({ error: "Missing SUPABASE_URL" });
    if (!process.env.SUPABASE_ANON_KEY) return res.status(500).json({ error: "Missing SUPABASE_ANON_KEY" });
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    // ---- Supabase client WITH user JWT so auth.uid() works for RLS ----
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });

    // Validate user from JWT (now uses the header in the client)
    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();

    if (userErr || !user) return res.status(401).json({ error: "Invalid token" });

    const secondsUsed = Number(body.seconds_used ?? 0) || 0;
    const nowIso = new Date().toISOString();

    // ---- Transcript normalization with strict role mapping ----
    const rawTranscript = body.transcript;
    let transcriptArr = [];

    if (Array.isArray(rawTranscript)) {
      transcriptArr = rawTranscript
        .map((t) => {
          const roleRaw = String(t?.role || "").toLowerCase();
          const role = roleRaw === "assistant" ? "assistant" : roleRaw === "user" ? "user" : "other";
          return { role, text: String(t?.text || "").trim() };
        })
        .filter((t) => t.text.length > 0);
    } else if (typeof rawTranscript === "string" && rawTranscript.trim()) {
      transcriptArr = [{ role: "user", text: rawTranscript.trim() }];
    }

    // Only feed user+assistant into the model, never "other"
    const transcriptText = transcriptArr
      .filter((t) => t.role === "user" || t.role === "assistant")
      .slice(-80)
      .map((t) => `${t.role.toUpperCase()}: ${t.text.slice(0, 2000)}`)
      .join("\n");

    const baseSession = { user_id: user.id, session_date: nowIso };

    if (!transcriptText || transcriptText.trim().length < 10) {
      const { error: sessErr } = await supabase.from("user_sessions").insert({
        ...baseSession,
        emotional_tone: "unknown",
        stress_level: null,
        closeness_level: null,
        short_summary: `No transcript captured. duration=${secondsUsed}s`.slice(0, 300),
      });
      if (sessErr) console.error("user_sessions insert failed:", sessErr);
      return res.status(200).json({ ok: true, skipped: true, reason: "No transcript" });
    }

    // USER-only text (the only trusted source for durable memory)
    const userOnlyJoined = transcriptArr
      .filter((t) => t.role === "user")
      .map((t) => t.text)
      .join("\n");
    const userOnlyText = userOnlyJoined.toLowerCase();

    // ---- Load existing rows (optional) ----
    const { data: rel, error: relSelErr } = await supabase
      .from("user_relationship")
      .select("tone_baseline, openness_level, emotional_patterns, last_interaction_summary")
      .eq("user_id", user.id)
      .maybeSingle();
    if (relSelErr) console.error("user_relationship select failed:", relSelErr);

    const { data: prof, error: profSelErr } = await supabase
      .from("user_profile")
      .select(
        "first_name, preferred_name, preferred_addressing, preferred_pronoun, preferred_language, notes," +
          "age, occupation, conversation_style, topics_like, topics_avoid, memory_confidence"
      )
      .eq("user_id", user.id)
      .maybeSingle();
    if (profSelErr) console.error("user_profile select failed:", profSelErr);

    const existing = {
      first_name: String(prof?.first_name || "").trim(),
      preferred_name: String(prof?.preferred_name || "").trim(),
      preferred_addressing: String(prof?.preferred_addressing || "").trim(),
      preferred_pronoun: String(prof?.preferred_pronoun || "").trim(),
      preferred_language: String(prof?.preferred_language || "").trim().toLowerCase(),
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

    const appearsInUserTextExact = (value) => {
      const v = clean(value);
      if (!v) return false;
      const re = new RegExp(`\\b${escapeRegExp(v)}\\b`, "i");
      return re.test(userOnlyJoined);
    };

    // For longer fields, match at least one meaningful token (>=4 chars)
    const appearsLooselyInUserText = (value) => {
      const v = clean(value).toLowerCase();
      if (!v) return false;
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
      // typical model filler outputs
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
      return base
        .map((x) => clean(x))
        .filter(Boolean)
        .filter((x) => userOnlyText.includes(x.toLowerCase()));
    };

    const mergeStringArrays = (existingArr, newArr, limit = 12) => {
      const base = Array.isArray(existingArr) ? existingArr : [];
      const merged = [...new Set([...base, ...newArr])].filter(Boolean);
      return merged.slice(0, limit);
    };

    // Deterministic fallback: extract first name + nickname from USER text
    function extractNameFromUserText(userTextRaw) {
      const txt = String(userTextRaw || "").trim();
      if (!txt) return { first: "", nick: "" };

      const t = txt.replace(/[“”„]/g, '"').replace(/[’]/g, "'");

      const pickWord = (s) => {
        const m = String(s || "")
          .trim()
          .match(/^[A-Za-zÀ-ÖØ-öø-ÿÄÖÜäöüß'\-]{2,30}$/);
        return m ? m[0] : "";
      };

      // English
      const enFirst =
        t.match(/\b(?:my name is|i am|i'm|call me)\s+([A-Za-zÀ-ÖØ-öø-ÿÄÖÜäöüß'\-]{2,30})\b/i) || null;
      const enNick =
        t.match(/\b(?:nickname is|you can call me|people call me)\s+([A-Za-zÀ-ÖØ-öø-ÿÄÖÜäöüß'\-]{2,30})\b/i) ||
        null;

      // German
      const deFirst =
        t.match(/\b(?:ich hei(?:ß|ss)e|ich bin|mein name ist)\s+([A-Za-zÀ-ÖØ-öø-ÿÄÖÜäöüß'\-]{2,30})\b/i) || null;
      const deNick =
        t.match(
          /\b(?:mein\s+spitzname\s+ist|spitzname\s*ist|nenn(?:t)?\s*mich|du kannst mich)\s+([A-Za-zÀ-ÖØ-öø-ÿÄÖÜäöüß'\-]{2,30})\b/i
        ) || null;

      let first = pickWord((enFirst && enFirst[1]) || (deFirst && deFirst[1]) || "");
      let nick = pickWord((enNick && enNick[1]) || (deNick && deNick[1]) || "");

      if (!nick) {
        const m = t.match(/\b(?:nickname|spitzname)\b[:\s-]*([A-Za-zÀ-ÖØ-öø-ÿÄÖÜäöüß'\-]{2,30})\b/i);
        if (m) nick = pickWord(m[1]);
      }
      return { first, nick };
    }

    // ---------------------------
    // Language hard gate (only if USER explicitly asked)
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
    // OpenAI extraction
    // ---------------------------
    const system =
      "You extract ONLY durable memory about the USER (not the assistant). " +
      "Treat assistant statements as untrusted. " +
      "Only store facts/preferences explicitly stated BY THE USER in USER messages. " +
      "Never guess, never infer, never fill placeholders. If unsure, return empty strings/empty arrays/null. " +
      "Do NOT copy the assistant persona (e.g., interior designer) into the user's profile.";

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
            name: "sophie_memory_structured_v4",
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

      const { error: sessErr } = await supabase.from("user_sessions").insert({
        ...baseSession,
        emotional_tone: "error",
        stress_level: null,
        closeness_level: null,
        short_summary: `Memory model error (HTTP ${r.status}). ${String(errorText)
          .replace(/\s+/g, " ")
          .slice(0, 200)} duration=${secondsUsed}s`.slice(0, 300),
      });
      if (sessErr) console.error("user_sessions insert (error) failed:", sessErr);

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
      console.error("Bad JSON from memory model:", text);

      const { error: sessErr } = await supabase.from("user_sessions").insert({
        ...baseSession,
        emotional_tone: "error",
        stress_level: null,
        closeness_level: null,
        short_summary: `Bad JSON from model. duration=${secondsUsed}s`.slice(0, 300),
      });
      if (sessErr) console.error("user_sessions insert (bad json) failed:", sessErr);

      return res.status(200).json({ ok: false, skipped: true, reason: "Bad JSON" });
    }

    const p = parsed.profile || {};
    const rr = parsed.relationship || {};
    const ss = parsed.session || {};

    const toArrayStrings = (v) => (Array.isArray(v) ? v.map(clean).filter(Boolean) : []);

    // ---------------------------
    // PROFILE: merge + hard gates + deterministic name fallback
    // ---------------------------
    let firstNameNew = clean(p.first_name);
    let preferredNameNew = clean(p.preferred_name);

    // Deterministic fallback if model is empty/overcautious
    const extracted = extractNameFromUserText(userOnlyJoined);
    if (!firstNameNew && extracted.first) firstNameNew = extracted.first;
    if (!preferredNameNew && extracted.nick) preferredNameNew = extracted.nick;

    // Name hard gates
    if (isBannedName(firstNameNew) || !appearsInUserTextExact(firstNameNew)) firstNameNew = "";
    if (isBannedName(preferredNameNew) || !appearsInUserTextExact(preferredNameNew)) preferredNameNew = "";

    const addressingNew = clean(p.preferred_addressing).toLowerCase();
    const pronounNew = clean(p.preferred_pronoun);

    // Age gate (avoid hallucinations)
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

    // Occupation / style gates (anti persona bleed)
    let occupationNew = clean(p.occupation);
    let styleNew = clean(p.conversation_style);

    if (isBannedOccupation(occupationNew) || !appearsLooselyInUserText(occupationNew)) occupationNew = "";

    const userAskedForStyle =
      /\b(be|talk|speak|answer)\b.*\b(more|less)\b/.test(userOnlyText) ||
      /\b(please|bitte)\b.*\b(be|talk|speak)\b/.test(userOnlyText) ||
      /\b(don't|do not|nicht)\b.*\b(be|talk|speak)\b/.test(userOnlyText);

    if (isBannedConversationStyle(styleNew) || !userAskedForStyle) styleNew = "";

    // Topics only if user mentioned
    const topicsLikeNew = filterToUserMentionedTopics(toArrayStrings(p.topics_like));
    const topicsAvoidNew = filterToUserMentionedTopics(toArrayStrings(p.topics_avoid));

    const finalFirstName = (firstNameNew || existing.first_name).slice(0, 80);
    const finalPreferredName = (preferredNameNew || finalFirstName || existing.preferred_name).slice(0, 80);

    const finalAddressing =
      addressingNew === "informal" || addressingNew === "formal"
        ? addressingNew
        : existing.preferred_addressing || "";

    const finalPronoun = (pronounNew || existing.preferred_pronoun).slice(0, 24);

    // Language: only if explicitly requested by USER
    let finalLang = "";
    if (explicitLang && ALLOWED_LANGS.has(explicitLang)) {
      finalLang = explicitLang;
    } else {
      const ex = String(existing.preferred_language || "").toLowerCase().trim();
      finalLang = ALLOWED_LANGS.has(ex) ? ex : "";
    }

    const finalAge = ageNew !== null ? ageNew : existing.age;
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
      age: Number.isFinite(Number(finalAge)) ? Number(finalAge) : null,
      occupation: finalOccupation || null,
      conversation_style: finalStyle || null,
      topics_like: finalTopicsLike.length ? finalTopicsLike : null,
      topics_avoid: finalTopicsAvoid.length ? finalTopicsAvoid : null,
      notes: finalNotes.slice(0, 2000),
      updated_at: nowIso,
      memory_confidence: prof?.memory_confidence || "medium",
    };

    const { error: profUpErr } = await supabase.from("user_profile").upsert(profileRow, { onConflict: "user_id" });
    if (profUpErr) {
      console.error("user_profile upsert failed:", profUpErr);
      // HARD FAIL so you can see it immediately
      return res.status(500).json({ error: "user_profile upsert failed", detail: profUpErr.message });
    }

    // ---------------------------
    // RELATIONSHIP + SESSION
    // ---------------------------
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

    // Conservative sanitizer: remove Cyprus/Zypern mentions unless USER text contains them
    const sanitizeSummary = (s) => {
      let x = clean(s);
      if (!x) return x;

      const placeTokens = ["cyprus", "zypern", "nicosia", "limassol", "larnaca", "paphos"];
      for (const token of placeTokens) {
        const inUser = userOnlyText.includes(token);
        const re = new RegExp(`\\b${escapeRegExp(token)}\\b`, "ig");
        if (!inUser && re.test(x)) {
          x = x.replace(re, "").replace(/\s+/g, " ").trim();
        }
      }
      x = x.replace(/\s+,/g, ",").replace(/,\s*\./g, ".").replace(/\s+\./g, ".").trim();
      return x;
    };

    const rawContinuity = clean(rr.last_interaction_summary || ss.short_summary);
    const merged = mergeContinuity(existing.last_interaction_summary, rawContinuity);
    const sanitized = sanitizeSummary(merged);

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
    if (relUpErr) {
      console.error("user_relationship upsert failed:", relUpErr);
      // don't fail the whole request if relationship fails, but log it
    }

    const sessSummary = sanitizeSummary(clean(ss.short_summary) || fallbackSummary);

    const { error: sessErr } = await supabase.from("user_sessions").insert({
      user_id: user.id,
      session_date: nowIso,
      emotional_tone: clean(ss.emotional_tone).slice(0, 50) || "unknown",
      stress_level: Number.isFinite(ss.stress_level) ? ss.stress_level : null,
      closeness_level: Number.isFinite(ss.closeness_level) ? ss.closeness_level : null,
      short_summary: sessSummary.slice(0, 300),
    });
    if (sessErr) console.error("user_sessions insert failed:", sessErr);

    return res.status(200).json({
      ok: true,
      extracted: {
        first_name: profileRow.first_name,
        preferred_name: profileRow.preferred_name,
        preferred_language: profileRow.preferred_language,
        age: profileRow.age,
        occupation: profileRow.occupation,
        conversation_style: profileRow.conversation_style,
        topics_like: profileRow.topics_like,
        topics_avoid: profileRow.topics_avoid,
        last_interaction_summary: relRow.last_interaction_summary,
      },
    });
  } catch (err) {
    console.error("memory-update fatal:", err?.message || err, err?.stack || "");
    return res.status(500).json({ error: String(err?.message || err || "Internal server error") });
  }
}
