// api/chat.js — Text-Chat Endpoint (Phase 1)
// ?action=start   — Session öffnen, Context laden, System-Prompt bauen
// ?action=message — Nachricht an Claude weiterleiten, Antwort zurückgeben
// ?action=end     — Session schließen, memory-update aufrufen, Thinking Report
// ?action=context — User-Context laden (gecacht 5 Min clientseitig)
// ?action=usage   — Free-Limit prüfen (Turns)

import { createClient } from "@supabase/supabase-js";
import { buildSophiePrompt, mapPlanToTier } from "../lib/sophie-core.js";
import { classify, route, shouldTriggerSecondOpinion } from "../lib/ai/classifier.js";
import { getAdapter } from "../lib/ai/adapters/index.js";
import { trackCost, checkDailyBudget } from "../lib/ai/cost-tracker.js";
import { normalizeResponse } from "../lib/ai/persona-normalizer.js";
import { getSecondOpinion } from "./ai/second-opinion.js";
import { getWeather, webSearch, getNews, getWikipedia } from "./ai/tools.js";
import { TOKEN_COSTS } from "../lib/billing-constants.js";

const FREE_TURNS_LIMIT = 10;
const AUTH_NUDGE_AT_TURN = 3;

// ---------------------------------------------------------------------------
// Chat Opener Pool — returned directly from action=start, no AI call needed
// ---------------------------------------------------------------------------
// Free/anonymous: thinking partner openers (structured, reflective)
const CHAT_OPENERS_FREE = {
  de: [
    "Was beschäftigt dich gerade?",
    "Was geht dir gerade durch den Kopf?",
    "Wobei wünschst du dir gerade Klarheit?",
    "Worüber möchtest du gerade nachdenken?",
  ],
  en: [
    "What's on your mind right now?",
    "What are you trying to figure out?",
    "What would you like to think through?",
    "Where are you stuck?",
  ],
  fr: [
    "Qu'est-ce qui t'occupe l'esprit en ce moment?",
    "Sur quoi aimerais-tu avoir plus de clarté?",
    "À quoi veux-tu réfléchir?",
    "Qu'est-ce qui te préoccupe?",
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
function getOpener(lang, isPaid = false) {
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
  const { data: usage } = await supabase
    .from("user_usage")
    .select("free_tokens_total, free_tokens_used, paid_tokens_total, paid_tokens_used, topup_tokens_balance")
    .eq("user_id", userId)
    .maybeSingle();

  if (!usage) return { ok: false, remaining: 0, exhausted: true };

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
  let importedContext = "";

  if (user) {
    try {
      const [profRes, relRes, subRes, sessRes, importRes] = await Promise.all([
        supabase.from("user_profile").select("first_name,preferred_name,preferred_addressing,preferred_pronoun,preferred_language,notes,occupation,conversation_style,topics_like,topics_avoid").eq("user_id", user.id).maybeSingle(),
        supabase.from("user_relationship").select("tone_baseline,openness_level,emotional_patterns,last_interaction_summary,communication_style,thinking_pattern").eq("user_id", user.id).maybeSingle(),
        supabase.from("user_subscriptions").select("is_active,status,plan").eq("user_id", user.id).maybeSingle(),
        supabase.from("user_sessions").select("session_date,emotional_tone,stress_level,closeness_level,short_summary").eq("user_id", user.id).order("session_date", { ascending: false }).limit(5),
        // Load imported insights (Zone B + C) from all active sources
        supabase.from("source_connections").select("id").eq("user_id", user.id).eq("status", "active"),
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

      // Load imported data from active sources
      if (importRes.data?.length > 0) {
        const sourceIds = importRes.data.map(s => s.id);

        // First try Zone B+C (extracted insights)
        const { data: insights } = await supabase
          .from("source_items")
          .select("summary, extracted_insights, content_type, zone")
          .in("source_id", sourceIds)
          .in("zone", ["B", "C"])
          .limit(30);

        const insightTexts = (insights || [])
          .map(i => {
            if (i.extracted_insights && Object.keys(i.extracted_insights).length > 0) {
              return JSON.stringify(i.extracted_insights);
            }
            return i.summary;
          })
          .filter(t => t && t !== "Import von claude" && t !== "Import von chatgpt" && t.length > 10);

        if (insightTexts.length > 0) {
          importedContext = "\n\nIMPORTIERTER KONTEXT (aus früheren KI-Gesprächen des Users):\n" + insightTexts.slice(0, 20).join("\n");
        } else {
          // Fallback: build structured overview from Zone A raw content
          const { data: rawItems } = await supabase
            .from("source_items")
            .select("raw_content")
            .in("source_id", sourceIds)
            .eq("zone", "A")
            .limit(5);

          const rawTexts = (rawItems || [])
            .map(i => i.raw_content)
            .filter(Boolean)
            .join("\n\n");

          if (rawTexts.length > 0) {
            // Extract conversation titles for overview
            const titles = rawTexts.split("\n")
              .filter(line => line.startsWith("# ") && line !== "# Untitled")
              .map(line => line.replace("# ", "").trim())
              .filter(t => t.length > 3);

            // Extract user messages for key topics (skip short/trivial ones)
            const userMsgs = rawTexts.split("\n")
              .filter(line => line.startsWith("[human]: "))
              .map(line => line.replace("[human]: ", "").trim())
              .filter(msg => msg.length > 30 && !msg.match(/^(ja|nein|ok|danke|hi|hallo|gut)/i));

            // Build structured context
            const parts = [];
            if (titles.length > 0) {
              parts.push("GESPRÄCHSTHEMEN (" + titles.length + " Gespräche):\n" + titles.slice(0, 40).map(t => "- " + t).join("\n"));
            }
            if (userMsgs.length > 0) {
              // Sample diverse user messages (first, middle, recent)
              const sampled = [];
              if (userMsgs.length > 0) sampled.push(userMsgs[0]);
              if (userMsgs.length > 5) sampled.push(userMsgs[Math.floor(userMsgs.length / 3)]);
              if (userMsgs.length > 10) sampled.push(userMsgs[Math.floor(userMsgs.length * 2 / 3)]);
              if (userMsgs.length > 2) sampled.push(userMsgs[userMsgs.length - 1]);
              parts.push("BEISPIEL-ANFRAGEN DES USERS:\n" + sampled.map(m => "- " + m.slice(0, 150)).join("\n"));
            }

            if (parts.length > 0) {
              importedContext = "\n\nIMPORTIERTER KONTEXT (aus früheren KI-Gesprächen des Users — nutze diese Informationen um den User besser zu verstehen und auf seine Projekte/Themen einzugehen):\n" + parts.join("\n\n");
            }
          }
        }
      }
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

  console.log("[chat] start:", {
    userId: user?.id?.slice(0, 8) || "anon",
    isFirstSession,
    firstName: profile.first_name || "(empty)",
    hasSummary: !!(rel.last_interaction_summary?.trim()),
    tier,
    lang: preferredLanguage,
  });

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

  // Append imported context to system prompt
  if (importedContext) {
    console.log("[chat] imported context loaded:", importedContext.length, "chars");
  } else {
    console.log("[chat] no imported context found for user:", user?.id?.slice(0, 8) || "anon");
  }
  const fullSystemPrompt = importedContext
    ? systemPrompt + importedContext
    : systemPrompt;

  const opener = getOpener(preferredLanguage, isPremium);

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
    system_prompt: fullSystemPrompt,
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

  // Turn-aware routing nudge — injected as system message
  // Fires on turns 4–5 to give Sophie time for natural conversation first
  const voiceNudge = turnNumber === 4
    ? "[INTERNAL] Turn 4. If the user's intent is clear by now, end your response with [MODE_DETECTED:xxx] where xxx is one of: explore, decide, reflect, relax, brainstorm, meeting, salespitch. If intent is still unclear, continue the conversation naturally."
    : turnNumber === 5
    ? "[INTERNAL] Turn 5. You should now have enough context. Identify the best mode and end your response with [MODE_DETECTED:xxx] where xxx is one of: explore, decide, reflect, relax, brainstorm, meeting, salespitch."
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
          // DOCX/PPTX — not natively supported, hint to user
          parts.push({ type: "text", text: `[Datei: ${f.name} hochgeladen — für beste Ergebnisse bitte als PDF senden]` });
        }
      }
    }
    return parts.length > 1 ? parts : text;
  };

  const routerMessages = [
    { role: "system", content: system_prompt || "" },
    ...messages
      .filter(m => m.role === "user" || m.role === "assistant")
      .map(m => ({ role: m.role, content: m.role === "user" ? buildContent(m) : String(m.content || "").slice(0, 4000) })),
    ...(historyContext ? [{ role: "system", content: historyContext }] : []),
    ...(voiceNudge ? [{ role: "system", content: voiceNudge }] : []),
  ];

  // Realtime tools: inject tool instructions into system prompt
  // AI decides contextually when to request a tool (no keyword matching)
  routerMessages.push({ role: "system", content:
    `ECHTZEIT-TOOLS: Du hast Zugriff auf externe Datenquellen über Tools. Sage NIEMALS "Ich habe keinen Zugriff" oder "Ich kann nicht im Internet suchen". ` +
    `Du HAST Zugriff — nutze die Tools! Antworte NUR mit einem Tool-Tag (sonst nichts), wenn eine dieser Situationen zutrifft:\n` +
    `[TOOL:weather:Ortsname] — Wetter, Temperatur, Outdoor-Bedingungen\n` +
    `[TOOL:search:Suchanfrage] — aktuelle Fakten, Preise, Ereignisse, alles was sich ändern kann\n` +
    `[TOOL:news:Thema] — aktuelle Nachrichten und Headlines\n` +
    `[TOOL:wiki:Begriff] — Faktenwissen, Definitionen, Biographien, Geschichte, Erklärungen. Nutze wiki wenn der User nach konkretem Wissen fragt (Was ist...? Wer war...? Wie funktioniert...? Erkläre mir...)\n` +
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

  // Anonymous users → always OpenAI (no multi-AI routing)
  if (!user) {
    // Inject hard onboarding nudge — anonymous = always first session
    const isFirst = true;
    if (isFirst && turnNumber === 1) {
      routerMessages.push({ role: "system", content: "[CRITICAL] This is a FIRST SESSION. After responding to the user, you MUST end with: 'Übrigens — wie soll ich dich nennen?' Do NOT skip this." });
    } else if (isFirst && turnNumber === 2) {
      routerMessages.push({ role: "system", content: "[CRITICAL] The user should have given their name. Use it once. Then ask: 'Nutzt du schon eine andere KI — ChatGPT, Claude oder so?' Do NOT skip this." });
    }

    const openaiAdapter = getAdapter("openai");
    const aiResp = await openaiAdapter.complete({
      messages: routerMessages, model: "gpt-4o-mini", maxTokens: 1024, temperature: 0.85,
    });
    const rawReply = normalizeResponse(aiResp.content || "", aiResp.provider);
    if (!rawReply) return res.status(502).json({ error: "Empty response from AI" });

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

    return res.status(200).json({
      ok: true, reply,
      voice_offer: !!detected_mode, voice_confirmed: false,
      detected_mode, turn_count: session.turn_count + 1,
      model: aiResp.model, provider: aiResp.provider,
      routing_reason: "anonymous-openai", import_hint,
    });
  }

  // Load profile for onboarding check
  let profileFirstName = "";
  if (user) {
    const { data: prof } = await supabase.from("user_profile").select("first_name").eq("user_id", user.id).maybeSingle();
    profileFirstName = (prof?.first_name || "").trim();
  }

  // Inject onboarding nudge for authenticated first-session users too
  const isFirstAuth = !profileFirstName;
  if (isFirstAuth && turnNumber === 1) {
    routerMessages.push({ role: "system", content: "[CRITICAL] This is a FIRST SESSION. After responding to the user, you MUST end with: 'Übrigens — wie soll ich dich nennen?' Do NOT skip this." });
  } else if (isFirstAuth && turnNumber === 2) {
    routerMessages.push({ role: "system", content: "[CRITICAL] The user should have given their name. Use it once. Then ask: 'Nutzt du schon eine andere KI — ChatGPT, Claude oder so?' Do NOT skip this." });
  }

  // Check if any message has file attachments (multimodal)
  const hasFiles = messages.some(m => m.files?.length > 0);

  // Classify and route (authenticated users only)
  const ctx = classify({ messages: routerMessages }, { userTier, channel: "text" });
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
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 5000)),
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
  let rawReply = normalizeResponse(aiResponse.content || "", aiResponse.provider);

  if (!rawReply) return res.status(502).json({ error: "Empty response from AI" });

  // Tool-call detection: if AI responded with [TOOL:type:param], execute tool and re-query
  const toolMatch = rawReply.match(/\[TOOL:(weather|search|news|wiki):([^\]]+)\]/);
  if (toolMatch) {
    const [, toolType, toolParam] = toolMatch;
    try {
      let toolData;
      if (toolType === "weather") toolData = await getWeather(toolParam.trim());
      else if (toolType === "search") toolData = await webSearch(toolParam.trim());
      else if (toolType === "news") toolData = await getNews(toolParam.trim());
      else if (toolType === "wiki") toolData = await getWikipedia(toolParam.trim());

      if (toolData) {
        // Re-query with tool data injected
        routerMessages.push({ role: "system", content: `[ECHTZEIT-DATEN]\n${toolData}\n\nAntworte jetzt basierend auf diesen aktuellen Daten. Kein Tool-Tag mehr.` });
        const adapter = getAdapter(decision.primary.provider);
        const retryResponse = await Promise.race([
          adapter.complete({ messages: routerMessages, model: decision.primary.model, maxTokens: 1024, temperature: 0.85 }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 5000)),
        ]);
        rawReply = normalizeResponse(retryResponse.content || "", retryResponse.provider);
        // Track retry cost
        if (user && retryResponse.usage) {
          trackCost({
            userId: user.id, provider: retryResponse.provider, model: retryResponse.model,
            inputTokens: retryResponse.usage.inputTokens, outputTokens: retryResponse.usage.outputTokens,
            costUsd: retryResponse.usage.costUsd, latencyMs: 0, routingReason: `tool-${toolType}`,
          }).catch(() => {});
        }
      }
    } catch (e) { console.error(`Tool ${toolType} error:`, e?.message); }
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
  const reply = rawReply
    .replace(/\s*\[MODE_DETECTED:\w+\]\s*/g, "")
    .replace(/\s*signal_mode\([^)]*\)\s*/g, "")
    .replace(/\s*\[VOICE_OFFER\]\s*/g, "")
    .replace(/\s*\[VOICE_CONFIRMED\]\s*/g, "")
    .replace(/\s*\[IMPORT_HINT\]\s*/g, "")
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
    import_hint: import_hint,
    ...(tokenDeduction && { remaining_tokens: tokenDeduction.remaining }),
    ...(secondOpinionMeta && { second_opinion: secondOpinionMeta }),
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
