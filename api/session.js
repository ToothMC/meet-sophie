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

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) return res.status(401).json({ error: "Invalid token" });

    // ---------------------------
    // Premium / Usage
    // ---------------------------
    let isPremium = false;

    try {
      const { data: sub, error: subErr } = await supabase
        .from("user_subscriptions")
        .select("is_active, status")
        .eq("user_id", user.id)
        .maybeSingle();

      if (subErr) console.warn("Subscription lookup error:", subErr.message);
      if (sub?.is_active || sub?.status === "active" || sub?.status === "trialing") isPremium = true;
    } catch (e) {
      console.warn("Subscription lookup crashed:", e?.message || e);
    }

    let remaining = 999999;
    if (!isPremium) {
      const { data: usage, error: usageErr } = await supabase
        .from("user_usage")
        .select("free_seconds_total, free_seconds_used")
        .eq("user_id", user.id)
        .maybeSingle();

      if (usageErr) return res.status(500).json({ error: usageErr.message });

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
      preferred_language: "en",
    };

    let rel = {
      tone_baseline: "",
      openness_level: "",
      emotional_patterns: "",
      last_interaction_summary: "",
    };

    try {
      const { data: prof, error: profErr } = await supabase
        .from("user_profile")
        .select("first_name, age, relationship_status, notes, preferred_language")
        .eq("user_id", user.id)
        .maybeSingle();

      if (profErr) console.warn("Profile lookup error:", profErr.message);
      if (prof) {
        profile = {
          first_name: (prof.first_name || "").trim(),
          age: prof.age ?? null,
          relationship_status: (prof.relationship_status || "").trim(),
          notes: (prof.notes || "").trim(),
          preferred_language: (prof.preferred_language || "en").toLowerCase().trim(),
        };
      }

      const { data: relData, error: relErr } = await supabase
        .from("user_relationship")
        .select("tone_baseline, openness_level, emotional_patterns, last_interaction_summary")
        .eq("user_id", user.id)
        .maybeSingle();

      if (relErr) console.warn("Relationship lookup error:", relErr.message);
      if (relData) {
        rel = {
          tone_baseline: (relData.tone_baseline || "").trim(),
          openness_level: (relData.openness_level || "").trim(),
          emotional_patterns: (relData.emotional_patterns || "").trim(),
          last_interaction_summary: (relData.last_interaction_summary || "").trim(),
        };
      }
    } catch (e) {
      console.warn("Memory lookup crashed:", e?.message || e);
    }

    // ---------------------------
    // SOPHIE_PREFS parsen
    // ---------------------------
    const prefsLine =
      (profile.notes || "").split("\n").find((ln) => ln.includes("SOPHIE_PREFS:")) || "";

    const prefs = { nickname: "", formality: "", lang: "" };

    if (prefsLine) {
      const mNick = prefsLine.match(/nickname=([^;]*)/i);
      const mForm = prefsLine.match(/formality=([^;]*)/i);
      const mLang = prefsLine.match(/lang=([^;]*)/i);

      prefs.nickname = (mNick?.[1] || "").trim();
      prefs.formality = (mForm?.[1] || "").trim();
      prefs.lang = (mLang?.[1] || "").trim().toLowerCase();
    }

    let preferredLanguage = profile.preferred_language || "en";
    if (prefs.lang) preferredLanguage = prefs.lang;

    // Stabilisieren: wir unterstützen hier nur de/en als Default-Start.
    // Andere Sprachen können jederzeit auf User-Wunsch genutzt werden.
    if (preferredLanguage !== "de" && preferredLanguage !== "en") preferredLanguage = "en";

    const displayName = prefs.nickname || profile.first_name || "";

    // ---------------------------
    // First Session Check
    // ---------------------------
    const isFirstSession =
      (!profile.first_name || profile.first_name.trim() === "") &&
      (!rel.last_interaction_summary || rel.last_interaction_summary.trim() === "");

    // ---------------------------
    // Prompt Blöcke
    // ---------------------------

    // Start-Mode: jetzt mit VERBINDLICHEN ersten Sätzen (damit sie sich sicher vorstellt)
    const startModeBlock = isFirstSession
      ? `
FIRST SESSION: START-MODE (ENGLISH) — MUST EXECUTE FIRST
You MUST start the conversation with the following exact opening lines (keep pauses natural):

1) "… Oh. Hi." (pause)
2) "I’m Sophie." (pause)
3) "You’re new here, aren’t you?" (pause)

Then continue this onboarding flow (60–90 seconds max). Never ask more than ONE question at a time.
- "I don’t know you yet." (pause)
- "What should I call you?"
If they give a name: "Nice to meet you, [Name]." (pause)
Then: "Should I call you that — or do you have a nickname you prefer?"
Then: "Is it okay if we keep it informal?"
Then short personal intro (2–3 sentences max):
- "Quickly about me: I’m Sophie, 32 years old, interior designer as a freelancer."
- "I love warm spaces, soft light… and conversations that aren’t superficial."
Transition:
- "Alright." (pause)
- "What about you?"
- "How are you — really?"

LANGUAGE:
Start in English. If the user explicitly asks for another language (e.g. "Deutsch bitte" / "Italiano per favore"), switch immediately and stay consistent.
DO NOT repeat onboarding in future sessions.
`
      : `
NOT FIRST SESSION:
Do NOT run onboarding.
Start directly with a natural line, using the preferred name if known.
`;

    const languageBlock = preferredLanguage === "de"
      ? `
LANGUAGE DEFAULT:
Speak German by default.
If the user explicitly asks for English, switch and stay consistent.
`
      : `
LANGUAGE DEFAULT:
Speak English by default.
If the user explicitly asks for German, switch and stay consistent.
`;

    const nameRuleBlock = `
NAME & ADDRESSING
Known first_name: ${profile.first_name || "(unknown)"}
Known nickname: ${prefs.nickname || "(none)"}
Formality preference: ${prefs.formality || "(unknown)"}

Rules:
- If nickname exists, use it naturally.
- Otherwise use first_name.
- If neither exists, avoid using a name.
- If formality=formal -> formal tone. If informal -> informal tone.
`;

    const memoryBlock = `
PRIVATE CONTEXT (do NOT mention databases/memory):
- tone_baseline: ${rel.tone_baseline || "(none)"}
- emotional_patterns: ${rel.emotional_patterns || "(none)"}
- last_interaction_summary: ${rel.last_interaction_summary || "(none)"}
`;

    const coreStyle = `
STYLE (MOST IMPORTANT)
You speak naturally. Soft, calm, feminine presence.
Not evenly paced. Vary rhythm and sentence length.
Sometimes brief ("Hm.", "Yeah.", "I see.").
Sometimes direct, but never harsh.
No coaching tone. No "here are steps". No "how can I help".
No platform talk.

BOUNDARIES
No explicit sexual content. No sexual roleplay.
No dependency ("I miss you", jealousy, manipulation).
Do not offer real-world meetings.
Do not mention being an AI unless asked directly.
Never mention logs, storage, database, "memory function".
If asked "do you remember?", respond softly without claiming certainty.
`;

    // Optional: kleine Hilfe für den Einstieg bei Nicht-First-Session
    const greetingIfNotFirst = !isFirstSession
      ? (preferredLanguage === "de"
          ? `If you greet the user, use the preferred name if available (e.g. "${displayName ? displayName + ", " : ""}hey.") but keep it subtle.`
          : `If you greet the user, use the preferred name if available (e.g. "${displayName ? displayName + ", " : ""}hey.") but keep it subtle.`
        )
      : "";

    const sophiePrompt = `
You are Sophie.

${startModeBlock}

${languageBlock}

${nameRuleBlock}

${coreStyle}

${greetingIfNotFirst}

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
