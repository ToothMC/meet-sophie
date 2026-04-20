// api/extra-intelligence/research.js
// Recherche-Endpoint fuer den +Intelligence-Voice-Modus.
// Wird vom WebRTC-Client via Realtime-Tool (web_search) aufgerufen, wenn
// Sophie im passiven Listening-Modus einen Fakt nachschlagen soll.
//
// Sicherheits-Layer (XI-4, Audit-Findings):
// - Premium-only (Header-Check reicht nicht, DB-Subscription muss "premium" sein)
// - Privacy-ACK in xi_privacy_acceptances erforderlich (Defense-in-Depth:
//   verhindert Research-Calls ausserhalb des UI-Flows)
// - Per-User Rate-Limit: max 30 Queries pro 60 Sekunden, sonst 429
// - Jede Query wird in analytics_events geloggt (Audit-Trail + Volumen-Analyse)
//
// Recherche-Flow selbst: Promise.any ueber groundedSearch, Wikipedia, webSearch;
// Gewinner wird in einen Satz (Telegramm-Stil) kondensiert via gpt-4o-mini.

import { createClient } from "@supabase/supabase-js";
import { groundedSearch, webSearch, getWikipedia } from "../ai/tools.js";
import { CURRENT_XI_PRIVACY_VERSION } from "../../lib/xi-constants.js";

const XI_ENABLED = String(process.env.EXTRA_INTELLIGENCE_ENABLED || "false").toLowerCase() === "true";

// Per-User Rate-Limiter (in-memory, reset on cold-start — gleiches Pattern wie api/track.js).
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;
const rateMap = new Map();

