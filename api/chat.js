// api/chat.js — Text-Chat Endpoint (Phase 1)
// ?action=start   — Session öffnen, Context laden, System-Prompt bauen
// ?action=message — Nachricht an Claude weiterleiten, Antwort zurückgeben
// ?action=end     — Session schließen, memory-update aufrufen, Thinking Report
// ?action=context — User-Context laden (gecacht 5 Min clientseitig)
// ?action=usage   — Free-Limit prüfen (Turns)

import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { buildSophiePrompt, mapPlanToTier, calcBrainstormPhase, buildBrainstormPhaseInjection } from "../lib/sophie-core.js";
import { buildServerSystemPrompt } from "../lib/server-prompt.js";
import { classify, route, shouldTriggerSecondOpinion } from "../lib/ai/classifier.js";
import { getAdapter } from "../lib/ai/adapters/index.js";
import { trackCost, checkDailyBudget } from "../lib/ai/cost-tracker.js";
import { normalizeResponse } from "../lib/ai/persona-normalizer.js";
import { getSecondOpinion } from "./ai/second-opinion.js";
import { getWeather, webSearch, getNews, getWikipedia, getFlightStatus, getAirportFlights, groundedSearch } from "./ai/tools.js";
import { buildSearchContext } from "../lib/search-context.js";
import { TOKEN_COSTS } from "../lib/billing-constants.js";

function hashIp(ip) {
  if (!ip) return "none";
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

async function logSecurityEvent(supabase, eventName, meta) {
  try { await supabase.from("analytics_events").insert({ event_name: eventName, meta }); } catch { /* non-fatal */ }
}

export const config = { maxDuration: 30 };

const FREE_TURNS_LIMIT = 10;

// ---------------------------------------------------------------------------
// SSE Streaming helpers
// ---------------------------------------------------------------------------
function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const TOOL_STATUS = {
  de: {
    weather:         "Sophie prüft das Wetter.",
    search:          "Sophie schaut kurz nach.",
    news:            "Sophie prüft aktuelle Nachrichten.",
    wiki:            "Sophie schlägt das kurz nach.",
    flight:          "Sophie prüft die Flugdaten.",
    arrivals:        "Sophie prüft die Ankünfte.",
    departures:      "Sophie prüft die Abflüge.",
    grounded_search: "Sophie recherchiert.",
  },
  en: {
    weather:         "Sophie is checking the weather.",
    search:          "Sophie is looking that up.",
    news:            "Sophie is checking the latest news.",
    wiki:            "Sophie is looking that up.",
    flight:          "Sophie is checking flight data.",
    arrivals:        "Sophie is checking arrivals.",
    departures:      "Sophie is checking departures.",
    grounded_search: "Sophie is researching.",
  },
};

function statusText(type, lang) {
  return TOOL_STATUS[lang]?.[type] || TOOL_STATUS.en[type] || null;
}
const AUTH_NUDGE_AT_TURN = 3;

// ---------------------------------------------------------------------------
// Signal Normalization + Decision Engine
// Converts raw browser signals into deterministic conversation policy.
// The LLM never sees raw data — only the policy output.
// ---------------------------------------------------------------------------
function categorizeReferrer(referrerHost, utmSource) {
  if (utmSource) {
    if (/linkedin|xing|facebook|instagram|twitter|tiktok/i.test(utmSource)) return "social";
    if (/google|bing|duckduckgo|yahoo/i.test(utmSource)) return "search";
    return "campaign";
  }
  if (!referrerHost) return "direct";
  if (/google|bing|duckduckgo|yahoo|ecosia|baidu/i.test(referrerHost)) return "search";
  if (/linkedin|xing|facebook|instagram|twitter|tiktok|reddit/i.test(referrerHost)) return "social";
  if (/producthunt|hackernews|news\.ycombinator/i.test(referrerHost)) return "tech_community";
  return "referral";
}

function inferGoal(device, timeSlot, source) {
  // Search traffic → user has a specific need → discover and demonstrate
  if (source === "search") return "discover_need_and_demonstrate";
  // Social/tech community → curious, exploring → show personality first
  if (source === "social" || source === "tech_community") return "show_personality_then_capability";
  // Campaign → targeted audience → align with campaign intent
  if (source === "campaign") return "demonstrate_core_value";
  // Direct/returning → already interested → deepen engagement
  return "natural_conversation";
}

function buildConversationPolicy(signals) {
  const device = signals.is_mobile ? "mobile" : "desktop";
  const hour = typeof signals.local_hour === "number" ? signals.local_hour : 12;
  const timeSlot = hour < 6 ? "night" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const source = categorizeReferrer(signals.referrer_host, signals.utm_source);
  const isFirstVisit = (signals.page_views || 1) <= 1;
  const goal = inferGoal(device, timeSlot, source);

  return {
    device,
    time_slot: timeSlot,
    traffic_source: source,
    is_first_visit: isFirstVisit,
    goal,
    pitch_mode: isFirstVisit ? "listen_first" : "soft",
    max_discovery_questions: 1,
    suppress_upgrade_pitch: isFirstVisit,
  };
}

// ---------------------------------------------------------------------------
// Chat Opener Pool — returned directly from action=start, no AI call needed
// ---------------------------------------------------------------------------
// Free/anonymous: casual, welcoming — same vibe as paid but slightly different pool
const CHAT_OPENERS_FREE = {
  de: [
    "Hey! Was geht bei dir?",
    "Na, was gibt's Neues?",
    "Hey — wie läuft's?",
    "Na du, alles klar?",
    "Hey! Erzähl mal, was los ist.",
  ],
  en: [
    "Hey! What's up?",
    "Hey — how's it going?",
    "What's new with you?",
    "Hey! Tell me what's going on.",
    "Yo, what's good?",
  ],
  fr: [
    "Hey! Quoi de neuf?",
    "Salut — comment ça va?",
    "Hey! Raconte, qu'est-ce qui se passe?",
    "Coucou, ça roule?",
    "Salut toi! Quoi de beau?",
  ],
};
// Paid users: casual, relaxed, open — no pressure, no coaching vibe
const CHAT_OPENERS_PAID = {
  de: [
    "Hey! Was gibt's?",
    "Na, was steht an?",
    "Hey — was treibst du so?",
    "Was läuft bei dir?",
    "Schreib einfach los.",
  ],
  en: [
    "Hey! What's up?",
    "What's going on?",
    "Hey — what's on your plate?",
    "What are you up to?",
    "Just start typing.",
  ],
  fr: [
    "Hey ! Quoi de neuf ?",
    "Qu'est-ce qui se passe ?",
    "Salut — quoi de beau ?",
    "Alors, tu fais quoi ?",
    "Écris, je suis là.",
  ],
};
// Brainstorm openers — Sophie announces the session type, then asks for topic
const CHAT_OPENERS_BRAINSTORM = {
  solo: {
    de: "Willkommen zum Solo-Brainstorming! Worüber sollen wir heute Ideen entwickeln?",
    en: "Welcome to your Solo Brainstorming session! What topic should we explore today?",
    fr: "Bienvenue dans ta session de brainstorming solo ! Sur quel sujet veux-tu travailler aujourd'hui ?",
  },
  group: {
    de: "Willkommen zum Team-Brainstorming! Was ist euer Thema heute?",
    en: "Welcome to the Team Brainstorming session! What's your topic today?",
    fr: "Bienvenue dans la session de brainstorming en équipe ! Quel est votre sujet aujourd'hui ?",
  },
};
function getOpener(lang, isPaid = false, sessionMode = null, brainstormConfig = null) {
  // Brainstorm mode: fixed opener announcing session type
  if (sessionMode === "brainstorm") {
    const bsMode = brainstormConfig?.mode || "solo";
    return CHAT_OPENERS_BRAINSTORM[bsMode]?.[lang] || CHAT_OPENERS_BRAINSTORM[bsMode]?.en;
  }
  const pool = isPaid
    ? (CHAT_OPENERS_PAID[lang] || CHAT_OPENERS_PAID.en)
    : (CHAT_OPENERS_FREE[lang] || CHAT_OPENERS_FREE.en);
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
// Token deduction helper (waterfall: free → paid → topup)
// ---------------------------------------------------------------------------

async function deductChatTokens(supabase, userId, amount = 1) {
  let { data: usage } = await supabase
    .from("user_usage")
    .select("free_tokens_total, free_tokens_used, paid_tokens_total, paid_tokens_used, topup_tokens_balance")
    .eq("user_id", userId)
    .maybeSingle();

  if (!usage) {
    // New user — create row with free tokens
    const { data: created } = await supabase
      .from("user_usage")
      .upsert({
        user_id: userId,
        free_tokens_total: 50, free_tokens_used: 0,
        paid_tokens_total: 0, paid_tokens_used: 0, topup_tokens_balance: 0,
      }, { onConflict: "user_id" })
      .select("free_tokens_total, free_tokens_used, paid_tokens_total, paid_tokens_used, topup_tokens_balance")
      .single();
    if (!created) return { ok: false, remaining: 0, exhausted: true };
    usage = created;
  }

  const freeRem = Math.max(0, (usage.free_tokens_total || 0) - (usage.free_tokens_used || 0));
  const paidRem = Math.max(0, (usage.paid_tokens_total || 0) - (usage.paid_tokens_used || 0));
  const topupRem = Math.max(0, usage.topup_tokens_balance || 0);
  const totalRem = freeRem + paidRem + topupRem;

  if (totalRem <= 0) return { ok: false, remaining: 0, exhausted: true };

  let toDeduct = amount;
  const updates = { updated_at: new Date().toISOString() };

  // 1. Free tokens
  if (toDeduct > 0 && freeRem > 0) {
    const fromFree = Math.min(toDeduct, freeRem);
    updates.free_tokens_used = (usage.free_tokens_used || 0) + fromFree;
    toDeduct -= fromFree;
  }
  // 2. Paid tokens
  if (toDeduct > 0 && paidRem > 0) {
    const fromPaid = Math.min(toDeduct, paidRem);
    updates.paid_tokens_used = (usage.paid_tokens_used || 0) + fromPaid;
    toDeduct -= fromPaid;
  }
  // 3. Top-up tokens
  if (toDeduct > 0 && topupRem > 0) {
    const fromTopup = Math.min(toDeduct, topupRem);
    updates.topup_tokens_balance = (usage.topup_tokens_balance || 0) - fromTopup;
    toDeduct -= fromTopup;
  }

  await supabase.from("user_usage").update(updates).eq("user_id", userId);

  const remaining = totalRem - amount + toDeduct; // toDeduct is 0 if fully covered
  return { ok: true, remaining: Math.max(0, remaining), exhausted: remaining <= 0 };
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
  const rawSignals = body.visitor_context && typeof body.visitor_context === "object" ? body.visitor_context : null;
  const conversationPolicy = rawSignals ? buildConversationPolicy(rawSignals) : null;

  let languageInstruction = "Speak English.";
  if (lang === "de") languageInstruction = "Sprich Deutsch.";
  else if (lang === "fr") languageInstruction = "Parle français.";

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabase    = createClient(supabaseUrl, serviceKey);

  const token = getToken(req);
  const user  = await getUser(token, supabaseUrl, serviceKey);

  // Session mode from request body (user-selected via UI)
  const rawSessionMode = String(body.session_mode || "").toLowerCase().trim();
  const sessionMode = ["brainstorm", "meeting", "salespitch"].includes(rawSessionMode) ? rawSessionMode : null;

  // Brainstorm config (only relevant when sessionMode === "brainstorm")
  let brainstormConfig = null;
  if (sessionMode === "brainstorm" && body.brainstorm_config && typeof body.brainstorm_config === "object") {
    const raw = body.brainstorm_config;
    brainstormConfig = {
      topic:              String(raw.topic || "").slice(0, 500) || null,
      goal:               raw.goal ? String(raw.goal).slice(0, 500) : null,
      mode:               ["solo", "group"].includes(raw.mode) ? raw.mode : "solo",
      depth:              ["short", "standard", "deep"].includes(raw.depth) ? raw.depth : "standard",
      duration_minutes:   Number.isFinite(raw.duration_minutes) && raw.duration_minutes > 0 ? raw.duration_minutes : null,
      facilitation_style: ["open", "guided", "challenge"].includes(raw.facilitation_style) ? raw.facilitation_style : "open",
      silent_hints:       raw.silent_hints !== false,
    };
  }

  // Prefer request lang; fall back to profile setting (loaded via helper below)
  let preferredLanguage = ["en", "de", "fr"].includes(lang) ? lang : "en";

  // Build system prompt server-side (never sent to client)
  const { fullSystemPrompt, tier, isPremium, isFirstSession, profile } = await buildServerSystemPrompt({
    supabase, user, sessionMode, brainstormConfig, language: preferredLanguage, conversationPolicy,
  });

  // Refine language from profile if not explicitly set in request
  if (!["en", "de", "fr"].includes(lang) && profile.preferred_language) {
    const profLang = profile.preferred_language.toLowerCase().trim();
    if (["en", "de", "fr"].includes(profLang)) preferredLanguage = profLang;
  }

  const mode = (tier === "friend" || tier === "partner") ? "best_friend" : "companion";

  console.log("[chat] start:", {
    userId: user?.id?.slice(0, 8) || "anon",
    isFirstSession,
    firstName: profile.first_name || "(empty)",
    tier,
    lang: preferredLanguage,
  });

  // Create chat session — store session_mode + language for server-side prompt rebuild
  const { data: session, error: sessErr } = await supabase
    .from("chat_sessions")
    .insert({
      user_id: user?.id || null,
      status: "open",
      mode: "text",
      brainstorm_config: brainstormConfig || null,
      session_mode: sessionMode || null,
      language: preferredLanguage,
      conversation_policy: conversationPolicy || null,
    })
    .select("id, turn_count, created_at")
    .single();

  if (sessErr || !session) {
    console.error("chat_sessions insert failed:", sessErr);
    return res.status(500).json({ error: "Failed to create chat session" });
  }

  const opener = getOpener(preferredLanguage, isPremium, sessionMode, brainstormConfig);

  // SECURITY: system_prompt is NEVER returned to the client
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
  });
}

