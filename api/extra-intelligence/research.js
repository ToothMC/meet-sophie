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

  // --- Kondensation zu 1-2 Saetzen, sprechbar ---
  const languageHint = language === "en"
    ? "Respond in natural English."
    : language === "fr"
    ? "Reponds en francais naturel."
    : "Antworte auf natuerlichem Deutsch.";

  const actionHint = {
    question_factual: language === "en"
      ? "Someone asked a factual question. Give the direct answer."
      : "Jemand hat eine Faktenfrage gestellt. Gib die direkte Antwort.",
    reference_unknown: language === "en"
      ? "Someone mentioned a name/reference listeners may not know. Identify it in one sentence."
      : "Jemand hat einen Namen/eine Referenz genannt, die Zuhoerer vielleicht nicht kennen. Ordne sie in einem Satz ein.",
    concept_worth_explaining: language === "en"
      ? "A concept was mentioned that benefits from a brief classification."
      : "Ein Konzept wurde erwaehnt, das von einer kurzen Einordnung profitiert.",
  }[action] || "";

  const condenseSystem = `Du bist ein Formulierer fuer Sophies Extra-Intelligence-Modus.
Sophie hoert einem Gespraech zu und sagt KURZ etwas Nuetzliches.
Regeln:
- 1 bis maximal 2 kurze Saetze. Nie laenger.
- Natuerlich gesprochen, wie ein kurzer Hinweis.
- Keine Einleitung ("Interessant...", "Uebrigens..."). Direkt Inhalt.
- Kein "Ich denke", keine Meinung. Nur Fakt.
- Keine Fragen am Ende. Keine Meta-Kommentare.
- Keine Quellen-URLs.
- ${languageHint}
- Kontext: ${actionHint}`;

  const condenseUser = `Ausgangsfrage/Bezug: "${query}"

Recherche-Fakten:
${facts.map((f, i) => `${i + 1}. ${f}`).join("\n")}

Formuliere JETZT den knappen Hinweis (1-2 Saetze, direkt vorlesbar):`;

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
        temperature: 0.4,
        max_tokens: 120,
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

      // Sanity: hart auf 2 Saetze clampen
      const parts = text.split(/(?<=[.!?])\s+/).slice(0, 2);
      text = parts.join(" ").trim();
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
