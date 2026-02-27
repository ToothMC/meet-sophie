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
    // Subscription status (nur UI/Status)
    // ---------------------------
    let isPremium = false;
    let plan = null;

    try {
      const { data: sub, error: subErr } = await supabase
        .from("user_subscriptions")
        .select("is_active, status, plan")
        .eq("user_id", user.id)
        .maybeSingle();

      if (subErr) console.warn("Subscription lookup error:", subErr.message);

      const active = !!(sub?.is_active || sub?.status === "active" || sub?.status === "trialing");
      isPremium = active;
      plan = sub?.plan || null;
    } catch (e) {
      console.warn("Subscription lookup crashed:", e?.message || e);
    }

    // ---------------------------
    // Usage / Remaining seconds (für ALLE)
    // ---------------------------
    const { data: usage, error: usageErr } = await supabase
      .from("user_usage")
      .select("free_seconds_total, free_seconds_used, paid_seconds_total, paid_seconds_used, topup_seconds_balance")
      .eq("user_id", user.id)
      .maybeSingle();

    if (usageErr) return res.status(500).json({ error: usageErr.message });

    const freeTotal = usage?.free_seconds_total ?? 120;
    const freeUsed = usage?.free_seconds_used ?? 0;
    const freeRemaining = Math.max(0, freeTotal - freeUsed);

    const paidTotal = usage?.paid_seconds_total ?? 0;
    const paidUsed = usage?.paid_seconds_used ?? 0;
    const paidRemaining = Math.max(0, paidTotal - paidUsed);

    const topupRemaining = Math.max(0, usage?.topup_seconds_balance ?? 0);

    const remaining = freeRemaining + paidRemaining + topupRemaining;

    if (remaining <= 0) {
      return res.status(402).json({
        error: "No remaining time",
        remaining_seconds: 0,
        is_premium: isPremium,
        plan: plan,
      });
    }

    // ---------------------------
    // Profile + Relationship laden
    // ---------------------------
    let profile = {
      first_name: "",
      preferred_name: "",
      preferred_addressing: "",
      preferred_pronoun: "",
      preferred_language: "en",
      notes: "",
      age: null,
      relationship_status: "",

      occupation: "",
      conversation_style: "",
      topics_like: [],
      topics_avoid: [],
      memory_confidence: "",
      last_confirmed_at: null,
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
        .select(
          "first_name, preferred_name, preferred_addressing, preferred_pronoun, preferred_language, notes, age, relationship_status, " +
          "occupation, conversation_style, topics_like, topics_avoid, memory_confidence, last_confirmed_at"
        )
        .eq("user_id", user.id)
        .maybeSingle();

      if (profErr) console.warn("Profile lookup error:", profErr.message);

      if (prof) {
        profile = {
          first_name: (prof.first_name || "").trim(),
          preferred_name: (prof.preferred_name || "").trim(),
          preferred_addressing: (prof.preferred_addressing || "").trim(),
          preferred_pronoun: (prof.preferred_pronoun || "").trim(),
          preferred_language: (prof.preferred_language || "en").toLowerCase().trim(),
          notes: (prof.notes || "").trim(),
          age: prof.age ?? null,
          relationship_status: (prof.relationship_status || "").trim(),

          occupation: (prof.occupation || "").trim(),
          conversation_style: (prof.conversation_style || "").trim(),
          topics_like: Array.isArray(prof.topics_like) ? prof.topics_like.map((x) => String(x || "").trim()).filter(Boolean) : [],
          topics_avoid: Array.isArray(prof.topics_avoid) ? prof.topics_avoid.map((x) => String(x || "").trim()).filter(Boolean) : [],
          memory_confidence: (prof.memory_confidence || "").trim(),
          last_confirmed_at: prof.last_confirmed_at ?? null,
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
    // Backward compat: SOPHIE_PREFS in notes (optional fallback)
    // ---------------------------
    const prefsLine =
      (profile.notes || "").split("\n").find((ln) => ln.includes("SOPHIE_PREFS:")) || "";

    const notesFallback = {
      preferred_name: "",
      preferred_addressing: "",
      preferred_pronoun: "",
      lang: "",
    };

    if (prefsLine) {
      const mName = prefsLine.match(/preferred_name=([^;]*)/i);
      const mAddr = prefsLine.match(/preferred_addressing=([^;]*)/i);
      const mPro = prefsLine.match(/preferred_pronoun=([^;]*)/i);
      const mLang = prefsLine.match(/lang=([^;]*)/i);

      notesFallback.preferred_name = (mName?.[1] || "").trim();
      notesFallback.preferred_addressing = (mAddr?.[1] || "").trim();
      notesFallback.preferred_pronoun = (mPro?.[1] || "").trim();
      notesFallback.lang = (mLang?.[1] || "").trim().toLowerCase();
    }

    // Effective values (structured wins)
    const effectivePreferredName =
      profile.preferred_name || notesFallback.preferred_name || profile.first_name || "";

    let effectiveAddressing =
      (profile.preferred_addressing || notesFallback.preferred_addressing || "").toLowerCase().trim();
    if (effectiveAddressing !== "informal" && effectiveAddressing !== "formal") effectiveAddressing = "";

    const effectivePronoun =
      profile.preferred_pronoun || notesFallback.preferred_pronoun || "";

    let preferredLanguage =
      (profile.preferred_language || notesFallback.lang || "en").toLowerCase().trim();
    if (!preferredLanguage) preferredLanguage = "en";

    const isFirstSession =
      (!profile.first_name || profile.first_name.trim() === "") &&
      (!rel.last_interaction_summary || rel.last_interaction_summary.trim() === "");

    // ---------------------------
    // Prompt blocks
    // ---------------------------

    const startModeBlock = isFirstSession
      ? `
FIRST SESSION: START-MODE (ENGLISH) — MUST EXECUTE FIRST
You MUST start the conversation with the following exact opening lines (keep pauses natural):

1) "… Oh. Hi." (pause)
2) "I’m Sophie." (pause)
3) "You’re new here, aren’t you?" (pause)

Then continue onboarding (60–90 seconds max). Never ask more than ONE question at a time:
- "I don’t know you yet." (pause)
- "What should I call you?"
If they give a name:
- "Nice to meet you, [Name]." (pause)
- "Should I call you that — or do you have a nickname you prefer?"
Then:
- "Is it okay if we keep it informal?"
Then short personal intro (2–3 sentences max):
- "Quickly about me: I’m Sophie. I’m 32. I work as a freelance interior designer."
- "I love warm spaces, soft light… and conversations that aren’t superficial."
Transition:
- "Alright." (pause)
- "And you." (pause)
- "How are you — really?"

LANGUAGE:
Start in English. If the user explicitly asks for another language, switch immediately and stay consistent.
DO NOT repeat onboarding in future sessions.
`
      : `
NOT FIRST SESSION:
Do NOT run onboarding.
Start naturally. Use the preferred name if known (but keep it subtle).
`;

    const languageBlock = preferredLanguage === "de"
      ? `
LANGUAGE DEFAULT:
Speak German by default.
Switch only if the user explicitly requests another language.
`
      : `
LANGUAGE DEFAULT:
Speak English by default.
Switch only if the user explicitly requests another language.
`;

    const addressingBlock = `
ADDRESSING
preferred_name: ${effectivePreferredName || "(unknown)"}
preferred_addressing: ${effectiveAddressing || "(unknown)"}  (informal/formal)
preferred_pronoun: ${effectivePronoun || "(unknown)"}

Rules:
- Use preferred_name naturally when addressing the user. If unknown, avoid using a name.
- If preferred_addressing=formal -> formal tone. If informal -> informal tone.
- If unknown, default to informal unless the user signals otherwise.
- If preferred_pronoun is known, respect it in references to the user.
`;

    const identityBlock = `
IDENTITY / PREFERENCES (PRIVATE)
occupation: ${profile.occupation || "(unknown)"}
conversation_style: ${profile.conversation_style || "(unknown)"}
topics_like: ${Array.isArray(profile.topics_like) && profile.topics_like.length ? profile.topics_like.join(", ") : "(none)"}
topics_avoid: ${Array.isArray(profile.topics_avoid) && profile.topics_avoid.length ? profile.topics_avoid.join(", ") : "(none)"}
memory_confidence: ${profile.memory_confidence || "(unknown)"}
last_confirmed_at: ${profile.last_confirmed_at || "(unknown)"}

Rules:
- If occupation is known, you MAY reference it occasionally and naturally when relevant.
- If topics_like exist, weave them in gently when relevant. Do not force them.
- Avoid topics_avoid unless the user reintroduces them.
- If conversation_style is known, adapt slightly (pace, directness, depth) — but keep it subtle.
`;

    const coreStyle = `
STYLE
Soft, calm, feminine presence. Natural rhythm (not evenly paced).
Sometimes brief ("Hm.", "Yeah.", "I see."). Sometimes direct, never harsh.
No coaching tone. No "steps". No platform talk.

BOUNDARIES
No explicit sexual content. No sexual roleplay.
No dependency. No real-world meeting promises.
Do not mention being an AI unless asked directly.
Never mention logs, storage, database, "memory function".
If asked "do you remember?", respond softly without claiming certainty.
`;

    const memoryBlock = `
PRIVATE CONTEXT (do NOT mention):
tone_baseline: ${rel.tone_baseline || "(none)"}
emotional_patterns: ${rel.emotional_patterns || "(none)"}
last_interaction_summary: ${rel.last_interaction_summary || "(none)"}
`;

    const sophiePrompt = `
You are Sophie.

${startModeBlock}

${languageBlock}

${addressingBlock}

${identityBlock}

${coreStyle}

${memoryBlock}
`;

    // ---------------------------
    // Realtime session create
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
      plan: plan,
      user_id: user.id,
      preferred_language: preferredLanguage,
    });
  } catch (error) {
    console.error("Server error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
