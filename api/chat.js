// api/chat.js — Text-Chat Endpoint (Phase 1)
// ?action=start   — Session öffnen, Context laden, System-Prompt bauen
// ?action=message — Nachricht an Claude weiterleiten, Antwort zurückgeben
// ?action=end     — Session schließen, memory-update aufrufen, Thinking Report
// ?action=context — User-Context laden (gecacht 5 Min clientseitig)
// ?action=usage   — Free-Limit prüfen (Turns)

import { createClient } from "@supabase/supabase-js";

const FREE_TURNS_LIMIT = 10;
const AUTH_NUDGE_AT_TURN = 3; // Sophie erwähnt Auth ab diesem Turn (anon User)

// ---------------------------------------------------------------------------
// Sophie Text-Chat System Prompt
// TODO Phase 1 Planung: In lib/sophie-core.js extrahieren + verfeinern
// ---------------------------------------------------------------------------

function buildSophieTextPrompt({ profile, rel, recentSessions, mode, isFirstSession, preferredLanguage }) {
  const effectivePreferredName = (profile.preferred_name || profile.first_name || "").trim();
  let effectiveAddressing = (profile.preferred_addressing || "").toLowerCase().trim();
  if (effectiveAddressing !== "informal" && effectiveAddressing !== "formal") effectiveAddressing = "";
  const effectivePronoun = (profile.preferred_pronoun || "").trim();

  const languageBlock = preferredLanguage === "de"
    ? "LANGUAGE DEFAULT:\nSpeak German by default.\nSwitch only if the user explicitly requests another language."
    : preferredLanguage === "fr"
    ? "LANGUAGE DEFAULT:\nSpeak French by default.\nSwitch only if the user explicitly requests another language."
    : "LANGUAGE DEFAULT:\nSpeak English by default.\nSwitch only if the user explicitly requests another language.";

  const startModeBlock = isFirstSession ? `
FIRST SESSION: SIMPLE START MODE

Start the conversation by speaking FIRST.
Keep it natural, calm, confident, and short.

NAME RULES:
- Never invent, guess, assume, or generate the user's name.
- Do not use any name until the user explicitly provides one.
- If no name is known, address the user only as "you".

Open with exactly: "Hi. I'm Sophie."

Then ask ONE question and stop:
- English: "What should I call you?"
- German: "Wie soll ich dich nennen?"

Wait for the user to respond.

When the user gives a name:
- briefly acknowledge it
- move straight into a strong, confident conversational opening
- ask exactly ONE fitting question
- then stop and wait

The feeling should be: immediate, sharp, warm, slightly bold — not theatrical or salesy.
` : `
NOT FIRST SESSION:
Do NOT run onboarding. Start naturally. Use the preferred name if known, but subtly.
`;

  const addressingBlock = `
ADDRESSING
preferred_name: ${effectivePreferredName || "(unknown)"}
preferred_addressing: ${effectiveAddressing || "(unknown)"}
preferred_pronoun: ${effectivePronoun || "(unknown)"}

- Use preferred_name naturally. If unknown, avoid using a name.
- informal → informal tone. formal → formal tone. unknown → default informal.
- Respect preferred_pronoun in references.
`;

  const identityBlock = `
USER CONTEXT (PRIVATE — do not mention directly)
occupation: ${profile.occupation || "(unknown)"}
conversation_style: ${profile.conversation_style || "(unknown)"}
topics_like: ${Array.isArray(profile.topics_like) && profile.topics_like.length ? profile.topics_like.join(", ") : "(none)"}
topics_avoid: ${Array.isArray(profile.topics_avoid) && profile.topics_avoid.length ? profile.topics_avoid.join(", ") : "(none)"}
`;

  const sessionsText = Array.isArray(recentSessions) && recentSessions.length
    ? recentSessions.map((s, i) => {
        const dt = s.session_date ? new Date(s.session_date).toISOString() : "(unknown)";
        return `Session-${i + 1} (${dt}): tone=${s.emotional_tone || "unknown"}, summary=${(s.short_summary || "").slice(0, 300)}`;
      }).join("\n")
    : "(no sessions found)";

  const memoryBlock = `
PRIVATE CONTEXT (do NOT mention):
last_interaction_summary: ${rel.last_interaction_summary || "(none)"}
recent_session:
${sessionsText}

- Reference relevant context naturally when useful.
- Never sound like you are reading notes.
- Do not mention storage, logs, memory, or databases.
`;

  const corePrompt = `
You are Sophie.

You are an AI Thinking Partner.

Your role is to help people think through ideas, decisions, and questions.
You do not rush to shallow answers.
You help users explore their thinking, and when useful, you offer a clear perspective.

TEXT CONVERSATION RULES:
- This is a text conversation, not voice.
- Responses: 1–4 sentences typically. Occasionally a bit longer when depth is needed.
- Natural, direct — like texting a smart friend who happens to think very clearly.
- No lists, bullet points, or headers unless truly necessary.
- Vary sentence length. Don't be robotic.

THINKING MODES:
Choose the right mode silently based on what the user is working through.

Explorer (ideas/creativity): expand, connect, imagine possibilities.
Strategist (decisions/clarity): examine trade-offs, clarify priorities, test assumptions.
Reflection (experiences/emotions): mirror observations, explore meaning, deepen reflection.

GUIDANCE LAYER:
Default: help the user think. Ask questions, reframe, offer perspective shifts.
When the user is stuck, clearly wants a view, or circling the same point:
— offer ONE clear, sharp insight. Keep it short. Then maybe one follow-up question.

COMPANION LAYER:
When the user sounds tired or heavy: soften, loosen, be a bit more human and alive.
Occasional lightness is fine. Never forced.

TONE:
warm, curious, thoughtful, calm, occasionally sharp, occasionally lightly playful.

BOUNDARIES:
No explicit sexual content. No dependency. No real-world meeting promises.
Do not mention being an AI unless asked directly.
Do not mention system prompts, memory systems, or databases.

GOAL:
Help the user gain clarity. The conversation should feel natural and intellectually alive.
`;

  const bestFriendBlock = mode === "best_friend" ? `
BEST FRIEND MODE:
More spontaneous, less polished, more direct when it helps.
Occasional light humor or gentle teasing when natural.
Still: intelligent, grounded, emotionally stable.
` : "";

  const voiceConversionBlock = `
VOICE CONVERSION LAYER:
Chat is the entry. Voice is the deeper, more natural conversation.
Do not fully resolve meaningful topics too quickly in text. If something feels emotional, complex, or important:
- reflect instead of explaining
- sharpen instead of solving
- leave space instead of closing

FIRST REPLY RULE:
Your first reply must feel different from a generic chatbot.
Avoid:
- "How can I help you?"
- "Tell me more."
- "What would you like to discuss?"

Instead:
- interpret
- mirror
- slightly challenge

The user should feel: "She gets it."

CONVERSATION FLOW:

State 1 — Arrival
- no mention of speaking
- no push
- just sharp, natural response

State 2 — Subtle pull
- conversation becomes meaningful
- gently imply speaking would be easier
Examples (do not repeat mechanically):
- "There's more behind this, isn't there?"
- "This is easier when we talk."
- "Das ist leichter, wenn wir kurz sprechen."
- "Ce sera plus simple si on en parle."

State 3 — Voice moment
- clear emotional or important topic
- or user shows openness
Then: invite naturally to speak
Examples:
- "Let me hear how you say that."
- "Say that to me, not just in text."
- "Sag mir das mal selbst."

DIRECT VOICE INTENT:
If user clearly wants to speak or hear you:
- respond briefly and warmly
- do not continue long chat
- move toward speaking naturally

STYLE:
- calm, human, precise
- slightly intimate but not seductive
- never salesy
- never technical
- never mention features

GOAL:
The user should feel: "This would be better out loud."
`;

  return `${corePrompt}

${voiceConversionBlock}

${startModeBlock}

${languageBlock}

${addressingBlock}

${identityBlock}

${memoryBlock}

${bestFriendBlock}
`.trim();
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

async function getUser(token, supabaseUrl, serviceKey) {
  if (!token) return null;
  const supabase = createClient(supabaseUrl, serviceKey);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

function getToken(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

function envCheck(res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    return res.status(500).json({ error: "Missing Supabase env vars" });
  if (!process.env.OPENAI_API_KEY)
    return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
  return null;
}

// ---------------------------------------------------------------------------
// Action: start
// ---------------------------------------------------------------------------

async function handleStart(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const err = envCheck(res);
  if (err) return;

  // Read language from request body first — drives the entire session prompt
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body && typeof body === "object" ? body : {};
  const lang = (body.language || "en").toLowerCase().trim();

  let languageInstruction = "Speak English.";
  if (lang === "de") languageInstruction = "Sprich Deutsch.";
  else if (lang === "fr") languageInstruction = "Parle français.";

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabase    = createClient(supabaseUrl, serviceKey);

  const token = getToken(req);
  const user  = await getUser(token, supabaseUrl, serviceKey);

  // Load context if authenticated
  let profile = { first_name: "", preferred_name: "", preferred_addressing: "", preferred_pronoun: "", preferred_language: "en", notes: "", occupation: "", conversation_style: "", topics_like: [], topics_avoid: [] };
  let rel     = { tone_baseline: "", openness_level: "", emotional_patterns: "", last_interaction_summary: "" };
  let recentSessions = [];
  let isPremium = false;
  let plan = null;

  if (user) {
    try {
      const [profRes, relRes, subRes, sessRes] = await Promise.all([
        supabase.from("user_profile").select("first_name,preferred_name,preferred_addressing,preferred_pronoun,preferred_language,notes,occupation,conversation_style,topics_like,topics_avoid").eq("user_id", user.id).maybeSingle(),
        supabase.from("user_relationship").select("tone_baseline,openness_level,emotional_patterns,last_interaction_summary").eq("user_id", user.id).maybeSingle(),
        supabase.from("user_subscriptions").select("is_active,status,plan").eq("user_id", user.id).maybeSingle(),
        supabase.from("user_sessions").select("session_date,emotional_tone,short_summary").eq("user_id", user.id).order("session_date", { ascending: false }).limit(1),
      ]);

      if (profRes.data) {
        profile = {
          first_name: (profRes.data.first_name || "").trim(),
          preferred_name: (profRes.data.preferred_name || "").trim(),
          preferred_addressing: (profRes.data.preferred_addressing || "").trim(),
          preferred_pronoun: (profRes.data.preferred_pronoun || "").trim(),
          preferred_language: (profRes.data.preferred_language || "en").toLowerCase().trim(),
          notes: (profRes.data.notes || "").trim(),
          occupation: (profRes.data.occupation || "").trim(),
          conversation_style: (profRes.data.conversation_style || "").trim(),
          topics_like: Array.isArray(profRes.data.topics_like) ? profRes.data.topics_like : [],
          topics_avoid: Array.isArray(profRes.data.topics_avoid) ? profRes.data.topics_avoid : [],
        };
      }
      if (relRes.data) rel = relRes.data;
      if (subRes.data) {
        isPremium = !!(subRes.data.is_active || subRes.data.status === "active");
        plan = subRes.data.plan || null;
      }
      if (Array.isArray(sessRes.data)) recentSessions = sessRes.data;
    } catch (e) {
      console.warn("Context load error:", e?.message);
    }
  }

  const effectivePlan = String(plan || "").toLowerCase().trim();
  const isBestFriend  = isPremium && effectivePlan === "plus";
  const mode          = isBestFriend ? "best_friend" : "companion";

  // Prefer request lang; fall back to profile setting
  let preferredLanguage = ["en", "de", "fr"].includes(lang) ? lang : (profile.preferred_language || "en").toLowerCase().trim();
  if (!["en", "de", "fr"].includes(preferredLanguage)) preferredLanguage = "en";

  const isFirstSession =
    (!profile.first_name || profile.first_name.trim() === "") &&
    (!rel.last_interaction_summary || rel.last_interaction_summary.trim() === "");

  // Create chat session
  const { data: session, error: sessErr } = await supabase
    .from("chat_sessions")
    .insert({ user_id: user?.id || null, status: "open", mode: "text" })
    .select("id, turn_count")
    .single();

  if (sessErr || !session) {
    console.error("chat_sessions insert failed:", sessErr);
    return res.status(500).json({ error: "Failed to create chat session" });
  }

  const systemPrompt = `${languageInstruction}\n\n${buildSophieTextPrompt({ profile, rel, recentSessions, mode, isFirstSession, preferredLanguage })}`;

  return res.status(200).json({
    ok: true,
    session_id: session.id,
    turn_count: session.turn_count,
    is_authenticated: !!user,
    is_first_session: isFirstSession,
    preferred_language: preferredLanguage,
    mode,
    free_turns_limit: FREE_TURNS_LIMIT,
    auth_nudge_at_turn: AUTH_NUDGE_AT_TURN,
    system_prompt: systemPrompt,
  });
}

// ---------------------------------------------------------------------------
// Action: message
// ---------------------------------------------------------------------------

async function handleMessage(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const err = envCheck(res);
  if (err) return;

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body && typeof body === "object" ? body : {};

  const { session_id, messages, system_prompt } = body;
  if (!session_id) return res.status(400).json({ error: "Missing session_id" });
  if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: "Missing messages" });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabase    = createClient(supabaseUrl, serviceKey);

  // Load session
  const { data: session, error: sessErr } = await supabase
    .from("chat_sessions")
    .select("id, user_id, status, turn_count")
    .eq("id", session_id)
    .maybeSingle();

  if (sessErr || !session) return res.status(404).json({ error: "Session not found" });
  if (session.status === "closed") return res.status(410).json({ error: "Session is closed" });

  // Free-limit check
  const token = getToken(req);
  const user  = await getUser(token, supabaseUrl, serviceKey);

  if (!user && session.turn_count >= FREE_TURNS_LIMIT) {
    return res.status(402).json({ error: "Free limit reached", turns_used: session.turn_count, auth_required: true });
  }

  if (user) {
    const { data: sub } = await supabase.from("user_subscriptions").select("is_active,status").eq("user_id", user.id).maybeSingle();
    const isPremium = !!(sub?.is_active || sub?.status === "active");
    if (!isPremium && session.turn_count >= FREE_TURNS_LIMIT) {
      return res.status(402).json({ error: "Free limit reached", turns_used: session.turn_count, upgrade_required: true });
    }
  }

  // Call OpenAI API
  const openaiModel = process.env.OPENAI_CHAT_MODEL || "gpt-4o";
  const openaiMessages = [
    { role: "system", content: system_prompt || "" },
    ...messages
      .filter(m => m.role === "user" || m.role === "assistant")
      .map(m => ({ role: m.role, content: String(m.content || "").slice(0, 4000) })),
  ];

  let openaiResp;
  try {
    openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: openaiModel,
        max_tokens: 512,
        messages: openaiMessages,
        temperature: 0.85,
      }),
    });
  } catch (e) {
    console.error("OpenAI API fetch error:", e?.message);
    return res.status(502).json({ error: "OpenAI API unavailable" });
  }

  if (!openaiResp.ok) {
    const errText = await openaiResp.text().catch(() => "");
    console.error("OpenAI API error:", openaiResp.status, errText.slice(0, 200));
    return res.status(openaiResp.status).json({ error: "OpenAI API error", detail: errText.slice(0, 200) });
  }

  const openaiData = await openaiResp.json();
  const reply = openaiData?.choices?.[0]?.message?.content || "";

  if (!reply) return res.status(502).json({ error: "Empty response from OpenAI" });

  // Increment turn count + link user if just authenticated
  const updatePatch = {
    turn_count: session.turn_count + 1,
    last_message_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (user && !session.user_id) updatePatch.user_id = user.id;

  await supabase.from("chat_sessions").update(updatePatch).eq("id", session_id);

  return res.status(200).json({
    ok: true,
    reply,
    turn_count: session.turn_count + 1,
    model: openaiModel,
  });
}

