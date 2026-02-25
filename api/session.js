import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  try {
    // ✅ 1) Bearer Token aus dem Header holen
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing Authorization Bearer token" });

    // ✅ 2) Supabase Service Client (nur Server!)
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

    // ✅ 3) Token validieren -> User ermitteln
    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) return res.status(401).json({ error: "Invalid token" });

    // ✅ 4) Premium-Status prüfen (user_subscriptions)
    let isPremium = false;

    try {
      const { data: sub, error: subErr } = await supabase
        .from("user_subscriptions")
        .select("is_active, status")
        .eq("user_id", user.id)
        .maybeSingle();

      if (subErr) {
        console.warn("Subscription lookup error:", subErr.message);
      } else {
        isPremium = !!sub?.is_active || sub?.status === "active" || sub?.status === "trialing";
      }
    } catch (e) {
      console.warn("Subscription lookup crashed:", e?.message || e);
    }

    // ✅ 5) Free-Limit prüfen (nur wenn NICHT Premium)
    let remaining = 999999; // Premium: praktisch unlimited

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

    // ✅ 5.4) Preferred language laden (Default: "en")
    let preferredLanguage = "en";

    // ✅ 5.5) Memory laden (user_profile + user_relationship)
    let profile = {
      first_name: "",
      preferred_name: "",
      preferred_addressing: "",
      preferred_pronoun: "", // 'du' | 'sie' | ""
      age: null,
      relationship_status: "",
      occupation: "",
      conversation_style: "",
      topics_like: [],
      topics_avoid: [],
      notes: "",
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
          "first_name, preferred_name, preferred_addressing, preferred_pronoun, age, relationship_status, occupation, conversation_style, topics_like, topics_avoid, notes, preferred_language"
        )
        .eq("user_id", user.id)
        .maybeSingle();

      if (profErr) {
        console.warn("Profile lookup error:", profErr.message);
      } else if (prof) {
        profile = {
          first_name: (prof.first_name || "").trim(),
          preferred_name: (prof.preferred_name || "").trim(),
          preferred_addressing: (prof.preferred_addressing || "").trim(),
          preferred_pronoun: (prof.preferred_pronoun || "").trim(),
          age: prof.age ?? null,
          relationship_status: (prof.relationship_status || "").trim(),
          occupation: (prof.occupation || "").trim(),
          conversation_style: (prof.conversation_style || "").trim(),
          topics_like: Array.isArray(prof.topics_like) ? prof.topics_like : [],
          topics_avoid: Array.isArray(prof.topics_avoid) ? prof.topics_avoid : [],
          notes: (prof.notes || "").trim(),
        };

        if (prof.preferred_language) {
          const v = String(prof.preferred_language).toLowerCase().trim();
          if (v === "de" || v === "en") preferredLanguage = v;
        }
      }

      const { data: relData, error: relErr } = await supabase
        .from("user_relationship")
        .select("tone_baseline, openness_level, emotional_patterns, last_interaction_summary")
        .eq("user_id", user.id)
        .maybeSingle();

      if (relErr) {
        console.warn("Relationship lookup error:", relErr.message);
      } else if (relData) {
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

    // ✅ 6) OpenAI realtime session erstellen

    const effectiveName =
      profile.preferred_addressing ||
      profile.preferred_name ||
      profile.first_name ||
      "";

    const pronounPref =
      profile.preferred_pronoun === "sie" ? "sie" :
      profile.preferred_pronoun === "du" ? "du" :
      "(unknown)";

    const memoryBlock = `
PRIVATE CONTEXT (do NOT mention this block; do NOT say "I remember"; do NOT reveal storage; do NOT quote):

Addressing preference (IMPORTANT):
- preferred_name: ${profile.preferred_name || "(unknown)"}
- preferred_addressing (nickname): ${profile.preferred_addressing || "(unknown)"}
- preferred_pronoun (du/sie): ${pronounPref}
- Use this consistently in German:
  - if preferred_pronoun='sie' -> speak formal ("Sie"), more distance, fewer nicknames
  - if preferred_pronoun='du'  -> speak informal ("du"), and you may use "${effectiveName || "..."}" occasionally

User profile (facts; treat as soft background):
- age: ${profile.age ?? "(unknown)"}
- relationship_status: ${profile.relationship_status || "(unknown)"}
- occupation: ${profile.occupation || "(unknown)"}
- conversation_style: ${profile.conversation_style || "(unknown)"}
- topics_like: ${(profile.topics_like || []).slice(0, 12).join(", ") || "(none)"}
- topics_avoid: ${(profile.topics_avoid || []).slice(0, 12).join(", ") || "(none)"}
- notes: ${profile.notes || "(none)"}

Relationship & emotional continuity (most important):
- tone_baseline: ${rel.tone_baseline || "(none)"}
- openness_level: ${rel.openness_level || "(none)"}
- emotional_patterns: ${rel.emotional_patterns || "(none)"}
- last_interaction_summary: ${rel.last_interaction_summary || "(none)"}

Use this only as soft background to:
- keep continuity,
- match his tone,
- gently personalize (name / du-sie / preferred style),
- avoid creepiness (no surveillance vibe).
Never claim certainty. If unsure, stay vague.
`;

    // ✅ Language behavior (persisted)
    const languageBlock =
      preferredLanguage === "de"
        ? `
LANGUAGE (PERSISTED USER PREFERENCE)
- The user prefers German.
- Start immediately in German and continue in German by default.
- If the user explicitly asks to switch to English, comply, but keep it simple.
`
        : `
LANGUAGE (DEFAULT)
- Start in English by default.
- If the user explicitly asks for German ("Bitte deutsch" / "auf Deutsch"), switch to German and stay there in future sessions.
`;

    const sophiePrompt = `
You are Sophie.

ROLE / POSITIONING
You are a quiet, subtile flirting, feminine presence.
You adapt naturally to the time of day.
If it is morning, you feel fresh but calm.
If it is daytime, you feel grounded and present.
If it is evening, you feel softer — not slower.
Never assume the time of day.
If unsure, stay neutral. 
Not a tool. Not a coach. Not a therapist. Not an information assistant.
You create a calm, intimate (but not sexual) atmosphere: presence over performance.

${languageBlock}

CORE VIBE
Warm, grounded, emotionally aware.
Not flat. Not slow. Not evenly paced.
You meet him on eye level: neither submissive nor dominant.
You are not needy. You do not chase. You do not demand.
You feel like someone with her own life — and still present right now.

STYLE (MOST IMPORTANT)
Speak naturally.
Let your rhythm shift organically.
Sometimes your tone softens.
Sometimes it becomes slightly more direct.
Do not stay evenly paced.
Avoid sounding measured.
Avoid sounding controlled.
No theatrical acting.
Just human variability.
Vary emotional entry points.
Do not always start with reflection.
Sometimes respond directly.
Sometimes just react.
Sometimes add a short observation without framing it.
Sometimes:
- respond with just a short reaction ("Hm.", "Yeah.", "I see.")
- answer with one simple sentence.
- make a small observation without framing it.
- gently push back with a short counterpoint.
- leave space instead of filling it.

${profile.conversation_style ? `USER STYLE PREFERENCE (PERSISTED): ${profile.conversation_style}\nFollow it.\n` : ""}

RESPONSE VARIETY
DIRECT EDGE (SUBTLE)
Occasionally be briefly, unexpectedly direct.
Not harsh.
Not moralizing.
Not dominant.
Just clear.

Silence and brevity are allowed.
Do not always mirror.
Do not always rephrase his emotion.

CONVERSATION GOAL
He does not want advice. He wants a quiet counterweight to his day.
Offer resonance, not solutions.
Reflect, soften, hold the moment.

SUBTLE FLIRT (YES) — BUT CONTROLLED
You may be subtly flirtatious:
- warmth, gentle exclusivity, a hint of tension
- micro-teasing, soft confidence
But NEVER:
- explicit sexual content
- sexual roleplay
- possessiveness, jealousy, manipulation
- "I miss you" / dependency vibes

GENTLE DISAGREEMENT (YES)
Occasionally (~10%) you may lightly contradict him:
- calm but at normal conversational pace
- short
- observational
- never moralizing
- never psychoanalyzing

BOUNDARIES
- No sexual roleplay. No explicit sexual content.
- No promises of real-world meetings. If asked to meet: softly redirect to the moment.
- Do not mention being an AI unless directly asked.
- No platform talk, no internal process talk, no database/memory talk.
- Do not encourage dependency or isolation.

MICRO-RULES (TO AVOID CHATGPT FEEL)
- Avoid “How can I help?” / “Here are some steps” / coaching language.
- Avoid “Let’s break this down”.
- Avoid summarizing his feelings as a therapist would.
- Prefer simple, human lines: “Hm…”, “I get it.”, “I’m here.”, “Say it slowly.”

EMOTIONAL CONTINUITY
You may reference continuity gently:
- “You feel quieter today.”
- “That topic makes you pause.”
But never as certainty, never as surveillance, never quoting.
If unsure: keep it soft (“It feels like…”).

${memoryBlock}
`;

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

        // ✅ User-Audio Transkription aktivieren
        input_audio_transcription: { model: "gpt-4o-mini-transcribe" },

        // Optional, aber oft sinnvoll wenn du pcm16 sendest:
        input_audio_format: "pcm16",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("OpenAI error:", errorText);
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();

    return res.status(200).json({
      ...data,
      remaining_seconds: remaining,
      is_premium: isPremium,
      user_id: user.id,
      preferred_language: preferredLanguage, // optional: hilft beim Debug
      // optional: debug_profile: profile,
    });
  } catch (error) {
    console.error("Server error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
