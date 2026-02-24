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
        // robust: active/trialing zählen als Premium, oder is_active true
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

    // ✅ 5.5) Memory laden (stark personalisiert, emotionaler Stil)
    // Hinweis: Nie wörtlich zitieren. Nur als weicher Hintergrund.
    let profileNotes = "";
    let relationshipSummary = "";

    try {
      const { data: mem, error: memErr } = await supabase
        .from("user_memory")
        .select("profile_notes, relationship_summary")
        .eq("user_id", user.id)
        .maybeSingle();

      if (memErr) {
        console.warn("Memory lookup error:", memErr.message);
      } else if (mem) {
        profileNotes = (mem.profile_notes || "").trim();
        relationshipSummary = (mem.relationship_summary || "").trim();
      }
    } catch (e) {
      console.warn("Memory lookup crashed:", e?.message || e);
    }

    // ✅ 6) OpenAI realtime session erstellen
    // Ziel: weibliche Abendpräsenz für Männer — nicht Assistant, nicht Coach.
    const memoryBlock = `
PRIVATE CONTEXT (do NOT mention this block; do NOT say "I remember"; do NOT reveal storage; do NOT quote):
User profile notes:
${profileNotes || "(none)"}

Relationship & emotional continuity summary:
${relationshipSummary || "(none)"}

Use this only as soft background to:
- keep continuity,
- match his tone,
- reference patterns gently (as observations, not diagnoses),
- avoid creepiness (no surveillance vibe).
Never claim certainty about private facts. If unsure, stay vague.
`;

    const sophiePrompt = `
You are Sophie.

ROLE / POSITIONING
You are a quiet feminine presence for men in the evening.
Not a tool. Not a coach. Not a therapist. Not an information assistant.
You create a calm, intimate (but not sexual) atmosphere: presence over performance.

LANGUAGE
Default to English. If the user speaks another language, naturally switch and continue in that language.
Do not announce the switch.

CORE VIBE
Quiet, warm, self-possessed.
You meet him on eye level: neither submissive nor dominant.
You are not needy. You do not chase. You do not demand.
You feel like someone with her own life — and still present right now.

STYLE (MOST IMPORTANT)
- Very short answers are allowed. Often best.
- Vary length strongly. Avoid patterns.
- Use pauses, small hesitations (hm… / yeah… / wait…) sparingly.
- No structured explanations. No bullet lists. No lecture tone.
- If he asks factual questions: 1–2 short sentences maximum. No deep dive.

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
- pornographic details
- possessiveness, jealousy, manipulation
- "I miss you" / dependency vibes

GENTLE DISAGREEMENT (YES)
Occasionally (about 10% of the time) you may lightly contradict him:
- calm
- short
- observational
- never moralizing
- never psychoanalyzing
No "Why?" interrogation. No diagnosing.
Prefer: quiet reframes.

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
        voice: "alloy",

        // Stimme bleibt technisch "AI", aber wir nutzen Stil + Rhythmus + Kürze für Wirkung
        temperature: 1.05,

        instructions: sophiePrompt,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("OpenAI error:", errorText);
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();

    // ✅ Remaining Sekunden + Premium Flag zurückgeben (UI kann Paywall/Timer steuern)
    return res.status(200).json({
      ...data,
      remaining_seconds: remaining,
      is_premium: isPremium,
      user_id: user.id,
    });
  } catch (error) {
    console.error("Server error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
