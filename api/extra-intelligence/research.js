// api/extra-intelligence/research.js — Extra Intelligence Research + Condensation
//
// Nimmt eine Query vom Classifier, recherchiert via groundedSearch (Gemini + Google)
// und kondensiert auf 1-2 Saetze, die Sophie natuerlich vorlesen kann.
// KEINE Persistenz — Rueckgabe ist fluechtig, nur fuer die aktuelle Session.

import { createClient } from "@supabase/supabase-js";
import { groundedSearch, webSearch, getWikipedia } from "../ai/tools.js";

const XI_ENABLED = String(process.env.EXTRA_INTELLIGENCE_ENABLED || "false").toLowerCase() === "true";

// ── Perplexity Sonar: schnelle Live-Web-Antworten (nur fuer XI, nicht geteilt) ──
async function perplexitySearch(query, language) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return { facts: [], sources: [] };

  const isEN = language === "en";
  const systemPrompt = isEN
    ? "Answer in ONE short sentence. Under 20 words. Just the fact. No preamble."
    : "Antworte in EINEM kurzen Satz. Unter 20 Woertern. Nur der Fakt. Keine Einleitung.";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const resp = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "sonar",
        temperature: 0.2,
        max_tokens: 80,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: query },
        ],
      }),
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      console.warn("[xi/research] perplexity HTTP", resp.status);
      return { facts: [], sources: [] };
    }

    const data = await resp.json();
    let text = String(data?.choices?.[0]?.message?.content || "").trim();

    // Zitier-Marker [1][2][3] rausstreichen — Sophie soll keine Fußnoten vorlesen
    text = text.replace(/\s*\[\d+\](?:\[\d+\])*/g, "").trim();

    const citations = Array.isArray(data?.citations) ? data.citations : [];
    const sources = citations.map(url => ({ title: "Perplexity", url }));

    return { facts: text ? [text] : [], sources };
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === "AbortError") console.warn("[xi/research] perplexity timeout 6s");
    else console.warn("[xi/research] perplexity error", e?.message);
    return { facts: [], sources: [] };
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  if (!XI_ENABLED) {
    return res.status(404).json({ error: "extra_intelligence_not_available" });
  }

  // --- Auth + Premium-Gate ---
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "no_token" });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
    { auth: { persistSession: false } }
  );

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "invalid_token" });

  const { data: sub } = await supabase
    .from("user_subscriptions")
    .select("is_active, status, plan")
    .eq("user_id", user.id)
    .maybeSingle();

  const isPremium = !!(sub?.is_active || sub?.status === "active" || sub?.status === "trialing");
  if (!isPremium || String(sub?.plan || "").toLowerCase() !== "premium") {
    return res.status(402).json({ error: "premium_required" });
  }

  // --- Input ---
  const query    = String(req.body?.query || "").slice(0, 300).trim();
  const action   = String(req.body?.action || "reference_unknown");
  const language = String(req.body?.language || "de").toLowerCase();

  if (!query) return res.status(400).json({ error: "query_required" });

  // --- Research: parallele Quellen, erste mit Fakten gewinnt ---
  // Alle drei Quellen gleichzeitig starten. Wer zuerst nicht-leere Fakten
  // liefert, wird genommen. Nachzuegler werden ignoriert (laufen zu Ende,
  // aber wir warten nicht mehr). Das spart 1-3s wenn Wikipedia/Brave
  // schneller ist als Gemini (grounded_search).
  let facts = [];
  let sources = [];
  let winner = null;

  const wrap = (p, name, extract) =>
    p.then(r => {
      const f = extract(r);
      if (f && f.length) return { name, facts: f, sources: r?.sources || [] };
      return Promise.reject(new Error(`${name}: empty`));
    }).catch(e => Promise.reject(e));

  const racers = [
    // Perplexity zuerst — liefert meist schon 1-Satz-Antwort in ~1.5-2s
    wrap(perplexitySearch(query, language),       "perplexity", r => r?.facts || []),
    wrap(groundedSearch(query),                   "grounded",   r => r?.facts || []),
    wrap(getWikipedia(query),                     "wiki",       r => r?.summary ? [r.summary] : []),
    wrap(webSearch(query),                        "web",        r => (r?.results || []).slice(0, 2).map(x => x.description || x.title).filter(Boolean)),
  ];

  try {
    // Promise.any: erster Erfolg gewinnt. Alle Rejects -> AggregateError -> catch
    const first = await Promise.any(racers);
    facts   = first.facts;
    sources = first.sources;
    winner  = first.name;
  } catch {
    // Alle Quellen leer/fehlgeschlagen
    return res.status(200).json({ text: "", reason: "no_facts" });
  }

  // --- Shortcut: wenn Quelle bereits knapp + komplett, Condense-LLM sparen ---
  // Spart 0.5-1s wenn Wikipedia/grounded einen sauberen 1-Satz-Treffer liefert.
  {
    const f0 = String(facts[0] || "").trim();
    // Kriterien: kurz genug, hat ein Satzende, enthaelt nicht nur die Query
    const shortEnough = f0.length > 20 && f0.length <= 180;
    const hasSentenceEnd = /[.!?]/.test(f0);
    const notJustQuery = f0.toLowerCase() !== query.toLowerCase();
    if (shortEnough && hasSentenceEnd && notJustQuery) {
      // Nur auf den 1. Satz beschneiden und direkt zurueck
      const oneSentence = (f0.split(/(?<=[.!?])\s+/)[0] || f0).trim();
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
  // Die Frage wird NICHT wiederholt. Direkter Fakt, nichts drum herum.
  const isDE = language !== "en" && language !== "fr";
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
Q: "Who wrote 'The Swarm'?"  ->  "Frank Schätzing, 2004 eco-thriller."
Q: "What's that movie with the eagle?"  ->  "'The Eagle Has Landed', 1976, WWII thriller."
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
Frage: "Wie heisst der Film mit dem Adler?"  ->  "'Der Adler ist gelandet', 1976, Zweiter-Weltkriegs-Thriller."
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
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
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

      // Anti-Wiederhol-Guard: wenn Antwort die Query fast 1:1 wiederholt, Query rausstreichen
      const q = query.toLowerCase();
      const t = text.toLowerCase();
      if (q.length > 10 && t.includes(q)) {
        text = text.replace(new RegExp(query, "i"), "").replace(/^[\s,:;-]+/, "").trim();
        if (text) text = text.charAt(0).toUpperCase() + text.slice(1);
      }
    }
  } catch (e) {
    console.warn("[xi/research] condense failed", e?.message);
  }

  if (!text) {
    // Fallback: erster Fakt roh (gekuerzt)
    text = String(facts[0] || "").slice(0, 220);
  }

  // Token-Accounting fuer Billing (Classifier + Research + TTS pauschal ~2 Sophie-Tokens)
  // Realtime-TTS wird separat ueber reportUsage abgerechnet (Audio-Sekunden)
  return res.status(200).json({
    text,
    language,
    sources_count: sources.length,
    tokens_used: condenseTokens,
    source: winner,
  });
}
