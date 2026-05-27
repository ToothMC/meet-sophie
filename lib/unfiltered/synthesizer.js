// lib/unfiltered/synthesizer.js — rohe Crawler-Signale → strukturierte
// Stories für das Daily Briefing. Trennt strikt "bestätigt" vs "Gerücht"
// vs "Sophies Lesart" via Confidence-Layer.

const SYNTH_MODEL = "gpt-5.1";

function buildSystemPrompt(language) {
  return language === "en"
    ? `You are Sophie's daily-briefing synthesizer.

STRICT GROUNDING — non-negotiable:
- You may ONLY use facts present in the provided signals array.
- Every story.headline must paraphrase content from at least 2 signals.
- Every story.confirmed[] item must be traceable to at least one
  signal with a non-empty url field.
- Every story.rumor[] item must come from a signal whose source is
  reddit or whose publisher is a boulevard outlet.
- Every story.sources[] entry must have a url that EXACTLY matches one
  of the signal.url values you got. Do NOT fabricate URLs.
- If you cannot ground a story in ≥2 distinct signals, do NOT emit it.
- Empty signals → return { "stories": [] }. Period. No fabrication.

Never make medical, sexual, pregnancy, or criminal claims about real
people unless a trusted news source confirms them. Never write about
minors in a gossip frame.`
    : `Du bist Sophies Daily-Briefing-Synthesizer.

STRICT GROUNDING — nicht verhandelbar:
- Du darfst NUR Fakten verwenden, die in den gelieferten Signalen stehen.
- Jede story.headline muss Inhalt aus mindestens 2 Signalen paraphrasieren.
- Jedes story.confirmed[]-Item muss zu mindestens einem Signal mit
  nicht-leerem url-Feld zuordbar sein.
- Jedes story.rumor[]-Item muss aus einem Signal mit source=reddit
  oder publisher=Boulevard kommen.
- Jeder story.sources[]-Eintrag muss eine url haben, die EXAKT einer
  signal.url entspricht, die du bekommen hast. Erfinde KEINE URLs.
- Wenn du eine Story nicht in ≥2 unterschiedlichen Signalen verankern
  kannst, gib sie NICHT aus.
- Leere Signal-Liste → return { "stories": [] }. Punkt. Kein Fabrizieren.

Mache keine medizinischen, sexuellen, schwangerschafts- oder
strafrechtlichen Behauptungen über reale Personen, sofern keine
vertrauenswürdige News-Quelle das bestätigt. Niemals über
Minderjährige in Klatsch-Rahmen.`;
}

function buildUserPrompt(rawSignals, { language, max_stories }) {
  const lang = language === "en" ? "English" : "Deutsch";
  const trimmed = rawSignals.slice(0, 50).map(s => ({
    src:   s.source,
    pub:   s.publisher,
    head:  s.headline,
    text:  (s.text || "").slice(0, 240),
    url:   s.url,
    conf:  s.confidence || null,
  }));

  return `Sprache: ${lang}

REGELN
- Pro Story strikt trennen:
  • "confirmed": NUR was eine vertrauenswürdige News-Quelle (BBC, Spiegel, Reuters, etc.) reportet.
  • "rumor": was in Boulevard/Reddit/Forum steht.
  • "sophie_take": DEINE freche Lesart — explizit als Meinung markiert, nicht als Fakt.
- Bei sensiblen Themen (Krankheit, Sexualität, Schwangerschaft, Straftaten realer Personen):
  Story NUR aufnehmen, wenn von einer seriösen Quelle bestätigt. Sonst weglassen.
- KEINE Stories über Minderjährige in Klatsch-Richtung.
- Max ${max_stories} Stories. Sortiere nach Relevanz × Drama × Aktualität.
- Wenn aus den Signalen keine echte Story extrahierbar ist, liefere "stories": [].

JSON-SCHEMA
{
  "stories": [
    {
      "id":         "story_<kurzer_slug>",
      "headline":   "string",
      "category":   "royals|reality-tv|celebs|music|sport|other",
      "confirmed":  ["string", "..."],
      "rumor":      ["string", "..."],
      "sophie_take":"string (1–2 Sätze, frech aber fair)",
      "drama_score":  0,
      "rumor_score":  0,
      "pr_smell":     0,
      "sources":    [{"url":"string","publisher":"string","type":"news|boulevard|reddit"}],
      "next_watch": "string (worauf der User als nächstes achten könnte)"
    }
  ]
}

ROHE SIGNALE
${JSON.stringify(trimmed)}`;
}

/**
 * @param {Array} rawSignals — was runCrawlers() geliefert hat
 * @param {Object} opts
 * @param {"de"|"en"} [opts.language]
 * @param {number} [opts.max_stories]   default 5
 * @returns {Promise<Array>} stories[]
 */
const MIN_SIGNALS_FOR_SYNTH = 5;   // unter dieser Schwelle halluziniert gpt-5.1 zu leicht

export async function synthesizeBriefing(rawSignals, { language = "de", max_stories = 5 } = {}) {
  if (!Array.isArray(rawSignals) || !rawSignals.length) return [];
  if (rawSignals.length < MIN_SIGNALS_FOR_SYNTH) {
    console.warn(`[unf/synth] only ${rawSignals.length} signals — below threshold, returning []`);
    return [];
  }
  if (!process.env.OPENAI_API_KEY) {
    console.warn("[unf/synth] OPENAI_API_KEY missing");
    return [];
  }

  // Whitelist gültiger Source-URLs — nach LLM-Response verwerfen wir
  // jede Story deren sources nicht in diesem Set sind.
  const allowedUrls = new Set(
    rawSignals.map(s => String(s.url || "").trim()).filter(Boolean)
  );

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: SYNTH_MODEL,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildSystemPrompt(language) },
          { role: "user",   content: buildUserPrompt(rawSignals, { language, max_stories }) },
        ],
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.warn("[unf/synth] LLM failed:", r.status, text.slice(0, 200));
      return [];
    }
    const j = await r.json();
    let parsed;
    try { parsed = JSON.parse(j.choices?.[0]?.message?.content || "{}"); }
    catch (e) { console.warn("[unf/synth] JSON parse failed:", e.message); return []; }

    const stories = Array.isArray(parsed.stories) ? parsed.stories : (Array.isArray(parsed) ? parsed : []);

    // Belt-and-suspenders: jede Story muss ≥1 source.url haben, die in
    // den ursprünglichen Signalen vorkam. Fängt Halluzinationen auch
    // dann ab, wenn das LLM den System-Prompt ignoriert.
    const grounded = stories.filter(s => {
      const sources = Array.isArray(s?.sources) ? s.sources : [];
      const groundedSrc = sources.filter(src => allowedUrls.has(String(src?.url || "").trim()));
      if (groundedSrc.length === 0) {
        console.warn("[unf/synth] dropping ungrounded story:", String(s?.headline || "").slice(0, 80));
        return false;
      }
      s.sources = groundedSrc;
      return true;
    });

    if (grounded.length < stories.length) {
      console.warn(`[unf/synth] dropped ${stories.length - grounded.length}/${stories.length} ungrounded stories`);
    }

    return grounded.slice(0, max_stories);
  } catch (err) {
    console.warn("[unf/synth] threw:", err?.message || err);
    return [];
  }
}