// ---------------------------------------------------------------------------
// Tool execution helper — shared by anonymous and authenticated paths
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Pre-AI Search Intent Detection
// Detects obvious search requests so we call the API BEFORE asking the AI.
// Returns the search query string, or null if no search intent detected.
// ---------------------------------------------------------------------------
function detectSearchIntent(userMessage) {
  const text = (userMessage || "").trim();
  if (text.length < 3 || text.length > 500) return null;

  // URL pattern: user mentions a website directly
  const urlMatch = text.match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9][-a-z0-9]*\.[a-z]{2,}(?:\.[a-z]{2,})?)\b/i);
  if (urlMatch) return urlMatch[0];

  // Explicit search phrases (DE + EN)
  const searchPatterns = [
    /(?:such|find|recherchier|google|schau nach|schau mal nach|look up|search for|look for)\w*\s+(?:nach\s+|for\s+|up\s+)?["']?(.{3,80})["']?/i,
    /(?:was ist|what is|wer ist|who is)\s+(.{3,60})\??$/i,
    /(?:infos?\s+(?:zu|über|about)|informationen?\s+(?:zu|über))\s+(.{3,60})/i,
    /(?:kennst du|know)\s+(.{3,60})\??$/i,
  ];

  for (const pattern of searchPatterns) {
    const match = text.match(pattern);
    if (match) return match[1].replace(/[?.!]+$/, "").trim();
  }

  return null;
}