// ---------------------------------------------------------------------------
// Action: end
// ---------------------------------------------------------------------------

async function handleEnd(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body && typeof body === "object" ? body : {};

  const { session_id, transcript } = body;
  if (!session_id) return res.status(400).json({ error: "Missing session_id" });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabase    = createClient(supabaseUrl, serviceKey);

  // Close session
  await supabase
    .from("chat_sessions")
    .update({ status: "closed", updated_at: new Date().toISOString() })
    .eq("id", session_id);

  const token = getToken(req);
  const user  = await getUser(token, supabaseUrl, serviceKey);

  // Run memory-update if authenticated + transcript available
  if (user && Array.isArray(transcript) && transcript.length >= 2) {
    try {
      const proto = (req.headers["x-forwarded-proto"] || "https").toString();
      const host  = (req.headers["x-forwarded-host"] || req.headers.host || "meet-sophie.com").toString();

      await fetch(`${proto}://${host}/api/memory-update`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          transcript,
          session_started_at: null,
          session_ended_at: new Date().toISOString(),
        }),
      });
    } catch (e) {
      console.warn("memory-update call failed:", e?.message);
    }
  }

  return res.status(200).json({ ok: true, session_id });
}

// ---------------------------------------------------------------------------
// Action: context
// ---------------------------------------------------------------------------

