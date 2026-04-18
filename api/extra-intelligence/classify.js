// api/extra-intelligence/classify.js — Extra Intelligence Classifier
//
// Bewertet ein Transcript-Fragment (letzte ~15-20s) und entscheidet ob Sophie
// recherchieren/erklaeren soll. Strikte JSON-Ausgabe, KEINE Persistenz.
//
// Classes:
//   question_factual         — konkrete Frage mit Faktenantwort
//   reference_unknown        — Eigenname/Buch/Person/Begriff der wahrscheinlich unbekannt ist
//   concept_worth_explaining — Konzept/Referenz die Hoerer nicht kennen koennte
//   no_action                — nichts zu tun (Smalltalk, bereits bekannt, persoenlich)

import { createClient } from "@supabase/supabase-js";

const XI_ENABLED = String(process.env.EXTRA_INTELLIGENCE_ENABLED || "false").toLowerCase() === "true";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  if (!XI_ENABLED) {
    return res.status(404).json({ error: "extra_intelligence_not_available" });
  }

  // --- Auth ---
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

  // --- Premium-Gate ---
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
  const text = String(req.body?.text || "").slice(0, 1500).trim();
  const language = String(req.body?.language || "de").toLowerCase();
  const lastTriggerAgoSec = Number(req.body?.last_trigger_ago_sec ?? 999);

  if (!text || text.length < 10) {
    return res.status(200).json({ action: "no_action", reason: "too_short" });
  }

  // Cooldown-Hinweis in den Prompt (kein hartes Blocken, aber Classifier soll zurueckhaltender sein)
  const inCooldown = lastTriggerAgoSec < 20;

  // --- Classifier-Prompt ---
  const systemPrompt = `Du bist ein Classifier fuer Sophies Extra-Intelligence-Modus. Sophie hoert ein Gespraech mit, an dem sie NICHT teilnimmt.
Deine Aufgabe: Triggere wenn eine knappe Fakten-Antwort dem Gespraech hilft.

CLASSES:
- "question_factual": Konkrete Faktenfrage (Wer/Wann/Was/Wo/Wie viel).
  Beispiele: "Wer schreibt 'Der Schwarm'?", "Wie hoch ist der Mount Everest?", "Wann war D-Day?"
- "reference_unknown": Eigenname/Buch/Film/Person/Fachbegriff, bei dem eine kurze Einordnung hilft.
  Beispiele: "wie bei Kepler-22b", "klingt wie in 'The Eagle has Landed'", "Schumpeters Theorie"
- "concept_worth_explaining": Konzept/Begriff, dessen kurze Definition das Gespraech klarer macht.
- "no_action": Smalltalk, Alltag, persoenliche Themen (Beziehungen/Gesundheit/Finanzen),
  Meinungsfragen, Entscheidungen, Plaene, oder bereits im Kontext beantwortet.

REGELN:
- Bei erkennbarer Faktenfrage oder Eigennamen: TRIGGERE. Nicht ueberdenken.
- Sei nicht uebertrieben vorsichtig — wenn eine 1-Satz-Antwort nuetzlich ist, triggere.
- Nur bei wirklich persoenlichen Themen oder Smalltalk: no_action.
${inCooldown ? '- Cooldown aktiv (<20s seit letztem Trigger): nur triggern wenn eindeutig neue Fakten-Frage.' : ''}

OUTPUT (strikt JSON, keine Erklaerung, keine Markdown):
{"action":"<class>","query":"<praezise Suchanfrage oder leer>","confidence":<0..1>}`;

  const userPrompt = `Transkript-Fragment (Sprache: ${language}):
"""
${text}
"""

Entscheide. Nur JSON.`;

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.1,
        max_tokens: 120,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error("[xi/classify] OpenAI error", resp.status, errText.slice(0, 200));
      return res.status(200).json({ action: "no_action", reason: "classifier_error" });
    }

    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(200).json({ action: "no_action", reason: "parse_error" });
    }

    const action = ["question_factual", "reference_unknown", "concept_worth_explaining"].includes(parsed.action)
      ? parsed.action
      : "no_action";

    const query = String(parsed.query || "").slice(0, 300).trim();
    const confidence = Number.isFinite(parsed.confidence) ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5;

    // Fail-safe: ohne Query kein Trigger
    if (action !== "no_action" && !query) {
      return res.status(200).json({ action: "no_action", reason: "no_query" });
    }

    // Fail-safe: niedrige Confidence im Cooldown = nichts tun
    if (inCooldown && confidence < 0.6) {
      return res.status(200).json({ action: "no_action", reason: "cooldown_low_conf" });
    }

    // Token-Tracking: kleiner Classifier-Call (~200 Token) ~= 1 Sophie-Token pauschal
    // Realistic accounting passiert im Research-Endpoint, Classifier laeuft oft genug
    return res.status(200).json({
      action,
      query,
      confidence,
      classifier_tokens: data?.usage?.total_tokens || 0,
    });
  } catch (e) {
    console.error("[xi/classify] exception", e?.message);
    return res.status(200).json({ action: "no_action", reason: "exception" });
  }
}