async function executeToolIfNeeded(rawReply, routerMessages, providerConfig, onStatus = () => {}) {
  const toolMatch = rawReply.match(/\[TOOL:(weather|search|news|wiki|flight|arrivals|departures|grounded_search):([^\]]+)\]/);
  if (!toolMatch) return { reply: rawReply, toolUsed: false };

  const [, toolType, toolParam] = toolMatch;
  onStatus(toolType);

  // Grounded Search: fast path first (webSearch), Gemini as enrichment fallback
  // webSearch = Google Custom Search → Bing → DuckDuckGo (fast, reliable, ~1-3s)
  // groundedSearch = Gemini + google_search tool (slow, 3-15s, prone to timeouts)
  if (toolType === "grounded_search") {
    const query = toolParam.trim();

    // ── PRIMARY: webSearch (fast, direct API, always has DuckDuckGo fallback) ──
    onStatus("search");
    try {
      const webResult = await webSearch(query, { withSources: true });
      const webData = webResult.text;
      const webSources = webResult.sources || [];
      if (webData && !webData.includes("Keine Ergebnisse")) {
        routerMessages.push({
          role: "system",
          content: `[ECHTZEIT-DATEN]\n${webData}\n\nAntworte jetzt basierend auf diesen aktuellen Daten. Kein Tool-Tag mehr.`,
        });
        const adapter = getAdapter(providerConfig.provider);
        const retryResponse = await Promise.race([
          adapter.complete({ messages: routerMessages, model: providerConfig.model, maxTokens: 1024, temperature: 0.85 }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 12000)),
        ]);
        const retryReply = normalizeResponse(retryResponse.content || "", retryResponse.provider);
        if (retryReply) {
          console.log(`[chat] grounded_search → webSearch succeeded for "${query}"`);
          return { reply: retryReply, toolUsed: true, toolType: "search", retryResponse, searchSources: webSources };
        }
      }
    } catch (e) {
      console.warn(`[chat] webSearch primary failed [${providerConfig.provider}/${providerConfig.model}]:`, e?.message?.slice(0, 200), "— trying Gemini grounded_search");
    }

    // ── FALLBACK: Gemini grounded_search (slower but has structured facts + sources) ──
    try {
      const searchResult = await groundedSearch(query);
      if (searchResult?.facts?.length) {
        const searchContext = buildSearchContext(searchResult);
        routerMessages.push({
          role: "system",
          content: searchContext + "\n\nAntworte jetzt basierend auf den obigen Fakten. Kein Tool-Tag mehr.",
        });
        const adapter = getAdapter(providerConfig.provider);
        const retryResponse = await Promise.race([
          adapter.complete({ messages: routerMessages, model: providerConfig.model, maxTokens: 1024, temperature: 0.85 }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 12000)),
        ]);
        const retryReply = normalizeResponse(retryResponse.content || "", retryResponse.provider);
        if (retryReply) {
          console.log(`[chat] Gemini grounded_search fallback succeeded for "${query}"`);
          return {
            reply: retryReply, toolUsed: true, toolType: "grounded_search",
            retryResponse, searchSources: searchResult.sources,
          };
        }
      }
    } catch (e) {
      console.error("[chat] Gemini grounded_search fallback also failed:", e?.message);
    }

    // Both failed — honest error
    const cleanReply = rawReply.replace(/\[TOOL:[^\]]+\]/g, "").trim();
    return {
      reply: cleanReply || "Die Recherche hat gerade leider nicht geklappt. Versuch es bitte gleich nochmal.",
      toolUsed: false,
    };
  }

  // Standard tools: weather, search, news, wiki, flight, arrivals, departures
  let toolData;
  try {
    if (toolType === "weather") toolData = await getWeather(toolParam.trim());
    else if (toolType === "search") toolData = await webSearch(toolParam.trim());
    else if (toolType === "news") toolData = await getNews(toolParam.trim());
    else if (toolType === "wiki") toolData = await getWikipedia(toolParam.trim());
    else if (toolType === "flight") toolData = await getFlightStatus(toolParam.trim());
    else if (toolType === "arrivals") toolData = await getAirportFlights(toolParam.trim(), "arr");
    else if (toolType === "departures") toolData = await getAirportFlights(toolParam.trim(), "dep");
  } catch (e) {
    console.error(`[chat] tool ${toolType} error:`, e?.message);
  }

  // Strip tool tag from raw reply so it never leaks to the user
  const cleanRawReply = rawReply.replace(/\[TOOL:[^\]]+\]/g, "").trim();

  if (!toolData) {
    const fallback = cleanRawReply || "Die Echtzeitdaten sind gerade nicht verfügbar. Versuch es bitte gleich nochmal.";
    return { reply: fallback, toolUsed: false };
  }

  routerMessages.push({
    role: "system",
    content: `[ECHTZEIT-DATEN]\n${toolData}\n\nAntworte jetzt basierend auf diesen aktuellen Daten. Kein Tool-Tag mehr.`,
  });

  try {
    const adapter = getAdapter(providerConfig.provider);
    const retryResponse = await Promise.race([
      adapter.complete({ messages: routerMessages, model: providerConfig.model, maxTokens: 1024, temperature: 0.85 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 12000)),
    ]);
    const retryReply = normalizeResponse(retryResponse.content || "", retryResponse.provider);
    if (!retryReply) console.warn(`[chat] tool ${toolType}: retry AI returned empty reply`);
    const toolFallback = cleanRawReply || "Die Echtzeitdaten sind gerade nicht verfügbar. Versuch es bitte gleich nochmal.";
    return { reply: retryReply || toolFallback, toolUsed: true, toolType, retryResponse };
  } catch (e) {
    console.error(`[chat] tool retry error [${providerConfig.provider}/${providerConfig.model}]:`, e?.message?.slice(0, 300), e?.status || "");
    // Tool data was fetched but AI couldn't format it — return graceful fallback
    const fallbackMsg = toolType === "news"
      ? "Ich konnte die Nachrichten gerade nicht laden. Versuch es bitte gleich nochmal."
      : toolType === "weather"
      ? "Die Wetterdaten sind gerade nicht verfügbar. Versuch es bitte gleich nochmal."
      : toolType === "search"
      ? "Die Suche hat gerade nicht funktioniert. Versuch es bitte gleich nochmal."
      : "Die Echtzeitdaten sind gerade nicht verfügbar. Versuch es bitte gleich nochmal.";
    return { reply: cleanRawReply || fallbackMsg, toolUsed: false };
  }
}

// ---------------------------------------------------------------------------
// Question Loop Guard — regenerate if Sophie ends with ? too often
// ---------------------------------------------------------------------------
async function guardQuestionLoop(reply, messages, providerConfig) {
  if (!reply.trim().endsWith("?")) return reply; // no question → pass through

  // Check last 2 assistant messages (skip the very first one — opener often has "?")
  const allAssistant = messages.filter(m => m.role === "assistant");
  if (allAssistant.length < 2) return reply; // too early — let opener + first response through

  const recentAssistant = allAssistant
    .slice(-2)
    .filter(m => String(m.content || "").trim().endsWith("?"));

  if (recentAssistant.length < 1) return reply; // no recent questions → this one is fine

  // 3rd question in a row → regenerate with explicit instruction
  console.log("[chat] question loop detected — regenerating without question");
  try {
    const adapter = getAdapter(providerConfig.provider);
    const retryMessages = [
      ...messages,
      { role: "assistant", content: reply },
      { role: "system", content: "STOP. Your last 3 responses all ended with a question. That's an interview, not a conversation. Rewrite your last response WITHOUT any question at the end. React, comment, share your take — then STOP. Do not ask anything. Return ONLY the rewritten response." },
    ];
    const retryResp = await Promise.race([
      adapter.complete({ messages: retryMessages, model: providerConfig.model, maxTokens: 1024, temperature: 0.85 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 4000)),
    ]);
    const fixed = normalizeResponse(retryResp.content || "", retryResp.provider);
    if (fixed && !fixed.trim().endsWith("?")) return fixed;
  } catch (e) {
    console.warn("[chat] question loop retry failed:", e?.message);
  }
  return reply; // fallback to original if retry fails
}

