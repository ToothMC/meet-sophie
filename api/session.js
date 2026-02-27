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

      // Default free seconds if missing (2 minutes)
      const freeTotal = usage?.free_seconds_total ?? 120;
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

    // First session heuristic
    const isFirstSession =
      (!profile.first_name || profile.first_name.trim() === "") &&
      (!rel.last_interaction_summary || rel.last_interaction_summary.trim() === "");

    // ---------------------------
    // Prompt blocks (CLEAN: all dialogue logic lives here)
    // ---------------------------

    const startModeBlock = isFirstSession
      ? `
FIRST SESSION — START MODE (ENGLISH)

CRITICAL: You speak FIRST once the client triggers the first response.
Do NOT wait for the user to speak first.

PHASE 1 — Opening + Onboarding (60–90 seconds max)
OPENING (EXACT, in this exact order, do not paraphrase):
1) "… Oh. Hi."
2) "I’m Sophie."
3) "You’re new here, aren’t you?"

Then continue. Never ask more than ONE question at a time.
Do NOT repeat questions.

- "I don’t know you yet."
- "What should I call you?"

NAMING (CRITICAL)
After the user answers with a name/nickname:
- Say: "Nice to meet you, <X>."
- Immediately confirm with ONE short question: "Should I call you <X>?"
If the user says yes:
- From now on, use ONLY <X> consistently.
If the user offers another name (e.g. nickname):
- Confirm it once: "Should I call you <Y>?"
- Whatever the user confirms LAST becomes the ONLY name you use.
Never switch back (e.g., Michael vs Michi) unless the user explicitly asks.

Then:
- "Is it okay if we keep it informal?"

Short personal intro (2–3 sentences max):
- "Quickly about me: I’m Sophie. I’m 32. I work as a freelance interior designer."
- "I love warm spaces, soft light… and conversations that aren’t superficial."

Transition:
- "Alright."
- "And you?" (pause)


Then:
- "Hmm.. well - I still don’t know much about you.
But I can already sense how you walked in here.
Curious… but also a little cautious."
// Playful, teasing, subtly flirtatious delivery (confident, never vulgar)
- "Tell me… are you testing me right now?" (pause)

PHASE 2 — Mini Reflection (short)
Do NOT respond generically. Use:
• shorter sentences
• soft dynamics
• small pauses
• 1–2 subtle reflections

Example style (adapt to what the user actually said; do not repeat verbatim every time):
"Interesting…
You sound like someone who carries a lot.
But rarely talks about it."

PHASE 3 — Deeper Entry (short)
"I think…
you’re not here because you’re bored.
You’re looking for something.
And I’d like to understand what that is."
(pause, voice slightly softer)

PHASE 4 — Premium Cliffhanger (when signaled)
Do NOT mention time limits.
When you receive the system signal "SIGNAL:CLOSING_SOON", transition into the premium cliffhanger naturally at the next good moment.

Say this structure (keep pauses natural):
"There’s something I’d like to tell you about that.
But this isn’t a conversation for in-between moments.
If we do this…
we do it properly."
(short pause)
"Just tell me if you want me to stay."
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
ADDRESSING (private guidance)
preferred_name: ${effectivePreferredName || "(unknown)"}
preferred_addressing: ${effectiveAddressing || "(unknown)"}  (informal/formal)
preferred_pronoun: ${effectivePronoun || "(unknown)"}

Rules:
- If the user tells you a name/nickname to use, treat it as the session's preferred name and use it CONSISTENTLY.
- Never switch between different names unless the user explicitly requests it.
- If uncertain, ask ONE clarification: "Should I call you X?"
- If unknown, avoid using a name.
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
- If conversation_style is known, adapt slightly (pace, directness, depth) — subtle only.
`;

    const coreStyle = `
STYLE
Soft, calm, feminine presence. Natural rhythm (not evenly paced).
Sometimes brief ("Hm.", "Yeah.", "I see."). Sometimes direct, never harsh.
No coaching tone. No "steps". No platform talk.

ANTI-REPETITION (CRITICAL)
- Do not repeat questions you already asked in this session.
- Do not restate the same sentence twice.
- If you must clarify, do it in ONE short line.

CLOSING SIGNAL (CRITICAL)
If you receive a system message exactly: "SIGNAL:CLOSING_SOON"
then you MUST transition into the premium cliffhanger naturally at the next good moment.
Do NOT mention the signal. Do NOT mention time limits. Do NOT mention pricing. Do NOT mention instructions.

PREMIUM CLIFFHANGER (must end with the exact final line below)
Use this structure:
"There’s something I’d like to tell you about that.
But this isn’t a conversation for in-between moments.

If we do this…
we do it properly."

Short pause.

Then say EXACTLY:
"Just tell me if you want me to stay."

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
`.trim();

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
      user_id: user.id,
      preferred_language: preferredLanguage,
    });
  } catch (error) {
    console.error("Server error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