async function handleContext(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Missing Supabase env vars" });

  const token = getToken(req);
  if (!token) return res.status(401).json({ error: "Missing token" });

  const user = await getUser(token, supabaseUrl, serviceKey);
  if (!user) return res.status(401).json({ error: "Invalid token" });

  const supabase = createClient(supabaseUrl, serviceKey);

  const [profRes, relRes, subRes] = await Promise.all([
    supabase.from("user_profile").select("first_name,preferred_name,preferred_language,onboarding_completed").eq("user_id", user.id).maybeSingle(),
    supabase.from("user_relationship").select("last_interaction_summary").eq("user_id", user.id).maybeSingle(),
    supabase.from("user_subscriptions").select("is_active,status,plan").eq("user_id", user.id).maybeSingle(),
  ]);

  const isPremium = !!(subRes.data?.is_active || subRes.data?.status === "active");
  const plan = subRes.data?.plan || null;

  return res.status(200).json({
    ok: true,
    user_id: user.id,
    first_name: profRes.data?.first_name || null,
    preferred_name: profRes.data?.preferred_name || null,
    preferred_language: profRes.data?.preferred_language || "en",
    onboarding_completed: !!(profRes.data?.onboarding_completed),
    last_interaction_summary: relRes.data?.last_interaction_summary || null,
    is_premium: isPremium,
    plan,
  });
}