function isRateLimited(userId) {
  const now = Date.now();
  const entry = rateMap.get(userId);
  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    rateMap.set(userId, { start: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  if (!XI_ENABLED) {
    return res.status(404).json({ error: "extra_intelligence_not_available" });
  }

  // --- Auth ---
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "no_token" });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "missing_env" });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "invalid_token" });

  // --- Rate-Limit pro User (XI-4) ---
  if (isRateLimited(user.id)) {
    return res.status(429).json({ error: "rate_limited", retry_after_s: 60 });
  }

  // --- Premium + Privacy-ACK in parallel ---
  const [subResult, ackResult] = await Promise.all([
    supabase
      .from("user_subscriptions")
      .select("is_active, status, plan")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("xi_privacy_acceptances")
      .select("id")
      .eq("user_id", user.id)
      .eq("version", CURRENT_XI_PRIVACY_VERSION)
      .order("accepted_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const sub = subResult.data;
  const isPremium = !!(sub?.is_active || sub?.status === "active" || sub?.status === "trialing");
  if (!isPremium || String(sub?.plan || "").toLowerCase() !== "premium") {
    return res.status(402).json({ error: "premium_required" });
  }

  if (!ackResult.data) {
    return res.status(412).json({
      error: "xi_privacy_ack_needed",
      current_version: CURRENT_XI_PRIVACY_VERSION,
    });
  }

  // --- Input ---
  const query = String(req.body?.query || "").slice(0, 300).trim();
  const action = String(req.body?.action || "reference_unknown");
  const language = String(req.body?.language || "de").toLowerCase();
  if (!query) return res.status(400).json({ error: "query_required" });

  // --- Research: parallele Quellen, erste mit Fakten gewinnt ---
  let facts = [];
  let sources = [];
  let winner = null;

  const wrap = (p, name, extract) =>
    p.then(r => {
      const f = extract(r);
      if (f && f.length) return { name, facts: f, sources: r?.sources || [] };
      return Promise.reject(new Error(`${name}: empty`));
    });

  const racers = [
    wrap(groundedSearch(query), "grounded", r => r?.facts || []),
    wrap(getWikipedia(query),   "wiki",     r => (r?.summary ? [r.summary] : [])),
    wrap(webSearch(query),      "web",      r => (r?.results || []).slice(0, 2).map(x => x.description || x.title).filter(Boolean)),
  ];

  try {
    // 8s Timeout: verhindert, dass Promise.any auf die langsamste Quelle wartet
    // wenn alle fehlschlagen. Messung zeigte no_facts bis 13s, Erfolge bis ~9.5s —
    // 8s kappt Ausreisser, bewahrt typische Erfolgs-Latenzen.
    const first = await Promise.race([
      Promise.any(racers),
      new Promise((_, reject) => setTimeout(() => reject(new Error("research_timeout")), 8000)),
    ]);
    facts   = first.facts;
    sources = first.sources;
    winner  = first.name;
  } catch (e) {
    const outcome = e?.message === "research_timeout" ? "no_facts_timeout" : "no_facts";
    // fire-and-forget analytics on no-facts outcome (echtes fail vs. timeout getrennt)
    supabase.from("analytics_events").insert({
      user_id: user.id,
      event_name: "xi_research",
      meta: { action, language, query_len: query.length, source: null, outcome },
    }).then(() => {}, () => {});
    return res.status(200).json({ text: "", reason: outcome });
  }

  // Shortcut: wenn Quelle kurz + Satzende + nicht nur die Query → kein Condense
  {
    const f0 = String(facts[0] || "").trim();
    const shortEnough = f0.length > 20 && f0.length <= 180;
    const hasSentenceEnd = /[.!?]/.test(f0);
    const notJustQuery = f0.toLowerCase() !== query.toLowerCase();
    if (shortEnough && hasSentenceEnd && notJustQuery) {
      const oneSentence = (f0.split(/(?<=[.!?])\s+/)[0] || f0).trim();
      supabase.from("analytics_events").insert({
        user_id: user.id,
        event_name: "xi_research",
        meta: { action, language, query_len: query.length, source: winner, outcome: "shortcut", tokens_used: 0 },
      }).then(() => {}, () => {});
      return res.status(200).json({
        text: oneSentence,
        language,
        sources_count: sources.length,
        tokens_used: 0,
        source: winner,
        skipped_condense: true,
      });
    }
  }

  // --- Ultra-knappe Kondensation: 1 Satz, Telegramm-Stil ---
  const isEN = language === "en";
  const condenseSystem = isEN
    ? `You turn research facts into a single ultra-short answer. HARD RULES:
- Exactly ONE sentence. Under 15 words.
- NEVER repeat the question. NEVER paraphrase it. Start with the answer.
- Telegraph style. Just the fact.
- No greetings, no "Interesting:", no "Actually", no "It turns out".
- No opinions, no sources, no URLs.

EXAMPLES:
Q: "What's the highest mountain?"  ->  "Mount Everest, 8849 metres."
Q: "Who wrote 'The Swarm'?"  ->  "Frank Schaetzing, 2004 eco-thriller."
Q: "Kepler-22b?"  ->  "Exoplanet, ~620 light-years away, potentially habitable."`
    : `Du formst Recherche-Fakten in EINE ultra-knappe Antwort. HARTE REGELN:
- Genau EIN Satz. Unter 15 Woertern.
- NIE die Frage wiederholen. NIE paraphrasieren. Starte direkt mit dem Fakt.
- Telegramm-Stil. Nur der Fakt.
- Keine Begruessung, kein "Interessant:", kein "Uebrigens", kein "Tatsaechlich".
- Keine Meinung, keine Quellen, keine URLs.

BEISPIELE:
Frage: "Wie heisst der hoechste Berg?"  ->  "Der Mount Everest, 8849 Meter."
Frage: "Wer hat 'Der Schwarm' geschrieben?"  ->  "Frank Schaetzing, 2004, Oeko-Thriller."
Frage: "Kepler-22b?"  ->  "Exoplanet, ~620 Lichtjahre entfernt, potenziell bewohnbar."`;

  const condenseUser = isEN
    ? `Query: "${query}"\n\nFacts:\n${facts.map((f, i) => `${i + 1}. ${f}`).join("\n")}\n\nOne-sentence answer:`
    : `Frage/Bezug: "${query}"\n\nFakten:\n${facts.map((f, i) => `${i + 1}. ${f}`).join("\n")}\n\nEin-Satz-Antwort:`;

  let text = "";
  let condenseTokens = 0;
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        max_tokens: 50,
        messages: [
          { role: "system", content: condenseSystem },
          { role: "user", content: condenseUser },
        ],
      }),
    });
    if (resp.ok) {
      const data = await resp.json();
      text = String(data?.choices?.[0]?.message?.content || "").trim();
      condenseTokens = data?.usage?.total_tokens || 0;

      // Hard-Clamp: genau 1 Satz
      const firstSentence = text.split(/(?<=[.!?])\s+/)[0] || text;
      text = firstSentence.trim();

      // Anti-Wiederhol-Guard
      const q = query.toLowerCase();
      if (q.length > 10 && text.toLowerCase().includes(q)) {
        text = text.replace(new RegExp(query, "i"), "").replace(/^[\s,:;-]+/, "").trim();
        if (text) text = text.charAt(0).toUpperCase() + text.slice(1);
      }
    }
  } catch (e) {
    console.warn("[xi/research] condense failed:", e?.message);
  }

  if (!text) {
    // Fallback: erster Fakt roh (gekuerzt)
    text = String(facts[0] || "").slice(0, 220);
  }

  // analytics: Audit-Trail + Volumen-Analyse (fire-and-forget)
  supabase.from("analytics_events").insert({
    user_id: user.id,
    event_name: "xi_research",
    meta: {
      action, language,
      query_len: query.length,
      source: winner,
      outcome: "ok",
      tokens_used: condenseTokens,
      sources_count: sources.length,
    },
  }).then(() => {}, () => {});

  return res.status(200).json({
    text,
    language,
    sources_count: sources.length,
    tokens_used: condenseTokens,
    source: winner,
  });
}
