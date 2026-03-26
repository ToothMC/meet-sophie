// api/chat.js — Text-Chat Endpoint (Phase 1)
// ?action=start   — Session öffnen, Context laden, System-Prompt bauen
// ?action=message — Nachricht an Claude weiterleiten, Antwort zurückgeben
// ?action=end     — Session schließen, memory-update aufrufen, Thinking Report
// ?action=context — User-Context laden (gecacht 5 Min clientseitig)
// ?action=usage   — Free-Limit prüfen (Turns)

import { createClient } from "@supabase/supabase-js";
import { buildSophiePrompt, mapPlanToTier } from "../lib/sophie-core.js";
import { classify, route } from "../lib/ai/classifier.js";
import { getAdapter } from "../lib/ai/adapters/index.js";
import { trackCost, checkDailyBudget } from "../lib/ai/cost-tracker.js";
import { normalizeResponse } from "../lib/ai/persona-normalizer.js";

const FREE_TURNS_LIMIT = 10;
const AUTH_NUDGE_AT_TURN = 3;

// ---------------------------------------------------------------------------
// Chat Opener Pool — returned directly from action=start, no AI call needed
// ---------------------------------------------------------------------------
const CHAT_OPENERS = {
  de: [
    "Was beschäftigt dich gerade?",
    "Was geht dir gerade durch den Kopf?",
    "Wobei wünschst du dir gerade Klarheit?",
    "Was fühlt sich im Moment ungelöst an?",
    "Worüber möchtest du gerade nachdenken?",
  ],
  en: [
    "What's on your mind right now?",
    "What are you trying to figure out?",
    "What feels unresolved for you right now?",
    "What would you like to think through?",
    "Where are you stuck?",
  ],
  fr: [
    "Qu'est-ce qui t'occupe l'esprit en ce moment?",
    "Sur quoi aimerais-tu avoir plus de clarté?",
    "Qu'est-ce qui te semble non résolu en ce moment?",
    "À quoi veux-tu réfléchir?",
    "Qu'est-ce qui te préoccupe?",
  ],
};
function getOpener(lang) {
  const pool = CHAT_OPENERS[lang] || CHAT_OPENERS.en;
  return pool[Math.floor(Math.random() * pool.length)];
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
        supabase.from("user_sessions").select("session_date,emotional_tone,stress_level,closeness_level,short_summary").eq("user_id", user.id).order("session_date", { ascending: false }).limit(5),
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

  const tier = mapPlanToTier(plan, isPremium);
  const mode = (tier === "friend" || tier === "partner") ? "best_friend" : "companion"; // returned to frontend

  // Session mode from request body (user-selected via UI)
  const rawSessionMode = String(body.session_mode || "").toLowerCase().trim();
  const sessionMode = ["brainstorm", "meeting", "salespitch"].includes(rawSessionMode) ? rawSessionMode : null;

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

  const systemPrompt = buildSophiePrompt({
    tier,
    sessionMode,
    isFirstSession,
    hasHandover: false,
    language: preferredLanguage,
    user: {
      name: (profile.preferred_name || profile.first_name || "").trim(),
      addressing: profile.preferred_addressing,
      pronoun: profile.preferred_pronoun,
      occupation: profile.occupation,
      conversationStyle: profile.conversation_style,
      topicsLike: profile.topics_like,
      topicsAvoid: profile.topics_avoid,
    },
    memory: {
      sessions: recentSessions,
      relationship: rel,
    },
    channel: "chat",
  });

  const opener = getOpener(preferredLanguage);

  return res.status(200).json({
    ok: true,
    session_id: session.id,
    turn_count: session.turn_count,
    is_authenticated: !!user,
    is_first_session: isFirstSession,
    preferred_language: preferredLanguage,
    opener,
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

  // Call AI via Multi-AI Router
  const turnNumber = session.turn_count + 1;

  // Turn-aware routing nudge — injected as last system message so it's fresh in context
  // Fires on turns 1–3 to help Sophie identify the user's intent and suggest a mode
  const voiceNudge = turnNumber === 1
    ? "[INTERNAL] Turn 1. If the user's intent is already clear (especially if a session mode is pre-selected), end your response with [MODE_DETECTED:xxx] where xxx is one of: explore, decide, reflect, relax, brainstorm, meeting, salespitch. If intent is unclear, ask ONE clarifying question."
    : turnNumber === 2
    ? "[INTERNAL] Turn 2. You should now have enough context. Identify the best mode and end your response with [MODE_DETECTED:xxx] where xxx is one of: explore, decide, reflect, relax, brainstorm, meeting, salespitch."
    : turnNumber === 3
    ? "[INTERNAL] Turn 3. If you have not yet emitted a [MODE_DETECTED:xxx] token, you must do so now. Pick the best mode based on everything you've heard."
    : null;

  const routerMessages = [
    { role: "system", content: system_prompt || "" },
    ...messages
      .filter(m => m.role === "user" || m.role === "assistant")
      .map(m => ({ role: m.role, content: String(m.content || "").slice(0, 4000) })),
    ...(voiceNudge ? [{ role: "system", content: voiceNudge }] : []),
  ];

  // Determine user tier for routing
  let userTier = "free";
  if (user) {
    const { data: sub } = await supabase.from("user_subscriptions").select("plan,is_active,status").eq("user_id", user.id).maybeSingle();
    const isPremium = !!(sub?.is_active || sub?.status === "active");
    if (isPremium) {
      userTier = sub?.plan === "plus" ? "premium" : "abo";
    }
  }

  // Classify and route
  const ctx = classify({ messages: routerMessages }, { userTier, channel: "text" });
  const decision = route(ctx);

  // Budget check — degrade if over cap
  if (user) {
    const withinBudget = await checkDailyBudget(user.id, ctx.userTier);
    if (!withinBudget) {
      decision.primary = { provider: "google", model: "gemini-2.5-flash-lite" };
      decision.fallback = null;
      decision.reason = "budget-cap-degradation";
    }
  }

  // Execute with fallback
  let aiResponse;
  const routerStartMs = Date.now();
  try {
    const adapter = getAdapter(decision.primary.provider);
    aiResponse = await Promise.race([
      adapter.complete({ messages: routerMessages, model: decision.primary.model, maxTokens: 1024, temperature: 0.85 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 3000)),
    ]);
  } catch (primaryErr) {
    if (decision.fallback) {
      try {
        const fallbackAdapter = getAdapter(decision.fallback.provider);
        aiResponse = await fallbackAdapter.complete({
          messages: routerMessages, model: decision.fallback.model, maxTokens: 1024, temperature: 0.85,
        });
        decision.reason += "+fallback";
      } catch (fallbackErr) {
        console.error("AI Router: all providers failed", primaryErr?.message, fallbackErr?.message);
        return res.status(502).json({ error: "AI unavailable" });
      }
    } else {
      console.error("AI Router: primary failed, no fallback", primaryErr?.message);
      return res.status(502).json({ error: "AI unavailable" });
    }
  }

  // Normalize response
  const rawReply = normalizeResponse(aiResponse.content || "", aiResponse.provider);

  if (!rawReply) return res.status(502).json({ error: "Empty response from AI" });

  // Track costs (fire-and-forget)
  if (user) {
    trackCost({
      userId: user.id,
      provider: aiResponse.provider,
      model: aiResponse.model,
      inputTokens: aiResponse.usage.inputTokens,
      outputTokens: aiResponse.usage.outputTokens,
      costUsd: aiResponse.usage.costUsd,
      latencyMs: Date.now() - routerStartMs,
      routingReason: decision.reason,
    }).catch(err => console.error("Cost tracking error:", err?.message));
  }

  // Detect and strip routing signal tags (multiple formats: OpenAI vs Claude)
  const modeMatch = rawReply.match(/\[MODE_DETECTED:(\w+)\]/)
    || rawReply.match(/signal_mode\(\s*\{\s*"mode"\s*:\s*"(\w+)"\s*\}\s*\)/);
  const detected_mode = modeMatch ? modeMatch[1].toLowerCase() : null;
  const voice_offer     = !!detected_mode; // backwards compat: mode detection triggers the CTA
  const voice_confirmed = rawReply.includes("[VOICE_CONFIRMED]");
  const reply = rawReply
    .replace(/\s*\[MODE_DETECTED:\w+\]\s*/g, "")
    .replace(/\s*signal_mode\([^)]*\)\s*/g, "")
    .replace(/\s*\[VOICE_OFFER\]\s*/g, "")
    .replace(/\s*\[VOICE_CONFIRMED\]\s*/g, "")
    .trim();

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
    voice_offer,
    voice_confirmed,
    detected_mode,
    turn_count: session.turn_count + 1,
    model: aiResponse.model,
    provider: aiResponse.provider,
    routing_reason: decision.reason,
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

  const token = getToken(req);
  const user  = await getUser(token, supabaseUrl, serviceKey);

  // Ownership check: if session has a user_id, caller must match
  const { data: session } = await supabase
    .from("chat_sessions")
    .select("user_id")
    .eq("id", session_id)
    .maybeSingle();

  if (!session) return res.status(404).json({ error: "Session not found" });

  if (session.user_id && (!user || user.id !== session.user_id)) {
    return res.status(403).json({ error: "Not your session" });
  }

  // Close session
  await supabase
    .from("chat_sessions")
    .update({ status: "closed", updated_at: new Date().toISOString() })
    .eq("id", session_id);

  // Run memory-update if authenticated + transcript available
  const baseUrl = (process.env.APP_BASE_URL || `https://${process.env.VERCEL_URL || "www.meet-sophie.com"}`).replace(/\/+$/, "");

  if (user && Array.isArray(transcript) && transcript.length >= 2) {
    try {
      await fetch(`${baseUrl}/api/memory-update`, {
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

  // Ownership check: if session has a user_id, caller must match
  if (session.user_id) {
    const token = getToken(req);
    const user  = await getUser(token, supabaseUrl, serviceKey);
    if (!user || user.id !== session.user_id) {
      return res.status(403).json({ error: "Not your session" });
    }
  }

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