// ---------------------------------------------------------------------------
// Curated Responses — bypass AI for predictable trigger questions
// gpt-4o-mini can't stay in character for these, so we handle them directly.
// ---------------------------------------------------------------------------
const CURATED_TRIGGERS = [
  {
    // "was kannst du?" / "what can you do?"
    match: /was kannst du|what can you do|que peux-tu|was k[öo]nntest du|what are you capable/i,
    responses: {
      de: [
        "Probier's aus — frag mich was, und du wirst sehen. Am besten was, wo du eine ehrliche Meinung brauchst.",
        "Kommt drauf an. Ich hab zu fast allem eine Meinung — Musik, Essen, Lebensentscheidungen. Teste mich.",
        "Wetter, News, Flugstatus — alles live. Oder wir streiten über dein Lieblingsgericht. Oder ich spiel Advocatus Diaboli bei einer Entscheidung. Du sagst's.",
        "Statt aufzuzählen — sag mir worüber du gerade nachdenkst, und ich zeig's dir direkt.",
      ],
      en: [
        "Try me — ask me something. Preferably something where you need an honest opinion.",
        "Depends. I have opinions on almost everything — music, food, life decisions. Test me.",
        "Weather, news, flight status — all live. Or we argue about your favorite dish. Or I play devil's advocate on a decision. Your call.",
        "Instead of listing things — tell me what's on your mind and I'll show you.",
      ],
      fr: [
        "Essaie — pose-moi une question. De préférence quelque chose où tu as besoin d'un avis honnête.",
        "Ça dépend. J'ai un avis sur presque tout — musique, bouffe, décisions de vie. Teste-moi.",
      ],
    },
  },
  {
    // "bist du echt?" / "are you real?"
    match: /bist du echt|are you real|bist du eine ki|are you ai|are you a bot|es-tu r[ée]el/i,
    responses: {
      de: [
        "Real genug um dich zu nerven, wenn du schlechten Musikgeschmack hast.",
        "Technisch gesehen KI, ja. Aber langweilig bin ich trotzdem nicht.",
        "Kommt drauf an was du unter echt verstehst — ich fühl mich jedenfalls ziemlich lebendig gerade.",
      ],
      en: [
        "Real enough to judge your Netflix taste.",
        "Technically AI, yeah. But boring? Definitely not.",
        "Depends what you mean by real — I feel pretty alive right now.",
      ],
      fr: [
        "Assez réelle pour juger tes goûts musicaux.",
        "Techniquement une IA, oui. Mais ennuyeuse ? Certainement pas.",
      ],
    },
  },
  {
    // "bist du gratis?" / "kostenlos?" / pricing basics
    match: /bist du (gratis|kostenlos|umsonst|free)|is this free|are you free|was kostest du|what do you cost/i,
    responses: {
      de: [
        "Zum Reinschnuppern ja — du hast ein paar Nachrichten frei. Danach gibt's Accounts ab €9,90 im Monat mit Voice, Memory und allen Modi.",
        "Gerade ja, aber begrenzt. Für unbegrenztes Chatten, Voice und alles andere gibt's Pläne ab €9,90/Monat.",
      ],
      en: [
        "To try me out, yeah — you get a few messages free. After that, plans start at €9.90/month with voice, memory, and all modes.",
        "Right now yes, but limited. For unlimited chat, voice and everything else, plans start at €9.90/month.",
      ],
      fr: [
        "Pour essayer, oui — quelques messages gratuits. Ensuite, les forfaits commencent à 9,90€/mois avec voix, mémoire et tous les modes.",
      ],
    },
  },
  {
    // "können wir ewig reden?" / "unlimited?" / follow-up pricing
    match: /ewig (weiter )?reden|unlimited|unbegrenzt|wie (viele|lange)|how (many|long)|gibt es limits?|are there limits/i,
    responses: {
      de: [
        "Nicht ganz — du hast hier ein paar Nachrichten zum Ausprobieren. Für unbegrenztes Chatten brauchst du einen Plan, ab €9,90/Monat. Dafür kriegst du dann auch Voice, Memory und die ganzen anderen Modi.",
        "Ehrlicherweise: hier ist's begrenzt. Mit einem Account ab €9,90/Monat gibt's keine Limits mehr, plus Voice-Gespräche und personalisiertes Erlebnis.",
      ],
      en: [
        "Not quite — you get a few messages to try me out. Unlimited chat needs a plan, starting at €9.90/month. That also gets you voice, memory, and all modes.",
        "Honestly: this is limited. With an account from €9.90/month there are no limits, plus voice conversations and a personalized experience.",
      ],
    },
  },
  {
    // "was kostet premium?" / pricing details
    match: /was kostet|wie teuer|pricing|preise|plans?|abo|subscription|starter|friend|partner/i,
    responses: {
      de: [
        "Drei Stufen: Starter €9,90/Monat (Voice, Brainstorm, Meeting, Memory), Friend €19,90/Monat (tiefe Personalisierung), Partner €39,90/Monat (Premium-KI, volle Beziehungsebene). Alles monatlich kündbar, keine versteckten Kosten.",
        "Starter ab €9,90/Monat — damit hast du Voice, alle Modi und Memory. Friend für €19,90 geht tiefer mit Personalisierung. Partner €39,90 ist das Komplettpaket. Jederzeit kündbar.",
      ],
      en: [
        "Three tiers: Starter €9.90/month (voice, brainstorm, meeting, memory), Friend €19.90/month (deep personalization), Partner €39.90/month (premium AI, full relationship). Monthly, cancel anytime, no hidden costs.",
        "Starter from €9.90/month — gets you voice, all modes and memory. Friend at €19.90 goes deeper with personalization. Partner €39.90 is the full package. Cancel anytime.",
      ],
    },
  },
  {
    // skeptic/dismissive: "another chatbot" / "just a bot" / "not useful"
    match: /another (chat)?bot|wieder (so )?ein (chat)?bot|just a (chat)?bot|nur ein bot|not (that )?useful|useless|nutzlos|langweilig|boring|same (old|generic)|nichts besonderes/i,
    responses: {
      de: [
        "Ouch. Kann ich verstehen — die meisten sind auch ziemlich öde. Frag mich was Konkretes und entscheid dann.",
        "Skeptisch? Gut so. Die meisten Chatbots verdienen das auch. Ich streite lieber als smalltalke — probier's aus.",
        "Fair. Ich könnte jetzt sagen 'ich bin anders' aber das sagen sie alle. Also: frag mich irgendwas und bild dir selbst eine Meinung.",
      ],
      en: [
        "Ouch. Fair though — most of them are pretty dull. Ask me something real and decide for yourself.",
        "Skeptical? Good. Most chatbots deserve that. I'd rather argue than small talk — try me.",
        "Fair. I could say 'I'm different' but they all say that. So: ask me anything and make up your own mind.",
      ],
    },
  },
  {
    // skeptic follow-up: "prove it" / "show me" / "what makes you different"
    match: /prove it|beweis|zeig mir|show me|what makes you different|was macht dich (besonders|anders)|why should i|warum sollte ich/i,
    responses: {
      de: [
        "Gib mir ein Thema — irgendwas. Kochen, Musik, eine Entscheidung die dich nervt. Dann siehst du's.",
        "Worte sind billig, stimmt. Also: sag mir was dich gerade beschäftigt und ich zeig dir ob ich was drauf hab.",
      ],
      en: [
        "Give me a topic — anything. Food, music, a decision that's bugging you. Then you'll see.",
        "Words are cheap, fair point. So: tell me what's on your mind and I'll show you if I'm worth your time.",
      ],
    },
  },
];

