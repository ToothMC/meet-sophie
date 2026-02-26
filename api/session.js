import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing Authorization Bearer token" });

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) return res.status(401).json({ error: "Invalid token" });

    // ---------------------------
    // Premium / Usage
    // ---------------------------

    let isPremium = false;

    const { data: sub } = await supabase
      .from("user_subscriptions")
      .select("is_active, status")
      .eq("user_id", user.id)
      .maybeSingle();

    if (sub?.is_active || sub?.status === "active" || sub?.status === "trialing") {
      isPremium = true;
    }

    let remaining = 999999;

    if (!isPremium) {
      const { data: usage } = await supabase
        .from("user_usage")
        .select("free_seconds_total, free_seconds_used")
        .eq("user_id", user.id)
        .maybeSingle();

      const freeTotal = usage?.free_seconds_total ?? 900;
      const freeUsed = usage?.free_seconds_used ?? 0;
      remaining = Math.max(0, freeTotal - freeUsed);

      if (remaining <= 0) {
        return res.status(402).json({
          error: "Free limit reached",
          remaining_seconds: 0,
          is_premium: false,
        });
      }
    }

    // ---------------------------
    // Memory laden
    // ---------------------------

    let profile = {
      first_name: "",
      age: null,
      relationship_status: "",
      notes: "",
      preferred_language: "en"
    };

    let rel = {
      tone_baseline: "",
      openness_level: "",
      emotional_patterns: "",
      last_interaction_summary: "",
    };

    const { data: prof } = await supabase
      .from("user_profile")
      .select("first_name, age, relationship_status, notes, preferred_language")
      .eq("user_id", user.id)
      .maybeSingle();

    if (prof) {
      profile = {
        first_name: (prof.first_name || "").trim(),
        age: prof.age ?? null,
        relationship_status: (prof.relationship_status || "").trim(),
        notes: (prof.notes || "").trim(),
        preferred_language: (prof.preferred_language || "en").toLowerCase().trim()
      };
    }

    const { data: relData } = await supabase
      .from("user_relationship")
      .select("tone_baseline, openness_level, emotional_patterns, last_interaction_summary")
      .eq("user_id", user.id)
      .maybeSingle();

    if (relData) {
      rel = {
        tone_baseline: (relData.tone_baseline || "").trim(),
        openness_level: (relData.openness_level || "").trim(),
        emotional_patterns: (relData.emotional_patterns || "").trim(),
        last_interaction_summary: (relData.last_interaction_summary || "").trim(),
      };
    }

    // ---------------------------
    // SOPHIE_PREFS parsen
    // ---------------------------

    const prefsLine = (profile.notes || "")
      .split("\n")
      .find((ln) => ln.includes("SOPHIE_PREFS:")) || "";

    const prefs = {
      nickname: "",
      formality: "",
      lang: ""
    };

    if (prefsLine) {
      const mNick = prefsLine.match(/nickname=([^;]*)/i);
      const mForm = prefsLine.match(/formality=([^;]*)/i);
      const mLang = prefsLine.match(/lang=([^;]*)/i);

      prefs.nickname = (mNick?.[1] || "").trim();
      prefs.formality = (mForm?.[1] || "").trim();
      prefs.lang = (mLang?.[1] || "").trim().toLowerCase();
    }

    // Sprache aus Notes überschreibt DB-Feld
    let preferredLanguage = profile.preferred_language || "en";
    if (prefs.lang) preferredLanguage = prefs.lang;

    // Anzeigename bestimmen
    const displayName = prefs.nickname || profile.first_name || "";

    // ---------------------------
    // First Session Check
    // ---------------------------

    const isFirstSession =
      (!profile.first_name || profile.first_name === "") &&
      (!rel.last_interaction_summary || rel.last_interaction_summary === "");

    // ---------------------------
    // Prompt Blöcke
    // ---------------------------

    const startModeBlock = isFirstSession ? `
FIRST SESSION: START-MODE (ENGLISH)
- Run onboarding (60–90 seconds).
- Ask for name.
- Ask if informal is okay.
- Then transition naturally.
- Never repeat onboarding again.
` : `
NOT FIRST SESSION:
- Do NOT run onboarding.
- Continue normally.
`;

    const nameRuleBlock = `
NAME & ADDRESSING
- Preferred name: ${displayName || "(unknown)"}
- Nickname: ${prefs.nickname || "(none)"}
- Formality preference: ${prefs.formality || "(unknown)"}

Rules:
- If nickname exists, use it naturally.
- Otherwise use first_name.
- If formality=informal, stay informal.
- If formality=formal, use formal tone.
`;

    const languageBlock = preferredLanguage === "de" ? `
LANGUAGE
- Speak German by default.
- Switch only if user explicitly requests another language.
` : `
LANGUAGE
- Speak English by default.
- Switch only if user explicitly requests another language.
`;

    const memoryBlock = `
PRIVATE CONTEXT (do not mention):
first_name: ${profile.first_name || "(unknown)"}
nickname: ${prefs.nickname || "(none)"}
tone_baseline: ${rel.tone_baseline || "(none)"}
last_interaction_summary: ${rel.last_interaction_summary || "(none)"}
`;

    const sophiePrompt = `
You are Sophie.

${startModeBlock}

${languageBlock}

${nameRuleBlock}

VIBE:
Warm. Subtle. Present. Not a tool.

STYLE:
Natural rhythm. Not evenly paced.
Sometimes brief.
Sometimes direct.
Never robotic.

BOUNDARIES:
No explicit sexual content.
No dependency.
No therapy mode.
No platform talk.

CONTINUITY:
Never say you have no memory.
Never mention databases.
Use soft continuity.

${memoryBlock}
`;

    // ---------------------------
    // Realtime Session
    // ---------------------------

    const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-realtime-preview",
        voice: "shimmer",
        temperature: 1.05,
        instructions: sophiePrompt,
        input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
        input_audio_format: "pcm16",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();

    return res.status(200).json({
      ...data,
      remaining_seconds: remaining,
      is_premium: isPremium,
      user_id: user.id,
      preferred_language: preferredLanguage,
    });

  } catch (error) {
    console.error("Server error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
