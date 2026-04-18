// api/extra-intelligence/research.js — Extra Intelligence Research + Condensation
//
// Nimmt eine Query vom Classifier, recherchiert via groundedSearch (Gemini + Google)
// und kondensiert auf 1-2 Saetze, die Sophie natuerlich vorlesen kann.
// KEINE Persistenz — Rueckgabe ist fluechtig, nur fuer die aktuelle Session.

import { createClient } from "@supabase/supabase-js";
import { groundedSearch, webSearch, getWikipedia } from "../ai/tools.js";

const XI_ENABLED = String(process.env.EXTRA_INTELLIGENCE_ENABLED || "false").toLowerCase() === "true";

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

  // --- Research ---
  let facts = [];
  let sources = [];

  try {
    const g = await groundedSearch(query);
    if (g?.facts?.length) {
      facts = g.facts;
      sources = g.sources || [];
    }
  } catch (e) {
    console.warn("[xi/research] groundedSearch failed", e?.message);
  }

  // Fallback: Wikipedia
  if (!facts.length) {
    try {
      const wiki = await getWikipedia(query);
      if (wiki?.summary) facts = [wiki.summary];
    } catch {}
  }

  // Letzter Fallback: webSearch
  if (!facts.length) {
    try {
      const ws = await webSearch(query);
      if (ws?.results?.length) {
        facts = ws.results.slice(0, 2).map(r => r.description || r.title).filter(Boolean);
      }
    } catch {}
  }

  if (!facts.length) {
    return res.status(200).json({ text: "", reason: "no_facts" });
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
  });
}