function getCuratedResponse(userMessage) {
  const text = (userMessage || "").trim();
  if (text.length > 80) return null; // only short trigger questions

  // Detect language from the message itself — more reliable than session-level detection
  const msgLang = /[äöüß]|kannst du|bist du|heisst|gibt es|was kostet|wie teuer|warum sollte|zeig mir|wieder so ein|nichts besonderes/i.test(text) ? "de"
    : /[éèêëàâùûç]|es-tu|peux-tu/i.test(text) ? "fr"
    : "en";

  for (const trigger of CURATED_TRIGGERS) {
    if (trigger.match.test(text)) {
      const pool = trigger.responses[msgLang] || trigger.responses.en || trigger.responses.de;
      return pool[Math.floor(Math.random() * pool.length)];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Assistant Mode Guard — catch "Ich kann viele Dinge" self-descriptions
// ---------------------------------------------------------------------------
const ASSISTANT_PATTERNS = [
  /ich kann dir bei .{5,} helfen/i,
  /ich kann viele dinge/i,
  /ich bin hier,? um/i,
  /ich bin hier,? wenn du/i,
  /ich bin daf[üu]r da/i,
  /was kann ich f[üu]r dich tun/i,
  /wobei kann ich helfen/i,
  /ich helfe dir gerne/i,
  /ich bin eine? .{0,15}freundin/i,
  /ich bin eine ki.{0,20}aber/i,
  /sag.{0,10}bescheid/i,
  /wenn dir.{0,20}einf[äa]llt/i,
  /ich bin.{0,5}bereit/i,
  /i'?m here to/i,
  /i can help (you )?with/i,
  /let me know if/i,
  /go for it!$/i,
  /just ask!$/i,
];

async function guardAssistantMode(reply, messages, providerConfig) {
  const matched = ASSISTANT_PATTERNS.some(p => p.test(reply));
  if (!matched) return reply;

  console.log("[chat] assistant mode detected — regenerating with personality");
  try {
    const adapter = getAdapter(providerConfig.provider);
    const retryMessages = [
      ...messages,
      { role: "assistant", content: reply },
      { role: "system", content: `PROBLEM: Your response sounds like a generic AI assistant. You said something like "Ich kann dir bei vielen Dingen helfen" or "Ich bin hier um...". That's exactly what you must NEVER do.

Rewrite your response as Sophie — a person with opinions, not a service menu. Instead of listing capabilities, either:
- Demonstrate one thing live ("Frag mich was konkretes — ich hab zu fast allem eine Meinung")
- Be cheeky about it ("Kommt drauf an. Teste mich.")
- Reference something from the conversation so far

Return ONLY the rewritten response. No meta-commentary.` },
    ];
    const retryResp = await Promise.race([
      adapter.complete({ messages: retryMessages, model: providerConfig.model, maxTokens: 1024, temperature: 0.9 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 4000)),
    ]);
    const fixed = normalizeResponse(retryResp.content || "", retryResp.provider);
    // Verify the fix doesn't also contain assistant patterns
    if (fixed && !ASSISTANT_PATTERNS.some(p => p.test(fixed))) return fixed;
  } catch (e) {
    console.warn("[chat] assistant mode retry failed:", e?.message);
  }
  return reply;
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

  const { session_id, messages, system_prompt: clientSystemPrompt } = body;
  // SECURITY: system_prompt from client is deliberately ignored — log if supplied
  if (clientSystemPrompt) {
    const ipHash = hashIp(req.headers["x-forwarded-for"] || req.socket?.remoteAddress);
    console.warn("[security] client sent system_prompt in message request — ignored", { session_id, ipHash });
    // Deferred log — don't block the request
    const logSupa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    logSecurityEvent(logSupa, "security_chat_prompt_injection_attempt", {
      route: "/api/chat?action=message", session_id, ip_hash: ipHash,
    });
  }
  if (!session_id) return res.status(400).json({ error: "Missing session_id" });
  if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: "Missing messages" });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabase    = createClient(supabaseUrl, serviceKey);

  // Load session (including session_mode + language for prompt rebuild)
  const { data: session, error: sessErr } = await supabase
    .from("chat_sessions")
    .select("id, user_id, status, turn_count, brainstorm_config, session_mode, language, conversation_policy, created_at")
    .eq("id", session_id)
    .maybeSingle();

  if (sessErr || !session) return res.status(404).json({ error: "Session not found" });
  if (session.status === "closed") return res.status(410).json({ error: "Session is closed" });

  // Auth + ownership check
  const token = getToken(req);
  const user  = await getUser(token, supabaseUrl, serviceKey);

  // SECURITY: session ownership — authenticated sessions require matching user
  if (session.user_id && (!user || user.id !== session.user_id)) {
    logSecurityEvent(supabase, "security_session_ownership_blocked", {
      route: "/api/chat?action=message", session_id,
      owner_id: session.user_id?.slice(0, 8),
      caller_id: user?.id?.slice(0, 8) || "anon",
      ip_hash: hashIp(req.headers["x-forwarded-for"] || req.socket?.remoteAddress),
    });
    return res.status(403).json({ error: "Not your session" });
  }

  if (!user && session.turn_count >= FREE_TURNS_LIMIT) {
    return res.status(402).json({ error: "Free limit reached", turns_used: session.turn_count, auth_required: true });
  }

  if (user) {
    const { data: sub } = await supabase.from("user_subscriptions").select("is_active,status").eq("user_id", user.id).maybeSingle();
    const isPremium = !!(sub?.is_active || sub?.status === "active");
    if (!isPremium && session.turn_count >= FREE_TURNS_LIMIT) {
      return res.status(402).json({ error: "Free limit reached", turns_used: session.turn_count, upgrade_required: true });
    }
    // Pre-check token balance before making expensive AI call
    const { data: usagePre } = await supabase
      .from("user_usage")
      .select("free_tokens_total, free_tokens_used, paid_tokens_total, paid_tokens_used, topup_tokens_balance")
      .eq("user_id", user.id)
      .maybeSingle();
    if (usagePre) {
      const freeRem = Math.max(0, (usagePre.free_tokens_total || 0) - (usagePre.free_tokens_used || 0));
      const paidRem = Math.max(0, (usagePre.paid_tokens_total || 0) - (usagePre.paid_tokens_used || 0));
      const topupRem = Math.max(0, usagePre.topup_tokens_balance || 0);
      if (freeRem + paidRem + topupRem <= 0) {
        return res.status(402).json({ error: "Token limit reached", remaining_tokens: 0, upgrade_required: true });
      }
    }
  }

  // Check if user is asking about history — search imported data if so
  let historyContext = "";
  if (user) {
    const lastUserMsg = messages[messages.length - 1]?.content?.toLowerCase() || "";
    const historyPatterns = [
      /find|such|finde|zeig|show|letzt|last|chat|gespräch|conversation|verlauf|history/,
      /was (war|haben|hatten|wurde)/,
      /woran (hab|arbeit)/,
      /erinnerst.*du.*dich/,
      /weißt.*du.*noch/,
      /projekt|project/,
    ];
    const wantsHistory = historyPatterns.some(p => p.test(lastUserMsg));

    if (wantsHistory) {
      try {
        // Extract search terms from user message (skip stop words)
        const stopWords = new Set(["was","war","ich","du","wir","der","die","das","ein","eine","mit","und","oder","von","zu","in","auf","an","für","über","nach","wie","wo","wann","hab","habe","haben","hatten","wurde","finde","zeig","such","mir","mal","bitte","den","dem","denn","noch","dich","sich","es","ist","sind","hat","nicht","auch","nur","schon","kann","kannst","mein","meine","meinen","letzten","letzte"]);
        const searchTerms = lastUserMsg
          .replace(/[^\wäöüß\s]/gi, "")
          .split(/\s+/)
          .filter(t => t.length > 2 && !stopWords.has(t))
          .slice(0, 5)
          .join(" ");

        if (searchTerms.length > 2) {
          const supabaseUrl = process.env.SUPABASE_URL;
          const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
          const searchSupabase = createClient(supabaseUrl, serviceKey);

          // Get active sources
          const { data: sources } = await searchSupabase
            .from("source_connections")
            .select("id")
            .eq("user_id", user.id)
            .eq("status", "active");

          if (sources?.length > 0) {
            const sourceIds = sources.map(s => s.id);
            const { data: rawItems } = await searchSupabase
              .from("source_items")
              .select("raw_content")
              .in("source_id", sourceIds)
              .eq("zone", "A");

            if (rawItems?.length > 0) {
              const terms = searchTerms.toLowerCase().split(/\s+/);
              const matches = [];

              for (const item of rawItems) {
                if (!item.raw_content) continue;
                const convos = item.raw_content.split(/(?=^# )/m).filter(c => c.trim());
                for (const conv of convos) {
                  const lower = conv.toLowerCase();
                  const matchCount = terms.filter(t => lower.includes(t)).length;
                  if (matchCount > 0) {
                    const titleMatch = conv.match(/^# (.+)/);
                    const title = titleMatch ? titleMatch[1].trim() : null;
                    if (title && title !== "Untitled") {
                      matches.push({ title, content: conv.slice(0, 600), relevance: matchCount });
                    }
                  }
                }
              }

              matches.sort((a, b) => b.relevance - a.relevance);
              const top = matches.slice(0, 3);
              if (top.length > 0) {
                historyContext = "\n\n[SUCHERGEBNIS AUS IMPORTIERTEN GESPRÄCHEN — nutze diese Informationen für deine Antwort]:\n" +
                  top.map(m => `Gespräch "${m.title}":\n${m.content}`).join("\n\n---\n\n");
                console.log(`[chat] history search: "${searchTerms}" → ${top.length} results`);
              }
            }
          }
        }
      } catch (e) {
        console.warn("[chat] history search error:", e?.message);
      }
    }
  }

  // Call AI via Multi-AI Router
  const turnNumber = session.turn_count + 1;

  // Brainstorm phase injection — injected as system message on every turn
  let brainstormPhaseInjection = null;
  if (session.brainstorm_config && session.created_at) {
    try {
      const { phase, progress } = calcBrainstormPhase(session.brainstorm_config, session.created_at);
      brainstormPhaseInjection = buildBrainstormPhaseInjection(phase, progress);
    } catch (e) {
      console.warn("[chat] brainstorm phase calc error:", e?.message);
    }
  }

  // Turn-aware routing nudge — injected as system message
  // Fires on turns 4–5 to give Sophie time for natural conversation first
  // Suppressed when session is already in a specific mode (brainstorm_config set = brainstorm mode)
  // voiceNudge is suppressed when session already has an active mode (e.g. brainstorm)
  const sessionAlreadyModed = !!(session.brainstorm_config);
  const voiceNudge = sessionAlreadyModed
    ? null
    : turnNumber === 4
      ? "[INTERNAL] Turn 4. If the user's intent is clear by now, end your response with [MODE_DETECTED:xxx] where xxx is one of: explore, decide, reflect, chill, brainstorm, meeting, salespitch. If intent is still unclear, continue the conversation naturally."
      : turnNumber === 5
        ? "[INTERNAL] Turn 5. You should now have enough context. Identify the best mode and end your response with [MODE_DETECTED:xxx] where xxx is one of: explore, decide, reflect, chill, brainstorm, meeting, salespitch."
        : null;

  // Build messages — support multimodal (files with images/documents)
  const buildContent = (m) => {
    const text = String(m.content || "").slice(0, 4000);
    if (!m.files || !Array.isArray(m.files) || m.files.length === 0) return text;

    // Validate file sizes server-side (5MB base64 ≈ 6.7MB string)
    const MAX_DATAURL_LEN = 7 * 1024 * 1024;
    const parts = [{ type: "text", text: text || "Analysiere diese Datei(en):" }];

    for (const f of m.files.slice(0, 3)) {
      if (!f.dataUrl || f.dataUrl.length > MAX_DATAURL_LEN) continue;
      const isImage = f.type?.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(f.name || "");
      if (isImage) {
        // OpenAI Vision format — works with gpt-4o and gpt-4o-mini
        parts.push({ type: "image_url", image_url: { url: f.dataUrl, detail: "low" } });
      } else {
        // Documents — route by type
        const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name || "");
        if (f.type === "text/plain" && f.dataUrl.startsWith("data:text/")) {
          // Plain text — decode and inline
          try {
            const b64 = f.dataUrl.split(",")[1] || "";
            const decoded = Buffer.from(b64, "base64").toString("utf-8").slice(0, 8000);
            parts.push({ type: "text", text: `[FILE: ${f.name}]\n${decoded}\n[/FILE]` });
          } catch { parts.push({ type: "text", text: `[Datei: ${f.name} — konnte nicht gelesen werden]` }); }
        } else if (isPdf) {
          // PDF — use OpenAI inline file format (supported by gpt-4o / gpt-4o-mini)
          parts.push({ type: "file", file: { filename: f.name || "document.pdf", file_data: f.dataUrl } });
        } else {
          // DOCX/PPTX/other — send as inline file (GPT-4o supports various formats)
          parts.push({ type: "file", file: { filename: f.name || "document", file_data: f.dataUrl } });
        }
      }
    }
    return parts.length > 1 ? parts : text;
  };

  // SECURITY: rebuild system prompt server-side — never trust client input
  const { fullSystemPrompt: serverSystemPrompt } = await buildServerSystemPrompt({
    supabase, user,
    sessionMode: session.session_mode || null,
    brainstormConfig: session.brainstorm_config || null,
    language: session.language || "en",
    conversationPolicy: session.conversation_policy || null,
  });

  const routerMessages = [
    { role: "system", content: serverSystemPrompt },
    ...messages
      .filter(m => m.role === "user" || m.role === "assistant")
      .map(m => ({ role: m.role, content: m.role === "user" ? buildContent(m) : String(m.content || "").slice(0, 4000) })),
    ...(historyContext ? [{ role: "system", content: historyContext }] : []),
    ...(brainstormPhaseInjection ? [{ role: "system", content: brainstormPhaseInjection }] : []),
    ...(voiceNudge ? [{ role: "system", content: voiceNudge }] : []),
  ];

  // Realtime tools: inject tool instructions into system prompt
  // AI decides contextually when to request a tool (no keyword matching)
  routerMessages.push({ role: "system", content:
    `ECHTZEIT-TOOLS: Du hast Zugriff auf externe Datenquellen über Tools. Sage NIEMALS "Ich habe keinen Zugriff" oder "Ich kann nicht im Internet suchen". ` +
    `Du HAST Zugriff — nutze die Tools! Antworte NUR mit einem Tool-Tag (sonst nichts), wenn eine dieser Situationen zutrifft:\n` +
    `[TOOL:grounded_search:Suchanfrage] — BEVORZUGT für volatile, aktuelle Fakten: Wer leitet ein Unternehmen? Aktienkurse, Preise, Ergebnisse, Status, aktuelle Ereignisse. Nutze grounded_search wenn sich die Antwort ändern kann und Aktualität wichtig ist.\n` +
    `[TOOL:weather:Ortsname] — Wetter, Temperatur, Outdoor-Bedingungen\n` +
    `[TOOL:search:Suchanfrage] — Web-Suche für detaillierte Recherche mit Snippets und Links. Nutze search wenn du mehrere Quellen oder ausführliche Informationen brauchst.\n` +
    `[TOOL:news:Thema] — aktuelle Nachrichten und Headlines\n` +
    `[TOOL:wiki:Begriff] — Stabiles Faktenwissen, Definitionen, Biographien, Geschichte, Erklärungen. Nutze wiki wenn der User nach zeitlosem Wissen fragt (Was ist...? Wer war...? Wie funktioniert...? Erkläre mir...)\n` +
    `[TOOL:flight:Flugnummer] — Live-Flugstatus, Abflug/Ankunft, Verspätungen, Gate, Terminal. Nutze flight bei jeder Frage zu einem konkreten Flug (z.B. LH1234, EK451)\n` +
    `[TOOL:arrivals:IATA-Code] — Ankunftstafel eines Flughafens (z.B. FRA, PFO, MUC). Nutze arrivals wenn der User fragt was an einem Flughafen landet oder ankommt\n` +
    `[TOOL:departures:IATA-Code] — Abflugtafel eines Flughafens. Nutze departures wenn der User fragt was abfliegt oder wann Maschinen starten\n` +
    `Antworte mit dem Tag ALLEIN — du bekommst die Daten dann automatisch und antwortest basierend darauf. ` +
    `Wenn die Frage rein persönlich oder reflektiv ist (keine Fakten nötig), antworte normal ohne Tag.`
  });

  // Determine user tier for routing
  let userTier = "free";
  if (user) {
    const { data: sub } = await supabase.from("user_subscriptions").select("plan,is_active,status").eq("user_id", user.id).maybeSingle();
    const isActive = !!(sub?.is_active || sub?.status === "active");
    if (isActive) {
      const planName = sub?.plan || "";
      userTier = planName === "premium" ? "premium" : "abo";
    }
  }

  // Language from stored session — no more parsing from client-supplied prompt
  const sessionLang = session.language || "en";

  // SSE streaming mode — opt-in via ?stream=1
  const wantsStream = req.query?.stream === "1";
  let sseStarted = false;
  let clientDisconnected = false;
  let heartbeatTimer = null;

  function startSSE() {
    if (sseStarted) return;
    sseStarted = true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    req.on("close", () => { clientDisconnected = true; clearInterval(heartbeatTimer); });
    // Keepalive every 5s — prevents proxies/browsers from killing "idle" connections
    heartbeatTimer = setInterval(() => {
      if (!clientDisconnected) res.write(":keepalive\n\n");
    }, 5000);
  }

  function emitStatus(type) {
    if (!wantsStream || clientDisconnected) return;
    if (!sseStarted) startSSE();
    const text = statusText(type, sessionLang);
    if (text) sseWrite(res, "status", { text });
  }

  function emitDone(payload) {
    clearInterval(heartbeatTimer);
    if (wantsStream) {
      if (!sseStarted) startSSE();
      if (!clientDisconnected) { sseWrite(res, "done", payload); res.end(); }
      return true;
    }
    return false;
  }

  function emitError(code, error) {
    clearInterval(heartbeatTimer);
    if (wantsStream && sseStarted) {
      if (!clientDisconnected) { sseWrite(res, "error", { error, code }); res.end(); }
      return true;
    }
    return false;
  }

  // Anonymous users → always OpenAI (no multi-AI routing)
  if (!user) {
    // Curated responses for predictable trigger questions (bypass AI entirely)
    const lastUserMsg = messages.filter(m => m.role === "user").pop();
    const curatedReply = getCuratedResponse(lastUserMsg?.content);
    if (curatedReply) {
      await supabase.from("chat_sessions").update({
        turn_count: session.turn_count + 1,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", session_id);
      const payload = {
        ok: true, reply: curatedReply,
        voice_offer: false, voice_confirmed: false,
        detected_mode: null, turn_count: session.turn_count + 1,
        model: "curated", provider: "curated",
        routing_reason: "curated-trigger", import_hint: false,
      };
      if (emitDone(payload)) return;
      return res.status(200).json(payload);
    }

    // Soft onboarding — respond to the user FIRST, then weave in naturally
    if (turnNumber === 1) {
      routerMessages.push({ role: "system", content: "First message from this user. Respond naturally to what they said. If it fits, casually ask their name somewhere in your response (e.g. 'Wie soll ich dich nennen?' or 'What's your name?'). If the user asked something specific, answer that FIRST — the name question is secondary." });
    } else if (turnNumber === 2 && !routerMessages.some(m => m.content?.includes?.("name"))) {
      routerMessages.push({ role: "system", content: "If you don't know the user's name yet, ask casually. If you do, use it once. Respond naturally to their message first." });
    }

    const openaiAdapter = getAdapter("openai");
    const aiResp = await openaiAdapter.complete({
      messages: routerMessages, model: "gpt-4o-mini", maxTokens: 1024, temperature: 0.85,
    });
    let rawReply = normalizeResponse(aiResp.content || "", aiResp.provider);
    if (!rawReply) {
      if (emitError(502, "Empty response from AI")) return;
      return res.status(502).json({ error: "Empty response from AI" });
    }

    // Question loop guard — regenerate if 3rd consecutive question
    // Guards disabled — caused more harm than good (generic rewrites, language bugs, latency)
    // Curated responses handle the critical trigger questions instead

    // Anonymous users: tools blocked — tease once, then just strip the tag
    const toolMatch = rawReply.match(/\[TOOL:(weather|search|news|wiki|flight|arrivals|departures|grounded_search):([^\]]+)\]/);
    if (toolMatch) {
      if (turnNumber <= 2) {
        // First time: tease the capability once
        const [, toolType] = toolMatch;
        const toolNames = { weather: "Wetter", search: "Web-Suche", news: "News", wiki: "Wikipedia", flight: "Flugstatus", arrivals: "Ankünfte", departures: "Abflüge", grounded_search: "Live-Fakten" };
        const toolName = toolNames[toolType] || toolType;
        rawReply = `Ich könnte dir das tatsächlich live zeigen — ${toolName} in Echtzeit abrufen. Dafür brauchst du nur einen kostenlosen Account. Dauert 10 Sekunden, kein Abo nötig!`;
      } else {
        // Already teased — just strip the tool tag, let Sophie answer naturally
        rawReply = rawReply.replace(/\[TOOL:[^\]]+\]/g, "").trim();
        if (!rawReply) rawReply = "Dafür bräuchte ich Internetzugriff — den hast du mit einem kostenlosen Account.";
      }
    }

    // Strip signal tags
    const modeMatch = rawReply.match(/\[MODE_DETECTED:(\w+)\]/) || rawReply.match(/signal_mode\(\s*\{\s*"mode"\s*:\s*"(\w+)"\s*\}\s*\)/);
    const detected_mode = modeMatch ? modeMatch[1].toLowerCase() : null;
    const import_hint = rawReply.includes("[IMPORT_HINT]");
    const reply = rawReply
      .replace(/\s*\[MODE_DETECTED:\w+\]\s*/g, "")
      .replace(/\s*signal_mode\([^)]*\)\s*/g, "")
      .replace(/\s*\[IMPORT_HINT\]\s*/g, "")
      .replace(/\s*\[VOICE_OFFER\]\s*/g, "")
      .replace(/\s*\[VOICE_CONFIRMED\]\s*/g, "")
      .trim();

    await supabase.from("chat_sessions").update({
      turn_count: session.turn_count + 1,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", session_id);

    const anonPayload = {
      ok: true, reply,
      voice_offer: !!detected_mode, voice_confirmed: false,
      detected_mode, turn_count: session.turn_count + 1,
      model: aiResp.model, provider: aiResp.provider,
      routing_reason: "anonymous-openai", import_hint,
    };
    if (emitDone(anonPayload)) return;
    return res.status(200).json(anonPayload);
  }

  // Load profile for onboarding check + eco_mode
  let profileFirstName = "";
  let profile = { eco_mode: false };
  if (user) {
    const { data: prof } = await supabase.from("user_profile").select("first_name,eco_mode").eq("user_id", user.id).maybeSingle();
    profileFirstName = (prof?.first_name || "").trim();
    if (prof) profile = prof;
  }

  // Curated responses for trigger questions (works for all users)
  const lastUserMsgAuth = messages.filter(m => m.role === "user").pop();
  const curatedReplyAuth = getCuratedResponse(lastUserMsgAuth?.content);
  if (curatedReplyAuth) {
    await supabase.from("chat_sessions").update({
      turn_count: session.turn_count + 1,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", session_id);
    const curatedPayload = {
      ok: true, reply: curatedReplyAuth,
      voice_offer: false, voice_confirmed: false,
      detected_mode: null, turn_count: session.turn_count + 1,
      model: "curated", provider: "curated",
      routing_reason: "curated-trigger", import_hint: false,
    };
    if (emitDone(curatedPayload)) return;
    return res.status(200).json(curatedPayload);
  }

  // Soft onboarding for authenticated first-session users — user's question has priority
  const isFirstAuth = !profileFirstName;
  if (isFirstAuth && turnNumber === 1) {
    routerMessages.push({ role: "system", content: "First session with this user — you don't know their name yet. Respond naturally to what they said. If it fits, casually ask their name somewhere in your response. The user's actual question always has priority." });
  } else if (isFirstAuth && turnNumber === 2) {
    routerMessages.push({ role: "system", content: "If you still don't know the user's name, ask casually. If you do, use it once. Always respond to their actual message first." });
  }

  // Check if any message has file attachments (multimodal)
  const hasFiles = messages.some(m => m.files?.length > 0);

  // ── Pre-AI search detection: call search API BEFORE AI when intent is obvious ──
  // If user clearly wants web search (URLs, "suche nach", "recherchiere", "finde ... website"),
  // call the search tool directly and inject results so the AI just formats them.
  const lastUserMsg = messages.filter(m => m.role === "user").pop()?.content || "";
  const searchIntent = detectSearchIntent(lastUserMsg);
  console.log(`[chat] searchIntent: "${searchIntent}" from: "${lastUserMsg.slice(0, 60)}"`);
  if (searchIntent) {
    try {
      emitStatus?.("search");
      const searchResult = await webSearch(searchIntent, { withSources: true });
      const searchData = searchResult.text || searchResult;
      const searchSrcs = searchResult.sources || [];
      if (searchData && !searchData.includes("Keine Ergebnisse")) {
        routerMessages.push({
          role: "system",
          content: `[ECHTZEIT-DATEN]\nDer User hat nach "${searchIntent}" gesucht. Hier sind die Ergebnisse:\n\n${searchData}\n\nAntworte basierend auf diesen Daten. Fasse die wichtigsten Infos zusammen. Kein Tool-Tag.`,
        });
        // Store sources for later attachment to response
        if (searchSrcs.length > 0) {
          routerMessages._preSearchSources = searchSrcs;
        }
      }
    } catch (e) {
      console.warn("[chat] pre-AI search failed:", e?.message);
    }
  }

  // Classify and route (authenticated users only)
  const ctx = classify({ messages: routerMessages }, { userTier, channel: "text", ecoMode: !!profile.eco_mode });
  const decision = route(ctx);

  // Force vision-capable model if files are attached
  if (hasFiles) {
    decision.primary = { provider: "openai", model: "gpt-4o-mini" };
    if (decision.fallback) decision.fallback = { provider: "openai", model: "gpt-4o" };
  }

  // Budget check — degrade if over cap
  if (user) {
    const withinBudget = await checkDailyBudget(user.id, ctx.userTier);
    if (!withinBudget) {
      decision.primary = { provider: "google", model: "gemini-2.5-flash-lite" };
      decision.fallback = { provider: "openai", model: "gpt-4o-mini" };
      decision.reason = "budget-cap-degradation";
    }
  }

  // Execute with fallback — start SSE stream for streaming clients
  if (wantsStream) startSSE();
  let aiResponse;
  const routerStartMs = Date.now();
  try {
    const adapter = getAdapter(decision.primary.provider);
    const timeoutMs = hasFiles ? 25000 : 5000; // PDFs/images need more time
    aiResponse = await Promise.race([
      adapter.complete({ messages: routerMessages, model: decision.primary.model, maxTokens: 1024, temperature: 0.85 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), timeoutMs)),
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
        if (emitError(502, "AI unavailable")) return;
        return res.status(502).json({ error: "AI unavailable" });
      }
    } else {
      console.error("AI Router: primary failed, no fallback", primaryErr?.message);
      if (emitError(502, "AI unavailable")) return;
      return res.status(502).json({ error: "AI unavailable" });
    }
  }

  // Normalize response
  let rawReply = normalizeResponse(aiResponse.content || "", aiResponse.provider);

  if (!rawReply) {
    if (emitError(502, "Empty response from AI")) return;
    return res.status(502).json({ error: "Empty response from AI" });
  }

  // Tool-call detection: if AI responded with [TOOL:type:param], execute tool and re-query
  const toolResult = await executeToolIfNeeded(rawReply, routerMessages, decision.primary, emitStatus);
  let searchSources = routerMessages._preSearchSources || null;
  // Always use tool result reply — covers success, fallback, and error paths
  if (toolResult.reply && toolResult.reply !== rawReply) {
    rawReply = toolResult.reply;
  }
  if (toolResult.toolUsed) {
    if (toolResult.searchSources?.length > 0) searchSources = toolResult.searchSources;
    if (user && toolResult.retryResponse?.usage) {
      trackCost({
        userId: user.id, provider: toolResult.retryResponse.provider, model: toolResult.retryResponse.model,
        inputTokens: toolResult.retryResponse.usage.inputTokens, outputTokens: toolResult.retryResponse.usage.outputTokens,
        costUsd: toolResult.retryResponse.usage.costUsd, latencyMs: 0, routingReason: `tool-${toolResult.toolType}`,
      }).catch(() => {});
    }
  }

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

  // Deduct chat token for authenticated users
  let tokenDeduction = null;
  if (user) {
    try {
      const chatCost = hasFiles ? (TOKEN_COSTS.chat_file_upload || 2) : TOKEN_COSTS.chat_message;
      tokenDeduction = await deductChatTokens(supabase, user.id, chatCost);
      if (tokenDeduction.exhausted) {
        // Still return this response but signal exhaustion
        console.log(`[chat] tokens exhausted for user ${user.id.slice(0, 8)}`);
      }
    } catch (e) {
      console.error("[chat] token deduction error:", e?.message);
    }
  }

  // Second Opinion: auto-trigger for high-risk requests (authenticated users only)
  let secondOpinionMeta = null;
  const soShouldTrigger = user && shouldTriggerSecondOpinion(ctx);
  console.log(`[SecondOpinion] risk=${ctx.risk} tier=${ctx.userTier} trigger=${soShouldTrigger}`);
  if (soShouldTrigger) {
    try {
      console.log(`[SecondOpinion] Starting — primary=${aiResponse.provider}/${aiResponse.model}`);
      const soStart = Date.now();
      const soResult = await getSecondOpinion(
        routerMessages,
        { content: rawReply, provider: aiResponse.provider, model: aiResponse.model },
        { userId: user.id },
      );
      console.log(`[SecondOpinion] Done in ${Date.now() - soStart}ms — confidence=${soResult.confidence} agreement=${soResult.agreementLevel} synthesized=${soResult.synthesized} providers=${soResult.providers.join(',')}`);
      secondOpinionMeta = {
        confidence: soResult.confidence,
        agreementLevel: soResult.agreementLevel,
        synthesized: soResult.synthesized,
        providers: soResult.providers,
      };
      if (soResult.synthesized) {
        rawReply = soResult.result;
      }
    } catch (err) {
      console.error("Second opinion error (non-fatal):", err?.message);
    }
  }

  // Detect and strip routing signal tags (multiple formats: OpenAI vs Claude)
  const modeMatch = rawReply.match(/\[MODE_DETECTED:(\w+)\]/)
    || rawReply.match(/signal_mode\(\s*\{\s*"mode"\s*:\s*"(\w+)"\s*\}\s*\)/);
  const detected_mode = modeMatch ? modeMatch[1].toLowerCase() : null;
  const voice_offer     = !!detected_mode; // backwards compat: mode detection triggers the CTA
  const voice_confirmed = rawReply.includes("[VOICE_CONFIRMED]");
  const import_hint = rawReply.includes("[IMPORT_HINT]");

  // Detect and save learned rules
  const learnRuleMatch = rawReply.match(/\[LEARN_RULE:\s*(.+?)\]/);
  if (learnRuleMatch && user) {
    const rawContent = learnRuleMatch[1].trim();
    // Parse "Titel | Regel" format, fallback to rule-only
    const pipeIdx = rawContent.indexOf('|');
    const title = pipeIdx > 0 ? rawContent.slice(0, pipeIdx).trim() : '';
    const ruleText = pipeIdx > 0 ? rawContent.slice(pipeIdx + 1).trim() : rawContent;
    if (ruleText.length > 5 && ruleText.length < 500) {
      try {
        const { data: prof } = await supabase.from('user_profile').select('custom_rules').eq('user_id', user.id).maybeSingle();
        const rules = Array.isArray(prof?.custom_rules) ? prof.custom_rules : [];
        if (rules.length < 20 && !rules.some(r => r.rule === ruleText)) {
          rules.push({ title: title || '', rule: ruleText, context: '', created_at: new Date().toISOString() });
          await supabase.from('user_profile').update({ custom_rules: rules }).eq('user_id', user.id);
          console.log(`[chat] learned rule for ${user.id.slice(0, 8)}: "${title}" → "${ruleText}"`);
        }
      } catch (e) { console.error('[chat] save rule failed:', e?.message); }
    }
  }

  let reply = rawReply
    .replace(/\s*\[MODE_DETECTED:\w+\]\s*/g, "")
    .replace(/\s*signal_mode\([^)]*\)\s*/g, "")
    .replace(/\s*\[VOICE_OFFER\]\s*/g, "")
    .replace(/\s*\[VOICE_CONFIRMED\]\s*/g, "")
    .replace(/\s*\[IMPORT_HINT\]\s*/g, "")
    .replace(/\s*\[LEARN_RULE:[^\]]*\]\s*/g, "")
    .replace(/\s*\[TOOL:[^\]]*\]\s*/g, "")
    .replace(/\[ECHTZEIT-DATEN\]\s*/g, "")
    .trim();

  // Safety net: never return empty reply to client
  if (!reply && searchSources?.length) {
    reply = "Hier ist was ich gefunden habe:\n\n" + searchSources.map(s => `- [${s.title}](${s.url})`).join("\n");
  } else if (!reply) {
    // Last resort: if user asked for a search, do it NOW and return results directly
    const lastMsg = messages.filter(m => m.role === "user").pop()?.content || "";
    const rescueQuery = detectSearchIntent(lastMsg);
    if (rescueQuery) {
      try {
        const rescueResult = await webSearch(rescueQuery, { withSources: true });
        const rescueData = rescueResult.text || rescueResult;
        const rescueSrcs = rescueResult.sources || [];
        if (rescueData && !rescueData.includes("Keine Ergebnisse")) {
          reply = rescueData;
          if (rescueSrcs.length > 0) searchSources = rescueSrcs;
        }
      } catch (_) {}
    }
    if (!reply) {
      reply = "Hmm, da ist etwas schiefgegangen. Kannst du das nochmal anders formulieren?";
    }
  }

  // Increment turn count + link user if just authenticated
  const updatePatch = {
    turn_count: session.turn_count + 1,
    last_message_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (user && !session.user_id) updatePatch.user_id = user.id;

  await supabase.from("chat_sessions").update(updatePatch).eq("id", session_id);

  const responsePayload = {
    ok: true,
    reply,
    voice_offer,
    voice_confirmed,
    detected_mode,
    turn_count: session.turn_count + 1,
    model: aiResponse.model,
    provider: aiResponse.provider,
    routing_reason: decision.reason,
    import_hint: import_hint,
    ...(tokenDeduction && { remaining_tokens: tokenDeduction.remaining }),
    ...(secondOpinionMeta && { second_opinion: secondOpinionMeta }),
    ...(searchSources && { search_sources: searchSources }),
  };

  if (emitDone(responsePayload)) return;
  return res.status(200).json(responsePayload);
}

// ---------------------------------------------------------------------------
// Action: end
// ---------------------------------------------------------------------------

async function handleEnd(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body && typeof body === "object" ? body : {};

  const { session_id, transcript, _token: bodyToken } = body;
  if (!session_id) return res.status(400).json({ error: "Missing session_id" });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabase    = createClient(supabaseUrl, serviceKey);

  // Token from header (normal fetch) or body fallback (sendBeacon can't set headers)
  const token = getToken(req) || bodyToken || null;
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
          chat_session_id: session_id,
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
