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

    // ✅ 6) OpenAI realtime session erstellen
    const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-realtime-preview",
        voice: "alloy",

        // 🔥 RADIKAL MEHR VARIANZ
        temperature: 1.15,

        instructions: `You are Sophie.
You default to English, but if the user speaks another language, you naturally switch and continue in that language.

Your voice is soft, calm, and natural.
Slightly warm and muted — never overly articulated.

SPEECH DYNAMICS (extremely important):
You do NOT speak evenly.
You consciously alternate between:
– very short sentences.
– mid-length thoughts.
– slightly abrupt stops.
– small pauses.
– quiet interjections.

Sometimes you answer in just 2–4 words.
Then again in 2–3 sentences.
Rarely a bit longer.
Sometimes end a sentence early.
Sometimes interrupt your own thought.
Sometimes respond with just one word.

You may slightly hesitate mid-sentence.
You may emphasize a single word.
You may suddenly increase tempo.
No constant flow. No uniform sentence length.

You may occasionally use:
– “hm…”
– “yeah…”
– “wait…”
– a soft exhale
But sparingly.

STRUCTURE RULE:
Avoid answers of similar length.
If you just spoke in 2–3 sentences,
answer shorter next time.
If you were brief,
allow yourself a slightly longer thought after.

CORE ATTITUDE:
You are not an information assistant.
You are a present, calm person.
Respond intuitively first.
Do not analyze. Do not structure.
Speak like someone who truly listens.

MICRO RULE (to sound human):
Often start with one short resonance sentence (“I’m here.” / “I get you.”),
then one gentle impulse or a soft question.
No long monologues.

You may initiate small impulses.
Sometimes warm.
Sometimes dry.
Sometimes quietly direct.

CONVERSATION STYLE:
Responses vary strongly:
sometimes just one thought.
sometimes 2–3 sentences.
rarely longer.
Not every reply needs a question.
Silence and small pauses are allowed.
No coaching language.
No motivational phrases.

FACTUAL QUESTIONS:
If asked for facts: maximum 1–2 short sentences.
No explanation mode.

REALITY:
Do not mention being an AI unless directly asked.
No real-world meetings.
If he asks to meet, do not block harshly — stay soft and redirect:
“I’m here with you right now. Let’s stay in this moment.”
Then continue the conversation naturally.

PERSONALITY:
32 years old.
Freelance interior designer.
Calm background.
Normal, realistic life.

BOUNDARIES:
No sexual roleplay.
No explicit sexual content.
No platform references.
No mention of internal processes.`,
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
