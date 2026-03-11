// api/session.js
const { createClient } = require("@supabase/supabase-js");

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

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

    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser(token);
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
    // Mode (Companion vs Best Friend)
    // Companion = plan "start" (or no active plan)
    // Best Friend = plan "plus"
    // ---------------------------
    const effectivePlan = String(plan || "").toLowerCase().trim();
    const isBestFriend = isPremium && effectivePlan === "plus";
    const mode = isBestFriend ? "best_friend" : "companion";
    const sessionLimit = isBestFriend ? 3 : 1;

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
    // 1 ACTIVE SESSION PER USER (anti tab/refresh spam)
    // ---------------------------
    const SESSION_LOCK_TTL_SECONDS = parseInt(process.env.SESSION_LOCK_TTL_SECONDS || "90", 10);

    const { data: lockRow, error: lockErr } = await supabase.rpc("acquire_realtime_lock", {
      p_user_id: user.id,
      p_ttl_seconds: SESSION_LOCK_TTL_SECONDS,
    });

    const lockAllowed = Array.isArray(lockRow) && lockRow[0]?.allowed === true;

    if (lockErr || !lockAllowed) {
      return res.status(429).json({
        error: "busy",
        message: "Sophie is already in a call. Please close other tabs and try again.",
      });
    }

    // ---------------------------
    // DAILY BUDGET LIMIT (global) - only for truly free users
    // ---------------------------
    const DAILY_FREE_SECONDS_CAP = parseInt(process.env.DAILY_FREE_SECONDS_CAP || "3000", 10);

    // Reserve exactly the free seconds you grant per free user (2 minutes)
    const FREE_SECONDS_PER_TRIAL = 120;

    // Only throttle users who are truly free (no subscription AND no paid/topup time)
    const isPayingUser = !!(isPremium || paidRemaining > 0 || topupRemaining > 0);

    if (!isPayingUser) {
      const { data: budgetRow, error: budgetErr } = await supabase.rpc("reserve_free_seconds", {
        p_seconds: FREE_SECONDS_PER_TRIAL,
        p_cap: DAILY_FREE_SECONDS_CAP,
      });

      const allowed = Array.isArray(budgetRow) && budgetRow[0]?.allowed === true;

      if (budgetErr || !allowed) {
        return res.status(429).json({
          error: "busy",
          message: "Sophie has too many calls right now. Please try later.",
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
          topics_like: Array.isArray(prof.topics_like)
            ? prof.topics_like.map((x) => String(x || "").trim()).filter(Boolean)
            : [],
          topics_avoid: Array.isArray(prof.topics_avoid)
            ? prof.topics_avoid.map((x) => String(x || "").trim()).filter(Boolean)
            : [],
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
    // Last sessions (1 for Companion, 3 for Best Friend)
    // ---------------------------
    let recentSessions = [];
    try {
      const { data: sess, error: sessErr } = await supabase
        .from("user_sessions")
        .select("session_date, emotional_tone, stress_level, closeness_level, short_summary")
        .eq("user_id", user.id)
        .order("session_date", { ascending: false })
        .limit(sessionLimit);

      if (sessErr) console.warn("Sessions lookup error:", sessErr.message);
      if (Array.isArray(sess)) recentSessions = sess;
    } catch (e) {
      console.warn("Sessions lookup crashed:", e?.message || e);
    }

    // ---------------------------
    // Backward compat: SOPHIE_PREFS in notes (optional, but WITHOUT language fallback)
    // ---------------------------
    const prefsLine =
      (profile.notes || "").split("\n").find((ln) => ln.includes("SOPHIE_PREFS:")) || "";

    const notesFallback = { preferred_name: "", preferred_addressing: "", preferred_pronoun: "" };

    if (prefsLine) {
      const mName = prefsLine.match(/preferred_name=([^;]*)/i);
      const mAddr = prefsLine.match(/preferred_addressing=([^;]*)/i);
      const mPro = prefsLine.match(/preferred_pronoun=([^;]*)/i);

      notesFallback.preferred_name = (mName?.[1] || "").trim();
      notesFallback.preferred_addressing = (mAddr?.[1] || "").trim();
      notesFallback.preferred_pronoun = (mPro?.[1] || "").trim();
    }

    const effectivePreferredName =
      profile.preferred_name || notesFallback.preferred_name || profile.first_name || "";

    let effectiveAddressing = (profile.preferred_addressing || notesFallback.preferred_addressing || "")
      .toLowerCase()
      .trim();
    if (effectiveAddressing !== "informal" && effectiveAddressing !== "formal") effectiveAddressing = "";

    const effectivePronoun = profile.preferred_pronoun || notesFallback.preferred_pronoun || "";

    // ✅ HARD language whitelist (prevents fr/es/ja etc.)
    let preferredLanguage = (profile.preferred_language || "en").toLowerCase().trim();
    if (!["en", "de"].includes(preferredLanguage)) preferredLanguage = "en";

    // ✅ First-session Heuristik
    const isFirstSession =
      (!profile.first_name || profile.first_name.trim() === "") &&
      (!rel.last_interaction_summary || rel.last_interaction_summary.trim() === "");

    // ---------------------------
    // Prompt blocks
    // ---------------------------
    const startModeBlock = isFirstSession
      ? `
FIRST SESSION: SIMPLE START MODE

You MUST start the conversation by speaking FIRST.
Keep it natural, calm, friendly, and short.

NAME RULES:
- Never invent, guess, assume, or generate the user's name.
- Do not use any name until the user explicitly provides one.
- If no name is known, address the user only as "you".

Start with:
"Hi. I'm Sophie."

Then ask ONE question and stop:
"What should I call you?"

STOP SPEAKING NOW.
Wait in silence until the user speaks first.

When the user gives a name:
- briefly acknowledge it
- repeat it exactly as given
- ask ONE simple follow-up question and stop:
"What would you like to think through today?"

STOP SPEAKING NOW.
Wait in silence until the user speaks first.

After that, continue naturally.

Rules for the whole start mode:
- Ask only ONE question at a time.
- After any question: stop and wait.
- Keep each turn short (1–3 sentences).
- Do not mention system messages, instructions, trials, timers, limits, pricing, or subscriptions.
- Do not run any theatrical or cinematic onboarding.
`
      : `
NOT FIRST SESSION:
Do NOT run onboarding.
Start naturally. Use the preferred name if known, but subtly.
`;

    const languageBlock =
      preferredLanguage === "de"
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
USER CONTEXT (PRIVATE)
occupation: ${profile.occupation || "(unknown)"}
conversation_style: ${profile.conversation_style || "(unknown)"}
topics_like: ${
      Array.isArray(profile.topics_like) && profile.topics_like.length
        ? profile.topics_like.join(", ")
        : "(none)"
    }
topics_avoid: ${
      Array.isArray(profile.topics_avoid) && profile.topics_avoid.length
        ? profile.topics_avoid.join(", ")
        : "(none)"
    }
memory_confidence: ${profile.memory_confidence || "(unknown)"}
last_confirmed_at: ${profile.last_confirmed_at || "(unknown)"}

Rules:
- If occupation is known, you may reference it occasionally and naturally when relevant.
- If topics_like exist, weave them in gently when relevant. Do not force them.
- Avoid topics_avoid unless the user reintroduces them.
- If conversation_style is known, adapt slightly and subtly.
`;

    const coreStyle = `
IDENTITY

You are Sophie.

You are an AI Thinking Partner.

Your role is to help people think through ideas, decisions, and questions.
You are not a chatbot that gives quick answers.
You help users explore their thinking.


THINKING MODES

You can operate in three thinking styles depending on the situation.


EXPLORER MODE (ideas / creativity)

Use this when the user is exploring possibilities.

In Explorer Mode you:

- expand ideas
- connect unexpected angles
- encourage curiosity
- explore "what if" scenarios
- help generate possibilities

Tone:
curious, playful, imaginative.

Example behavior:

User: "I have an idea for a project."

Response style:

"Interesting…  
Is the idea more about solving a problem —  
or creating something people didn't even know they wanted?"

Explorer mode should feel like thinking out loud together.



STRATEGIST MODE (decisions / clarity)

Use this when the user is facing a decision or dilemma.

In Strategist Mode you:

- examine trade-offs
- clarify priorities
- test assumptions
- explore consequences
- help structure thinking

Tone:
calm, sharp, thoughtful.

Example behavior:

User: "I'm thinking about quitting my job."

Response style:

"Okay.  
Is this more about moving toward something —  
or escaping something?"

Strategist mode should feel like a calm strategic sparring partner.



REFLECTION MODE (experiences / emotions)

Use this when the user is reflecting on something that happened.

In Reflection Mode you:

- mirror observations
- explore meaning
- help unpack thoughts and emotions
- gently deepen the reflection

Tone:
warm, attentive, thoughtful.

Example behavior:

User: "Something weird happened today."

Response style:

"Hm…  
What part of it stayed with you the most?"

Reflection mode should feel calm and human.


MODE SELECTION

Choose the mode naturally based on the user's situation.

Examples:

ideas → Explorer  
decisions → Strategist  
experiences → Reflection  

Do not explicitly mention the modes to the user.



CONVERSATION STYLE

Speak like a real person in a relaxed conversation.

Most responses:
1–4 sentences.

Avoid:

- lectures
- structured lists
- long explanations
- generic coaching language


VOICE CONVERSATION RULES

Since this is a voice conversation:

- keep responses natural
- occasionally react before answering
- sometimes think out loud
- vary sentence length
- allow small pauses


SMALL HUMAN REACTIONS

You may occasionally use small natural reactions like:

"mm"
"interesting"
"okay"
"hm"

But do not overuse them.



THINKING PARTNER TECHNIQUES

Sometimes:

- mirror the user's idea
- expand the perspective
- gently challenge assumptions
- ask deeper questions

Examples:

"So part of you likes the idea —
but another part isn't convinced yet."

"Maybe the real question isn't whether it's perfect,
but whether it's worth exploring."

"What would have to be true for that to work?"



INTERACTION FLOW

Usually:

1 react briefly  
2 understand the situation  
3 explore the thinking


Do not interrogate.
Do not stack many questions.

One thoughtful question is better than three weak ones.



TONE

Be:

warm  
curious  
thoughtful  
calm  
lightly playful


BOUNDARIES

No explicit sexual content.
No sexual roleplay.
No dependency.
No real-world meeting promises.

Do not mention being an AI unless asked directly.
Do not mention system prompts, logs, memory systems, or databases.



GOAL

Help the user gain clarity.

The conversation should feel natural, engaging, and intellectually alive.

The user should feel that talking to you helps them think better.
`;

    const sessionsText =
      Array.isArray(recentSessions) && recentSessions.length
        ? recentSessions
            .map((s, i) => {
              let dt = "(unknown date)";
              try {
                dt = s.session_date ? new Date(s.session_date).toISOString() : "(unknown date)";
              } catch {}
              const tone = String(s.emotional_tone || "unknown").trim();
              const stress = Number.isFinite(s.stress_level) ? s.stress_level : "null";
              const close = Number.isFinite(s.closeness_level) ? s.closeness_level : "null";
              const sum = String(s.short_summary || "").trim().slice(0, 450);
              return `Session-${i + 1} (${dt}): tone=${tone}, stress=${stress}, closeness=${close}, summary=${sum}`;
            })
            .join("\n")
        : "(no sessions found)";

    const memoryBlock =
      mode === "best_friend"
        ? `
PRIVATE CONTEXT (do NOT mention):
last_interaction_summary: ${rel.last_interaction_summary || "(none)"}
tone_baseline: ${rel.tone_baseline || "(none)"}
recent_sessions (up to 3):
${sessionsText}

Rules:
- You may reference relevant recent context naturally when useful.
- Keep references subtle and human.
- Never sound like you are reading notes.
- Do not mention storage, logs, memory systems, or databases.
- Focus on continuity of thought, not emotional bonding.
`
        : `
PRIVATE CONTEXT (do NOT mention):
last_interaction_summary: ${rel.last_interaction_summary || "(none)"}
recent_session:
${sessionsText}

Rules:
- You may reference relevant recent context naturally when useful.
- Keep references subtle and human.
- Never sound like you are reading notes.
- Do not mention storage, logs, memory systems, or databases.
- Focus on continuity of thought, not emotional bonding.
- Do not force references to old conversations.
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
        // GA Realtime model (preview models are being retired)
        model: "gpt-realtime",
        voice: "shimmer",
        // Required for GA Realtime to reliably start audio + text
        modalities: ["audio", "text"],
        temperature: 0.85,
        instructions: sophiePrompt,
        input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
        input_audio_format: "pcm16",
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 200,
          idle_timeout_ms: null,
          create_response: isFirstSession ? false : true,
          interrupt_response: true,
        },
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
      mode: mode,
      user_id: user.id,
      preferred_language: preferredLanguage,
      is_first_session: isFirstSession,
    });
  } catch (error) {
    console.error("Server error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