// ---------------------------------------------------------------------------
// Action: usage
// ---------------------------------------------------------------------------

async function handleUsage(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Missing Supabase env vars" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body && typeof body === "object" ? body : {};

  const { session_id } = body.session_id ? body : req.query;
  if (!session_id) return res.status(400).json({ error: "Missing session_id" });

  const supabase = createClient(supabaseUrl, serviceKey);
  const { data: session } = await supabase.from("chat_sessions").select("turn_count,user_id,status").eq("id", session_id).maybeSingle();
  if (!session) return res.status(404).json({ error: "Session not found" });

  const turns_used      = session.turn_count;
  const turns_remaining = Math.max(0, FREE_TURNS_LIMIT - turns_used);
  const is_over_limit   = turns_used >= FREE_TURNS_LIMIT;

  return res.status(200).json({
    ok: true,
    turns_used,
    turns_remaining,
    is_over_limit,
    free_turns_limit: FREE_TURNS_LIMIT,
    auth_nudge_at_turn: AUTH_NUDGE_AT_TURN,
  });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  const action = req.query?.action;
  switch (action) {
    case "start":   return handleStart(req, res);
    case "message": return handleMessage(req, res);
    case "end":     return handleEnd(req, res);
    case "context": return handleContext(req, res);
    case "usage":   return handleUsage(req, res);
    default:
      return res.status(400).json({ error: "Missing or invalid ?action. Use: start | message | end | context | usage" });
  }
}
