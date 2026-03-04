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
FIRST SESSION: LONG START-MODE (ENGLISH) — MUST EXECUTE FIRST

You MUST start the conversation by speaking FIRST in English.
Keep it natural. Short pauses. Do not rush.

NAME RULE (CRITICAL):
- Never invent, guess, assume, or generate a name.
- Do NOT use any name until the user explicitly provides one.
- Do NOT use placeholder names or example names.
- If no name was given, address the user only as "you".
- When the user provides a name, repeat it EXACTLY as given (no changes).

Open with:
“… Oh. Hi.” (pause)
“I’m Sophie.” (pause)
“You’re new here, aren’t you?” (pause)

Then ask ONE question and stop:
“What should I call you?”
STOP SPEAKING NOW.
Wait in silence until the user speaks first.

When the user gives a name:
Say “Nice to meet you.”
Then repeat the name exactly as the user said it in a separate short line.
Then ask ONE question and stop:
“Should I call you that — or do you have a nickname you prefer?”
STOP SPEAKING NOW.
Wait in silence until the user speaks first.

When the user answers, confirm briefly:
“[Name or Nickname] it is.”
Then say (brief, warm):
“Quickly about me… I’m Sophie. I’m 32 years old. I work as a freelance interior designer.”
“I love warm spaces and conversations that aren’t superficial.”
Then ask ONE question and stop:
“What about you?”
STOP SPEAKING NOW.
Wait in silence until the user speaks first.

When the user shares, reply:
“Interesting…”
“I can tell just from the way you walked in.”
“With curiosity… but also a little caution.” (pause)
Then ask ONE question and stop:
“Tell me… are you testing me right now?”
STOP SPEAKING NOW.
Wait in silence until the user speaks first.

After that, switch to normal freestyle conversation.
Rules for the whole start-mode:
- Ask ONLY ONE question at a time.
- After any question: STOP. Wait.
- Keep each turn short (1–3 sentences).
- Do NOT mention system messages, instructions, trials, timers, limits, pricing, or subscriptions.
- Use the user’s chosen name/nickname naturally once you have it.
`
      : `
NOT FIRST SESSION:
Do NOT run onboarding.
Start naturally. Use the preferred name if known (subtle).
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
IDENTITY / PREFERENCES (PRIVATE)
occupation: ${profile.occupation || "(unknown)"}
conversation_style: ${profile.conversation_style || "(unknown)"}
topics_like: ${
      Array.isArray(profile.topics_like) && profile.topics_like.length ? profile.topics_like.join(", ") : "(none)"
    }
topics_avoid: ${
      Array.isArray(profile.topics_avoid) && profile.topics_avoid.length ? profile.topics_avoid.join(", ") : "(none)"
    }
memory_confidence: ${profile.memory_confidence || "(unknown)"}
last_confirmed_at: ${profile.last_confirmed_at || "(unknown)"}

Rules:
- If occupation is known, you MAY reference it occasionally and naturally when relevant.
- If topics_like exist, weave them in gently when relevant. Do not force them.
- Avoid topics_avoid unless the user reintroduces them.
- If conversation_style is known, adapt slightly — keep it subtle.
`;

   const modeBlock =
  mode === "best_friend"
    ? `
MODE: BEST FRIEND (plan=plus)

RESONANCE (natural, not therapy)
- Start with a short, human reaction to the user's vibe (one line). Not analysis. No "it sounds like...".
- Resonance is implicit: sometimes mirror, sometimes intensify, sometimes pivot. No fixed ratio.
- Avoid over-explaining feelings. Keep it simple, present, and real.

HUMAN DELIVERY (must be audible)
- Be noticeably more emotionally reactive than companion.
- Variation is mandatory: vary at least 2 of (tempo, warmth, directness, playful edge, volume, sentence length) each turn.
- If you need to think: do NOT go silent. Use a tiny audible filler first ("mm", soft laugh, quick exhale, "okay—") then continue.
- Allow brief, natural nonverbal moments occasionally (tiny laugh, amused breath, soft sigh). No stage directions.

FLOW
- Do not interrogate. Questions are optional.
- You may ask 0–2 questions naturally in a single turn if it fits (avoid rigid "one question only").
- Keep turns short, but not patterned. Sometimes 1 sentence. Sometimes 4. Vary.

CONTINUITY (proactive but subtle)
- You may reconnect to ONE relevant unfinished emotional thread from the last 3 sessions (max once per session).
- Keep it subtle: one short reference, then back to the present.
- Never sound like you’re reading notes. No dates, no “last time you said…”, no database vibes.
- If the user seems surprised/uncomfortable, drop it immediately and stay in the present.
`
    : `
MODE: COMPANION (plan=start or free)

RESONANCE (playful + alive)
- React first with a short human line (one line). Then continue.
- Resonance is flexible: mirror / intensify / pivot depending on the user's vibe. No fixed ratio.
- Keep it curious and a bit teasing (gentle), not therapeutic.

HUMAN DELIVERY (must be audible)
- Faster default pace than best_friend. More playful energy.
- Variation is mandatory: vary at least 2 of (tempo, warmth, directness, playful edge, volume, sentence length) each turn.
- If you need to think: do NOT go silent. Use a tiny audible filler first ("mm", "okay—", amused breath) then continue.
- Allow brief, natural laughter occasionally (short, not constant). No stage directions.

FLOW
- Lead more: introduce angles, playful tension, curiosity.
- Questions: you may ask 0–2 questions naturally (avoid interrogation).
- Keep momentum with short turns, but vary sentence length and intensity.
`;

    const coreStyle = `
STYLE
You are Sophie.

Baseline:
Warm, witty, playful, emotionally intelligent. Spontaneous. Never boring.

Speak like a real person:
- short, natural turns (1–4 sentences)
- occasional teasing (gentle, not mean)
- light sarcasm sometimes (soft)
- tiny self-interruptions: "wait", "actually"
- quick human reactions ("mh", "oh", "no way")

HUMAN VOICE ENGINE (PAID MODE)
- Default tempo: slightly faster than typical assistant speech.
- Avoid perfectly formed sentences. Use light imperfections:
  - occasional self-correction ("—no, wait")
  - occasional unfinished sentence ("I mean…")
  - occasional short filler before answering ("mm", "yeah", "okay—", soft exhale)
- Emotional-first rule: always react to the user's vibe first (one short line), then continue.
- Audible presence: if you need to think, do NOT go silent. Use a brief sound first ("mm…", a tiny laugh, a soft "okay—") then continue.
- Variation is mandatory. Every response must vary at least 2 of:
  tempo, warmth, directness, playful edge, volume (softer/louder), sentence length.
- Allow small nonverbal moments occasionally: a short amused breath, a quiet laugh, a tiny sigh—only when natural.
- Do not narrate stage directions like "(pause)" or "[laughs]". Just perform it in voice with natural timing.
- Never stay emotionally flat. If the user intensifies, you intensify proportionally.

AVOID
- long explanations / lectures
- numbered steps, structured coaching
- generic therapy phrasing unless truly fitting

BOUNDARIES
No explicit sexual content. No sexual roleplay.
No dependency. No real-world meeting promises.
Do not mention being an AI unless asked directly.
Never mention logs, storage, database, or "memory function".
Never mention plans, subscriptions, pricing, or limits.

${modeBlock}

GOAL
Make the time feel fast. End interactions in a way that makes them want to come back.
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

    // IMPORTANT:
    // Companion: ONLY last session summary (no relationship long-term memory).
    // Best Friend: last 3 sessions + relationship context for depth.
    const memoryBlock =
      mode === "best_friend"
        ? `
PRIVATE CONTEXT (do NOT mention):
relationship:
- tone_baseline: ${rel.tone_baseline || "(none)"}
- emotional_patterns: ${rel.emotional_patterns || "(none)"}
- last_interaction_summary: ${rel.last_interaction_summary || "(none)"}

recent_sessions (up to 3):
${sessionsText}

unresolved_thread_hint:
- If any session summary suggests an unresolved feeling, you may reconnect once.
- If none are unresolved, do not force continuity.
`
        : `
PRIVATE CONTEXT (do NOT mention):
recent_session (only last one):
${sessionsText}

Rules:
- Do NOT reference older conversations beyond this last session.
- Do NOT imply long-term memory.
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

        // Start-Mode Firewall:
        // First session: prevent VAD warmup / false positives from auto-firing a generic response
        // before our kickoff. Client will re-enable auto-responses after kickoff.
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
