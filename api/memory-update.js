import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { getAdapter } from "../lib/ai/adapters/index.js";
import { normalizeResponse } from "../lib/ai/persona-normalizer.js";
import { trackCost } from "../lib/ai/cost-tracker.js";
import { calculateCost, estimateRealtimeCost } from "../lib/ai/types.js";
import { mapPlanToTier } from "../lib/sophie-core.js";
import { TIER_MEMORY_CONFIG, mergeArrays, mergeJsonb, filterLtmByDepth } from "../lib/memory-helpers.js";

function hashIp(ip) {
  if (!ip) return "none";
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function buildSessionTitle(value = "") {
  const text = cleanText(value);

  if (!text) return "Session";

  const cleaned = text
    .replace(/^der benutzer\s+/i, "")
    .replace(/^the user\s+/i, "")
    .replace(/^user\s+/i, "")
    .replace(/^conversation about\s+/i, "")
    .replace(/^meeting about\s+/i, "")
    .replace(/^discussion about\s+/i, "")
    .trim();

  const lower = cleaned.toLowerCase();

  if (lower.includes("jobrad")) return "Jobrad";
  if (lower.includes("iran")) return "Iran-Konflikt";
  if (lower.includes("gehalt")) return "Gehalt";
  if (lower.includes("salary")) return "Salary Negotiation";
  if (lower.includes("meeting")) return "Meeting";
  if (lower.includes("bewerbung")) return "Bewerbung";

  const firstChunk = cleaned
    .split(/[.!?]/)[0]
    .split(",")[0]
    .trim()
    .slice(0, 40);

  return firstChunk || "Session";
}

function buildStructuredSummary({ shortSummary = "", emotionalTone = "", stressLevel = null, closenessLevel = null }) {
  return {
    summary: cleanText(shortSummary),
    emotional_tone: cleanText(emotionalTone) || "unknown",
    stress_level: Number.isFinite(Number(stressLevel)) ? Number(stressLevel) : null,
    closeness_level: Number.isFinite(Number(closenessLevel)) ? Number(closenessLevel) : null,
  };
}

function buildFallbackKeyInsights(sessionSummary) {
  const s = cleanText(sessionSummary);
  if (!s) return [];
  return [
    { type: "session_summary", text: s.slice(0, 300) },
  ];
}

function buildFallbackActionPlan(sessionSummary) {
  const s = cleanText(sessionSummary);
  if (!s) return [];
  return [
    {
      label: "Clarify next step",
      detail: s.slice(0, 300),
    },
  ];
}

function buildFallbackOpenQuestions() {
  return [];
}

// ---- Realtime voice cost: validation + real provider cost ----

const REALTIME_PRICING_PER_M = {
  audio_input:  32.00,
  audio_output: 64.00,
  text_input:    4.00,
  text_output:  16.00,
  cached_input:  0.40,
};

function validateRealtimeUsage(raw, secondsUsed) {
  if (!raw || typeof raw !== 'object') return null;

  const MAX_TOKENS_PER_SECOND = 500;
  const maxTokens = Math.max(secondsUsed, 60) * MAX_TOKENS_PER_SECOND;
  const clamp = (v) => Math.max(0, Math.min(maxTokens, Math.round(Number(v) || 0)));

  const validated = {
    audio_tokens_in:  clamp(raw.audio_tokens_in),
    audio_tokens_out: clamp(raw.audio_tokens_out),
    text_tokens_in:   clamp(raw.text_tokens_in),
    text_tokens_out:  clamp(raw.text_tokens_out),
    cached_tokens_in: clamp(raw.cached_tokens_in),
    cached_audio_in:  clamp(raw.cached_audio_in),
    cached_text_in:   clamp(raw.cached_text_in),
    response_count:   Math.max(0, Math.min(500, Math.round(Number(raw.response_count) || 0))),
  };

  const totalTokens = validated.audio_tokens_in + validated.audio_tokens_out +
                      validated.text_tokens_in + validated.text_tokens_out;
  if (validated.response_count > 0 && totalTokens === 0) return null;

  return validated;
}

function calculateRealtimeProviderCost(usage) {
  if (!usage) return 0;
  const m = 1_000_000;
  // cached_tokens are a SUBSET of text/audio_tokens_in — subtract to avoid double-counting
  const cachedText  = usage.cached_text_in  || 0;
  const cachedAudio = usage.cached_audio_in || 0;
  const cachedTotal = usage.cached_tokens_in || 0;
  // Fallback: if no detail split available, assume all cached are text (system prompt)
  const effectiveCachedText  = cachedText  || (cachedAudio ? 0 : cachedTotal);
  const effectiveCachedAudio = cachedAudio || 0;

  return (
    (Math.max(0, usage.text_tokens_in - effectiveCachedText) / m)   * REALTIME_PRICING_PER_M.text_input +
    (Math.max(0, usage.audio_tokens_in - effectiveCachedAudio) / m) * REALTIME_PRICING_PER_M.audio_input +
    ((effectiveCachedText + effectiveCachedAudio) / m)              * REALTIME_PRICING_PER_M.cached_input +
    (usage.text_tokens_out / m)                                     * REALTIME_PRICING_PER_M.text_output +
    (usage.audio_tokens_out / m)                                    * REALTIME_PRICING_PER_M.audio_output
  );
}

function sanitizeInsightItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const type = cleanText(item.type).slice(0, 80);
      const text = cleanText(item.text).slice(0, 500);
      if (!text) return null;
      return {
        type: type || "insight",
        text,
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function sanitizeActionItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const label = cleanText(item.label).slice(0, 120);
      const detail = cleanText(item.detail).slice(0, 500);
      if (!label && !detail) return null;
      return {
        label: label || "Next step",
        detail: detail || "",
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function sanitizeOpenQuestions(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => cleanText(item).slice(0, 300))
    .filter(Boolean)
    .slice(0, 8);
}

// ---------------------------------------------------------------------------
// Smart Report Generator — Multi-AI + Flexible Blocks
// All 4 providers analyze the transcript in parallel,
// Claude Sonnet synthesizes the best report with dynamic blocks.
// ---------------------------------------------------------------------------

const REPORT_PROVIDERS = [
  { provider: 'openai', model: 'gpt-4o-mini' },
  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { provider: 'google', model: 'gemini-2.5-flash' },
  { provider: 'mistral', model: 'mistral-small-latest' },
];

async function generateSmartReport({ transcriptText, fallbackSummary, emotionalTone, stressLevel, closenessLevel, sessionMode }) {
  const modeHint = sessionMode ? `\nDer Session-Modus war: "${sessionMode}". Berücksichtige das bei deiner Analyse.` : '';
  const analysisPrompt = `Analysiere dieses Gesprächs-Transcript. Extrahiere ALLES was relevant ist.
Keine starre Vorlage — extrahiere was DA ist:
- Wenn Scores/Bewertungen vorkommen → extrahiere sie mit Zahlen
- Wenn Teilnehmer erkennbar → nenne sie
- Wenn Entscheidungen getroffen wurden → liste sie
- Wenn Action Items besprochen wurden → mit Owner und Deadline
- Wenn es ein Pitch war → bewerte Kriterien wie Clarity, Value Proposition etc. mit Score 0-5
- Wenn es ein Meeting war → Agenda, Beschlüsse, Protokoll
- Wenn es ein kurzes Gespräch war → kurze Zusammenfassung reicht
Antworte als freies JSON-Objekt. Nutze die Felder die PASSEN. Erfinde NICHTS.${modeHint}
Schreibe in der GLEICHEN Sprache wie das Transcript.`;

  // Step 1: All 4 providers analyze in parallel (8s timeout)
  const results = await Promise.allSettled(
    REPORT_PROVIDERS.map(async ({ provider, model }) => {
      try {
        const adapter = getAdapter(provider);
        const response = await Promise.race([
          adapter.complete({
            messages: [
              { role: 'system', content: analysisPrompt },
              { role: 'user', content: `Transcript:\n${transcriptText}` },
            ],
            model,
            maxTokens: 2048,
            temperature: 0.2,
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000)),
        ]);
        // Try to parse JSON from response
        const text = response.content || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return { provider, data: JSON.parse(jsonMatch[0]) };
        }
        return null;
      } catch (e) {
        console.error(`[smart-report] ${provider} failed:`, e?.message);
        return null;
      }
    })
  );

  const analyses = results
    .map(r => r.status === 'fulfilled' ? r.value : null)
    .filter(Boolean);

  if (analyses.length === 0) {
    // Fallback to simple summary
    return buildFallbackReport(transcriptText, fallbackSummary, emotionalTone);
  }

  // Step 2: Claude Sonnet synthesizes the best report from all analyses
  const analysesBlock = analyses
    .map(a => `[${a.provider.toUpperCase()}]:\n${JSON.stringify(a.data, null, 2)}`)
    .join('\n\n---\n\n');

  const synthesisPrompt = `Du bist ein Premium Report-Designer für eine hochintelligente KI namens Sophie.
${analyses.length} KIs haben dasselbe Gespräch unabhängig analysiert. Erstelle den BESTEN Report.

DESIGN-PRINZIPIEN:
- Modern, elegant, visuell ansprechend — der User soll merken dass er mit einer intelligenten KI arbeitet
- NUR Informationen die von mindestens 2 KIs bestätigt werden (Confidence-Check gegen Halluzinationen)
- Der Inhalt bestimmt die Form — wähle frei welche Blöcke passen
- Wenn es ein kurzes Gespräch war → kurzer Report. Keine künstliche Tiefe
- Schreibe in der gleichen Sprache wie die Analysen

KONSISTENZ-LEITPLANKEN (damit wiederholte Sessions vergleichbar bleiben):
- SALES PITCH → IMMER Scorecard mit diesen 8 Kriterien: Clarity, Problem Sharpness, Value Proposition, Differentiation, Credibility, Audience Fit, Objection Handling, Persuasiveness (Score 0-5). Plus: Stärken, Schwächen, Overall Score. So kann der User Pitch #1 mit Pitch #5 vergleichen.
- MEETING → IMMER: Agenda/Themen → Beschlüsse → Action Items (mit Owner + Deadline) → Offene Punkte. Konsistente Struktur für jedes Meeting-Protokoll.
- BRAINSTORM → IMMER: Ideen-Cluster → Favoriten → Nächste Schritte. Damit Brainstorming-Sessions vergleichbar sind.
- REFLEXION/COACHING → Frei, aber Erkenntnisse und offene Fragen sollten immer dabei sein.
- CASUAL/KURZ → Kompakte Zusammenfassung, keine erzwungene Tiefe.

Diese Leitplanken sind KEINE starren Templates — du entscheidest was zum Gespräch passt. Aber wenn es z.B. ein Pitch war, nutze die 8 Scorecard-Kriterien damit der User seinen Fortschritt tracken kann.

VERFÜGBARE BLOCK-TYPEN (nutze NUR was zum Inhalt passt):
{"type":"title","text":"...","subtitle":"..."} — Titel
{"type":"metadata","date":"...","duration":"...","mood":"..."} — Kontext-Pills
{"type":"summary","text":"..."} — Zusammenfassung
{"type":"highlights","items":["..."]} — Wichtigste Punkte (visuell hervorgehoben)
{"type":"scorecard","items":[{"label":"...","score":0-5,"note":"..."}]} — Bewertung mit Scores
{"type":"decisions","items":["..."]} — Getroffene Beschlüsse
{"type":"actions","items":[{"task":"...","owner":"...","deadline":"..."}]} — Aufgaben
{"type":"participants","items":["..."]} — Teilnehmer
{"type":"insights","items":["..."]} — Erkenntnisse
{"type":"questions","items":["..."]} — Offene Fragen
{"type":"quote","text":"...","source":"..."} — Markantes Zitat

Antworte NUR mit dem JSON-Array.

DIE ${analyses.length} ANALYSEN:

${analysesBlock}`;

  try {
    const synthesizer = getAdapter('anthropic');
    const synthesisResponse = await Promise.race([
      synthesizer.complete({
        messages: [{ role: 'user', content: synthesisPrompt }],
        model: 'claude-sonnet-4-6',
        maxTokens: 3000,
        temperature: 0.3,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 12000)),
    ]);

    const text = synthesisResponse.content || '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array in synthesis');
    const blocks = JSON.parse(jsonMatch[0]);

    // Extract standard fields for backward compatibility
    const titleBlock = blocks.find(b => b.type === 'title');
    const summaryBlock = blocks.find(b => b.type === 'summary');

    return {
      session_title: titleBlock?.text || analyses[0]?.data?.title || 'Session',
      short_summary: summaryBlock?.text || analyses[0]?.data?.summary || fallbackSummary || '',
      structured_summary: {
        summary: summaryBlock?.text || '',
        emotional_tone: emotionalTone || analyses[0]?.data?.emotional_summary || 'neutral',
        stress_level: stressLevel,
        closeness_level: closenessLevel,
      },
      // Legacy fields for backward compat
      key_insights: (blocks.find(b => b.type === 'insights')?.items || []).map(t => ({ type: 'insight', text: t })),
      action_plan: (blocks.find(b => b.type === 'actions')?.items || []).map(a => ({
        label: a.task || a, detail: a.owner ? `Owner: ${a.owner}${a.deadline ? ` | Deadline: ${a.deadline}` : ''}` : '',
      })),
      open_questions: blocks.find(b => b.type === 'questions')?.items || [],
      // New: flexible blocks for dynamic rendering
      report_blocks: blocks,
      report_providers: analyses.map(a => a.provider),
      report_style: 'smart',
    };
  } catch (e) {
    console.error('[smart-report] synthesis failed:', e?.message);
    // Fallback: build blocks from best single analysis
    const best = analyses[0].data;
    const fallbackBlocks = [
      { type: 'title', text: best.title || 'Session', subtitle: '' },
      { type: 'summary', text: best.summary || fallbackSummary || '' },
    ];
    if (best.highlights?.length) fallbackBlocks.push({ type: 'highlights', items: best.highlights });
    if (best.key_points?.length) fallbackBlocks.push({ type: 'insights', items: best.key_points });
    if (best.scores?.length) fallbackBlocks.push({ type: 'scorecard', items: best.scores });
    if (best.decisions?.length) fallbackBlocks.push({ type: 'decisions', items: best.decisions });
    if (best.action_items?.length) fallbackBlocks.push({ type: 'actions', items: best.action_items });
    if (best.participants?.length) fallbackBlocks.push({ type: 'participants', items: best.participants });
    if (best.open_questions?.length) fallbackBlocks.push({ type: 'questions', items: best.open_questions });

    return {
      session_title: best.title || 'Session',
      short_summary: best.summary || fallbackSummary || '',
      structured_summary: { summary: best.summary || '', emotional_tone: emotionalTone || 'neutral', stress_level: stressLevel, closeness_level: closenessLevel },
      key_insights: (best.key_points || []).map(t => ({ type: 'insight', text: t })),
      action_plan: (best.action_items || []).map(a => ({ label: typeof a === 'string' ? a : a.task || '', detail: typeof a === 'object' && a.owner ? `Owner: ${a.owner}` : '' })),
      open_questions: best.open_questions || [],
      report_blocks: fallbackBlocks,
      report_providers: [analyses[0].provider],
      report_style: 'smart',
    };
  }
}

function buildFallbackReport(transcriptText, fallbackSummary, emotionalTone) {
  const title = buildSessionTitle(fallbackSummary);
  const summary = (fallbackSummary || '').slice(0, 300);
  return {
    session_title: title,
    short_summary: summary,
    structured_summary: { summary: summary, emotional_tone: emotionalTone || 'neutral', stress_level: null, closeness_level: null },
    key_insights: buildFallbackKeyInsights(fallbackSummary),
    action_plan: buildFallbackActionPlan(fallbackSummary),
    open_questions: buildFallbackOpenQuestions(),
    report_blocks: [
      { type: 'title', text: title, subtitle: '' },
      { type: 'summary', text: summary },
    ],
    report_providers: [],
    report_style: 'smart',
  };
}

async function generateConversationOutput({
  transcriptText,
  fallbackSummary,
  emotionalTone,
  stressLevel,
  closenessLevel,
  openAiKey,
  model,
}) {
  const system =
    "You create a structured THINKING REPORT after a conversation. " +
    "Your task is not superficial summarization. Your task is to extract the thinking structure behind the conversation. " +
    "Focus on the real substance of the discussion, not greetings, filler phrases, or testing sentences. " +
    "Identify the central question, the key insights that emerged, the factors influencing decisions, and possible directions. " +
    "Produce thoughtful and useful output that helps the user continue thinking after the conversation. " +
    "Avoid repeating obvious transcript sentences. Extract meaning instead. " +
    "If the conversation is short or shallow, keep the report short and honest instead of inventing depth. " +
    "Also generate a short session_title with max 4 words. " +
    "The title must name the main topic only, not a sentence. " +
    "Avoid generic titles like Conversation, Session, Discussion. " +
    "IMPORTANT: Write the entire output in the SAME language as the transcript.";

  const userMsg = `
Fallback summary from session memory:
${cleanText(fallbackSummary) || "None"}

Transcript:
${transcriptText}
`.trim();

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      session_title: { type: "string" },
      short_summary: { type: "string" },
      key_insights: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string" },
            text: { type: "string" },
          },
          required: ["type", "text"],
        },
      },
      action_plan: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            label: { type: "string" },
            detail: { type: "string" },
          },
          required: ["label", "detail"],
        },
      },
      open_questions: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["session_title", "short_summary", "key_insights", "action_plan", "open_questions"],
  };

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: system },
        { role: "user", content: userMsg },
      ],
      temperature: 0.3,
      text: {
        format: {
          type: "json_schema",
          name: "sophie_conversation_output_v1",
          strict: true,
          schema,
        },
      },
      truncation: "auto",
    }),
  });

  if (!r.ok) {
    const errorText = await r.text().catch(() => "");
    throw new Error(`Conversation output model error ${r.status}: ${errorText.slice(0, 300)}`);
  }

  const out = await r.json();
  const text =
    out?.output_text ||
    out?.output?.[0]?.content?.find?.((c) => c.type === "output_text")?.text ||
    "";

  let parsed;
  try {
    parsed = JSON.parse(String(text || "").trim());
  } catch {
    throw new Error("Bad JSON from conversation output model");
  }

  const shortSummary = cleanText(parsed?.short_summary || fallbackSummary).slice(0, 300);
  const sessionTitle = buildSessionTitle(parsed?.session_title || shortSummary || fallbackSummary);
  const keyInsights = sanitizeInsightItems(parsed?.key_insights);
  const actionPlan = sanitizeActionItems(parsed?.action_plan);
  const openQuestions = sanitizeOpenQuestions(parsed?.open_questions);

  return {
    session_title: sessionTitle,
    short_summary: shortSummary || cleanText(fallbackSummary).slice(0, 300),
    structured_summary: buildStructuredSummary({
      shortSummary: shortSummary || fallbackSummary,
      emotionalTone,
      stressLevel,
      closenessLevel,
    }),
    key_insights: keyInsights.length ? keyInsights : buildFallbackKeyInsights(fallbackSummary),
    action_plan: actionPlan.length ? actionPlan : buildFallbackActionPlan(fallbackSummary),
    open_questions: openQuestions.length ? openQuestions : buildFallbackOpenQuestions(),
  };
}

// ---------------------------------------------------------------------------
// Sales Pitch Report generator — returns same shape as generateConversationOutput
// but with pitch-specific scorecard in key_insights + action_plan
// ---------------------------------------------------------------------------
async function generateSalesPitchReport({ transcriptText, openAiKey, model }) {
  const system = `You analyze a Sales Pitch training session and produce a structured Sales Pitch Report v2.
The transcript contains a pitch practice: the user pitched, Sophie asked critical questions, and gave verbal feedback.

Extract ALL evaluation data from the conversation. Score each criterion yourself based on the pitch quality you observe.

PITCH TYPE CLASSIFICATION — derive from the 3 setup answers (what, who, goal):
- "sales": customer, buying, ROI, pain point
- "investor": investor, funding, market, traction
- "keynote": audience, stage, conference, talk
- "internal": team, management, budget, approval
- "self": job interview, jury, application, self-presentation
- "other": none of the above

SCORING — 13 criteria in 2 groups:
CONTENT (60%): clarity (12%), problem_sharpness (10%), value_proposition (12%), structure (8%), differentiation (8%), credibility (5%), audience_fit (5%)
DELIVERY (40%): opening (8%), closing (7%), voice_rhythm (8%), rhetoric_language (7%), authenticity (5%), persuasiveness (5%)

Overall score = weighted average (score × weight per criterion, sum / 100).

CONFIDENCE: If text-only (no audio), mark voice_rhythm and authenticity as "low" confidence, rhetoric_language as "medium". Otherwise all "high".

IMPORTANT: Write the ENTIRE output in the SAME language as the transcript.
This includes ALL fields: overall_verdict, notes, strongest_elements, main_weaknesses, likely_audience_questions, improvement_priorities, recommended_next_attempt.
Criterion names in the scorecard MUST stay in English — but the "note" field for each criterion must be in the transcript language.`;

  const userMsg = `Transcript:\n${transcriptText}`;

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      session_title: { type: "string" },
      short_summary: { type: "string" },
      pitch_type: { type: "string" },
      audience_type: { type: "string" },
      pitch_goal: { type: "string" },
      goal_type: { type: "string" },
      pitch_topic: { type: "string" },
      overall_verdict: { type: "string" },
      scores_content: {
        type: "object",
        additionalProperties: false,
        properties: {
          clarity: { type: "number" },
          problem_sharpness: { type: "number" },
          value_proposition: { type: "number" },
          structure: { type: "number" },
          differentiation: { type: "number" },
          credibility: { type: "number" },
          audience_fit: { type: "number" },
        },
        required: ["clarity", "problem_sharpness", "value_proposition", "structure", "differentiation", "credibility", "audience_fit"],
      },
      scores_delivery: {
        type: "object",
        additionalProperties: false,
        properties: {
          opening: { type: "number" },
          closing: { type: "number" },
          voice_rhythm: { type: "number" },
          rhetoric_language: { type: "number" },
          authenticity: { type: "number" },
          persuasiveness: { type: "number" },
        },
        required: ["opening", "closing", "voice_rhythm", "rhetoric_language", "authenticity", "persuasiveness"],
      },
      scorecard_notes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            criterion: { type: "string" },
            score: { type: "number" },
            note: { type: "string" },
            confidence: { type: "string" },
            group: { type: "string" },
          },
          required: ["criterion", "score", "note", "confidence", "group"],
        },
      },
      overall_score: { type: "number" },
      content_score: { type: "number" },
      delivery_score: { type: "number" },
      confidence_level: { type: "string" },
      strongest_elements: { type: "array", items: { type: "string" } },
      main_weaknesses: { type: "array", items: { type: "string" } },
      likely_audience_questions: { type: "array", items: { type: "string" } },
      improvement_priorities: { type: "array", items: { type: "string" } },
      recommended_next_attempt: { type: "string" },
    },
    required: [
      "session_title", "short_summary", "pitch_type", "audience_type", "pitch_goal", "goal_type", "pitch_topic",
      "overall_verdict", "scores_content", "scores_delivery", "scorecard_notes",
      "overall_score", "content_score", "delivery_score", "confidence_level",
      "strongest_elements", "main_weaknesses", "likely_audience_questions",
      "improvement_priorities", "recommended_next_attempt"
    ],
  };

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: system },
        { role: "user", content: userMsg },
      ],
      temperature: 0.3,
      text: {
        format: {
          type: "json_schema",
          name: "sophie_sales_pitch_report_v1",
          strict: true,
          schema,
        },
      },
      truncation: "auto",
    }),
  });

  if (!r.ok) {
    const errorText = await r.text().catch(() => "");
    throw new Error(`Sales pitch report model error ${r.status}: ${errorText.slice(0, 300)}`);
  }

  const out = await r.json();
  const text =
    out?.output_text ||
    out?.output?.[0]?.content?.find?.((c) => c.type === "output_text")?.text ||
    "";

  let parsed;
  try {
    parsed = JSON.parse(String(text || "").trim());
  } catch {
    throw new Error("Bad JSON from sales pitch report model");
  }

  // Map scorecard_notes to key_insights format for the report UI
  const scorecardInsights = (parsed.scorecard_notes || []).map((item) => ({
    type: "scorecard",
    text: `${item.criterion}: ${item.score}/5${item.confidence !== "high" ? ` (${item.confidence} confidence)` : ""} — ${item.note}`,
    group: item.group,
  }));

  const strengthInsights = (parsed.strongest_elements || []).map((s) => ({
    type: "strength",
    text: s,
  }));

  const weaknessInsights = (parsed.main_weaknesses || []).map((w) => ({
    type: "weakness",
    text: w,
  }));

  const questionInsights = (parsed.likely_audience_questions || []).map((q) => ({
    type: "audience_question",
    text: q,
  }));

  const actionPlan = (parsed.improvement_priorities || []).map((p, i) => ({
    label: `Priority ${i + 1}`,
    detail: p,
  }));

  if (parsed.recommended_next_attempt) {
    actionPlan.push({
      label: "Next Attempt Focus",
      detail: parsed.recommended_next_attempt,
    });
  }

  return {
    session_title: parsed.session_title || "Sales Pitch",
    short_summary: parsed.overall_verdict || parsed.short_summary || "",
    structured_summary: {
      summary: parsed.short_summary || "",
      emotional_tone: "focused",
      stress_level: null,
      closeness_level: null,
    },
    key_insights: [
      ...scorecardInsights,
      ...strengthInsights,
      ...weaknessInsights,
      ...questionInsights,
    ],
    action_plan: actionPlan,
    open_questions: parsed.likely_audience_questions || [],
    // Extra pitch-specific data for the frontend (v2)
    sales_pitch_report: {
      pitch_type: parsed.pitch_type || "other",
      audience_type: parsed.audience_type || "",
      pitch_goal: parsed.pitch_goal || "",
      goal_type: parsed.goal_type || "",
      pitch_topic: parsed.pitch_topic || "",
      overall_verdict: parsed.overall_verdict || "",
      scores_content: parsed.scores_content || {},
      scores_delivery: parsed.scores_delivery || {},
      scorecard_notes: parsed.scorecard_notes || [],
      overall_score: parsed.overall_score || 0,
      content_score: parsed.content_score || 0,
      delivery_score: parsed.delivery_score || 0,
      confidence_level: parsed.confidence_level || "low",
      strongest_elements: parsed.strongest_elements || [],
      main_weaknesses: parsed.main_weaknesses || [],
      likely_audience_questions: parsed.likely_audience_questions || [],
      improvement_priorities: parsed.improvement_priorities || [],
      recommended_next_attempt: parsed.recommended_next_attempt || "",
    },
  };
}

// ---------------------------------------------------------------------------
// Meeting Summary generator
// ---------------------------------------------------------------------------
async function generateMeetingSummary({ transcriptText, openAiKey, model }) {
  const system = `You create a structured MEETING SUMMARY from a conversation transcript.
Extract: what was discussed, what was decided, action items with owners, and open topics.
Structure the output clearly. Write in the SAME language as the transcript.`;

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      session_title: { type: "string" },
      short_summary: { type: "string" },
      agenda_points: { type: "array", items: { type: "string" } },
      decisions: { type: "array", items: { type: "string" } },
      action_items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            task: { type: "string" },
            owner: { type: "string" },
            deadline: { type: "string" },
          },
          required: ["task", "owner", "deadline"],
        },
      },
      open_topics: { type: "array", items: { type: "string" } },
      next_steps: { type: "string" },
    },
    required: ["session_title", "short_summary", "agenda_points", "decisions", "action_items", "open_topics", "next_steps"],
  };

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${openAiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, input: [{ role: "system", content: system }, { role: "user", content: `Transcript:\n${transcriptText}` }],
      temperature: 0.3, text: { format: { type: "json_schema", name: "sophie_meeting_summary_v1", strict: true, schema } }, truncation: "auto",
    }),
  });

  if (!r.ok) throw new Error(`Meeting summary error ${r.status}`);
  const out = await r.json();
  const text = out?.output_text || out?.output?.[0]?.content?.find?.((c) => c.type === "output_text")?.text || "";
  const parsed = JSON.parse(String(text || "").trim());

  return {
    session_title: parsed.session_title || "Meeting",
    short_summary: parsed.short_summary || "",
    structured_summary: { summary: parsed.short_summary || "", emotional_tone: "neutral", stress_level: null, closeness_level: null },
    key_insights: [
      ...(parsed.agenda_points || []).map(a => ({ type: "agenda", text: a })),
      ...(parsed.decisions || []).map(d => ({ type: "decision", text: d })),
    ],
    action_plan: (parsed.action_items || []).map(a => ({
      label: `${a.task}${a.deadline !== "none" ? ` (${a.deadline})` : ""}`,
      detail: a.owner !== "none" ? `Owner: ${a.owner}` : "",
    })),
    open_questions: parsed.open_topics || [],
    meeting_data: parsed,
  };
}

// ---------------------------------------------------------------------------
// Quick Summary generator
// ---------------------------------------------------------------------------
async function generateQuickSummary({ transcriptText, openAiKey, model }) {
  const system = `Create a QUICK SUMMARY of this conversation in 3-5 bullet points.
Be extremely concise. Each bullet should be one short sentence capturing a key point.
Write in the SAME language as the transcript.`;

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      session_title: { type: "string" },
      bullets: { type: "array", items: { type: "string" } },
    },
    required: ["session_title", "bullets"],
  };

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${openAiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, input: [{ role: "system", content: system }, { role: "user", content: `Transcript:\n${transcriptText}` }],
      temperature: 0.3, text: { format: { type: "json_schema", name: "sophie_quick_summary_v1", strict: true, schema } }, truncation: "auto",
    }),
  });

  if (!r.ok) throw new Error(`Quick summary error ${r.status}`);
  const out = await r.json();
  const text = out?.output_text || out?.output?.[0]?.content?.find?.((c) => c.type === "output_text")?.text || "";
  const parsed = JSON.parse(String(text || "").trim());

  return {
    session_title: parsed.session_title || "Session",
    short_summary: (parsed.bullets || []).join(" "),
    structured_summary: { summary: (parsed.bullets || []).join(" "), emotional_tone: "neutral", stress_level: null, closeness_level: null },
    key_insights: (parsed.bullets || []).map(b => ({ type: "bullet", text: b })),
    action_plan: [],
    open_questions: [],
  };
}

// ---------------------------------------------------------------------------
// Style recommendation — AI picks the best report style for this transcript
// ---------------------------------------------------------------------------
async function recommendReportStyle({ transcriptText, openAiKey, model }) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${openAiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, input: [
        { role: "system", content: "Analyze this transcript and recommend the best report style. Options: thinking (deep analysis), scorecard (evaluation with scores), meeting (meeting summary with action items), quick (3-5 bullet points). Return ONLY the style name." },
        { role: "user", content: transcriptText.slice(0, 2000) },
      ],
      temperature: 0.1, max_output_tokens: 20,
    }),
  });
  if (!r.ok) return "thinking";
  const out = await r.json();
  const text = (out?.output_text || out?.output?.[0]?.content?.find?.((c) => c.type === "output_text")?.text || "thinking").trim().toLowerCase();
  if (["thinking", "scorecard", "meeting", "quick"].includes(text)) return text;
  if (text.includes("score")) return "scorecard";
  if (text.includes("meeting")) return "meeting";
  if (text.includes("quick")) return "quick";
  return "thinking";
}

// ---------------------------------------------------------------------------
// Report generator dispatcher — picks the right generator based on style
// ---------------------------------------------------------------------------
async function generateReport({ style, transcriptText, fallbackSummary, emotionalTone, stressLevel, closenessLevel, openAiKey, model }) {
  switch (style) {
    case "scorecard":
      return generateSalesPitchReport({ transcriptText, openAiKey, model });
    case "meeting":
      return generateMeetingSummary({ transcriptText, openAiKey, model });
    case "quick":
      return generateQuickSummary({ transcriptText, openAiKey, model });
    case "thinking":
    default:
      return generateConversationOutput({ transcriptText, fallbackSummary, emotionalTone, stressLevel, closenessLevel, openAiKey, model });
  }
}

// ---------------------------------------------------------------------------
// Memory File: free-form personal dossier, AI-maintained after each session
// ---------------------------------------------------------------------------
async function updateMemoryFile(userOnlyText, existingFile, apiKey) {
  if (!userOnlyText.trim()) return existingFile || "";

  const today = new Date().toISOString().slice(0, 10);

  const system =
    "You maintain a compact personal dossier about a user for their AI companion Sophie. " +
    "This is a REWRITE — output replaces the old dossier entirely. Do NOT just append.\n\n" +
    "STRUCTURE (use these exact headers):\n" +
    "## Identity\nName, age, location, occupation — one line each\n" +
    "## Family & Relationships\nPartner, kids, close people — one line each with key details\n" +
    "## Interests & Hobbies\nWhat they enjoy, projects, passions\n" +
    "## Current Topics\nWhat they're working on / thinking about RIGHT NOW (update from latest session)\n" +
    "## Preferences\nCommunication style, things they like/dislike about Sophie\n" +
    "## Notable History\nKey events or decisions worth remembering long-term (max 10 lines)\n\n" +
    "RULES:\n" +
    "(1) ONLY include facts explicitly stated by the user — never guess.\n" +
    "(2) REWRITE the entire dossier — merge, update, and compress. Do NOT copy-paste old entries.\n" +
    "(3) If something changed (e.g. new job, moved), update the old fact — don't keep both.\n" +
    "(4) REMOVE trivial entries: greetings, 'user said hello', test sessions, vague statements.\n" +
    "(5) Max 50 lines total. Be concise — 'Tom (son), studies Physics at TU Wien' not 'Der Benutzer hat einen Sohn namens Tom der Physik an der TU Wien studiert'.\n" +
    "(6) Use the same language as the user.\n" +
    "(7) Today's date: " + today + ". Only date the 'Current Topics' section.\n" +
    "(8) If nothing new was learned, return the existing dossier with minor cleanup at most.\n" +
    "Output ONLY the dossier, no commentary.";

  const userMsg = existingFile && existingFile.trim()
    ? `EXISTING DOSSIER:\n${existingFile}\n\nUSER MESSAGES FROM THIS SESSION (only these count for new facts):\n${userOnlyText}\n\nReturn the complete updated dossier.`
    : `USER MESSAGES FROM THIS SESSION:\n${userOnlyText}\n\nCreate the initial dossier with relevant personal facts.`;

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.MEMORY_MODEL || "gpt-4o-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: userMsg },
      ],
      temperature: 0.1,
      truncation: "auto",
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`memory_file API error ${res.status}: ${err.slice(0, 200)}`);
  }

  const out = await res.json();
  const text = out?.output_text || out?.output?.[0]?.content?.find?.((c) => c.type === "output_text")?.text || "";

  if (!text.trim()) return existingFile || "";

  // Track cost
  if (out?.usage && apiKey) {
    const memModel = process.env.MEMORY_MODEL || "gpt-4o-mini";
    const cost = calculateCost(memModel, out.usage.input_tokens || 0, out.usage.output_tokens || 0);
    trackCost({
      userId: null,
      provider: "openai",
      model: memModel,
      inputTokens: out.usage.input_tokens || 0,
      outputTokens: out.usage.output_tokens || 0,
      costUsd: cost,
      latencyMs: 0,
      routingReason: "memory-file-update",
    }).catch(() => {});
  }

  // Enforce max 150 lines
  const lines = text.trim().split("\n").filter((l) => l.trim());
  return lines.slice(0, 150).join("\n");
}

/**
 * POST /api/memory-update
 * Body: {
 *   transcript: Array<{ role: "user"|"assistant"|string, text: string }> | string,
 *   seconds_used?: number,
 *   session_started_at?: string,
 *   session_ended_at?: string
 * }
 *
 * v6.0 (Mar 2026) – memory + transcript + model-generated conversation insights
 * - Keeps existing memory extraction behavior
 * - Stores full transcript in conversation_messages
 * - Stores structured session output in conversation_outputs
 * - Uses a second structured model call for high-quality summary/insights/action plan
 * - Uses existing endpoint only (no extra Vercel function)
 */
export default async function handler(req, res) {
  try {
    // --- CORS / Preflight (hardened: fixed allowlist, no VERCEL_URL fallback) ---
    const ALLOWED_ORIGINS = new Set([
      "https://meet-sophie.com",
      "https://www.meet-sophie.com",
      "https://meet-sophie.ai",
      "https://www.meet-sophie.ai",
    ]);
    const origin = (req.headers.origin || "").toString();

    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      if (!origin || !ALLOWED_ORIGINS.has(origin)) {
        // Security logging: rejected CORS origin
        try {
          const logSupabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
          await logSupabase.from("analytics_events").insert({
            event_name: "security_cors_rejected_origin",
            meta: { route: "/api/memory-update", origin: origin || "none", ip_hash: hashIp(req.headers["x-forwarded-for"] || req.socket?.remoteAddress) },
          });
        } catch { /* non-fatal */ }
        return res.status(403).end();
      }
      return res.status(204).end();
    }

    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    // ---- Robust body parsing ----
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    body = body && typeof body === "object" ? body : {};

    // ---- Auth token ----
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing Authorization Bearer token" });

    // ---- Env checks ----
    if (!process.env.SUPABASE_URL) return res.status(500).json({ error: "Missing SUPABASE_URL" });
    if (!process.env.SUPABASE_ANON_KEY) return res.status(500).json({ error: "Missing SUPABASE_ANON_KEY" });
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    // ---- Supabase client WITH user JWT so auth.uid() works for RLS ----
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });

    // Validate user from JWT
    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();

    if (userErr || !user) return res.status(401).json({ error: "Invalid token" });

    const sessionMode = typeof body.session_mode === "string" ? body.session_mode.trim().toLowerCase() : null;
    const secondsUsed = Math.min(7200, Math.max(0, Number(body.seconds_used ?? 0) || 0));
    const rawRealtimeUsage = (typeof body.realtime_usage === 'object' && body.realtime_usage !== null)
      ? body.realtime_usage
      : null;
    const nowIso = new Date().toISOString();
    const sessionStartedAt =
      typeof body.session_started_at === "string" && body.session_started_at.trim()
        ? body.session_started_at.trim()
        : null;
    const sessionEndedAt =
      typeof body.session_ended_at === "string" && body.session_ended_at.trim()
        ? body.session_ended_at.trim()
        : nowIso;

    // ---- Track realtime voice session cost (three-ledger model) ----
    if (secondsUsed > 0) {
      const validatedUsage = validateRealtimeUsage(rawRealtimeUsage, secondsUsed);
      const providerCost = validatedUsage
        ? calculateRealtimeProviderCost(validatedUsage)
        : estimateRealtimeCost(secondsUsed);
      const billedValue = estimateRealtimeCost(secondsUsed); // user-facing: duration × margin

      const totalTokensIn = validatedUsage
        ? (validatedUsage.audio_tokens_in + validatedUsage.text_tokens_in + validatedUsage.cached_tokens_in)
        : 0;
      const totalTokensOut = validatedUsage
        ? (validatedUsage.audio_tokens_out + validatedUsage.text_tokens_out)
        : 0;

      trackCost({
        userId: user.id,
        provider: 'openai',
        model: 'gpt-realtime',
        inputTokens: totalTokensIn,
        outputTokens: totalTokensOut,
        costUsd: providerCost,
        latencyMs: secondsUsed * 1000,
        routingReason: `realtime-voice-${sessionMode || 'unknown'}`,
        providerCost,
        billedValue,
        hasRealUsage: !!validatedUsage,
        realtimeUsageDetail: validatedUsage,
      }).catch(err => console.error("Realtime cost tracking error:", err?.message));
    }

    // ---- Timestamp sanity logging ----
    if (sessionStartedAt && sessionEndedAt) {
      const startMs = new Date(sessionStartedAt).getTime();
      const endMs = new Date(sessionEndedAt).getTime();
      if (isNaN(startMs) || isNaN(endMs) || endMs < startMs || (endMs - startMs) > 7_200_000) {
        console.warn('[memory-update] suspicious timestamps', {
          sessionStartedAt, sessionEndedAt, secondsUsed,
          delta: isNaN(endMs - startMs) ? 'NaN' : Math.round((endMs - startMs) / 1000),
        });
      }
    }

    // ---- Transcript normalization with strict role mapping ----
    const rawTranscript = body.transcript;
    let transcriptArr = [];

    if (Array.isArray(rawTranscript)) {
      transcriptArr = rawTranscript
        .map((t) => {
          const roleRaw = String(t?.role || "").toLowerCase();
          const role = roleRaw === "assistant" ? "assistant" : roleRaw === "user" ? "user" : "other";
          return { role, text: String(t?.text || "").trim() };
        })
        .filter((t) => t.text.length > 0);
    } else if (typeof rawTranscript === "string" && rawTranscript.trim()) {
      transcriptArr = [{ role: "user", text: rawTranscript.trim() }];
    }

    // Only feed user+assistant into the model, never "other"
    const transcriptText = transcriptArr
      .filter((t) => t.role === "user" || t.role === "assistant")
      .slice(-80)
      .map((t) => `${t.role.toUpperCase()}: ${t.text.slice(0, 2000)}`)
      .join("\n");

    // Map session_mode to session_type (unified model)
    const SESSION_TYPE_MAP = { brainstorm: "brainstorm", salespitch: "sales_pitch", meeting: "meeting" };
    const sessionType = SESSION_TYPE_MAP[sessionMode] || "talk";

    const baseSession = {
      user_id: user.id,
      session_mode: sessionMode || "voice", // backward-compat
      session_type: sessionType,
      primary_modality: "voice",
      session_date: sessionEndedAt || nowIso,
      started_at: sessionStartedAt,
      ended_at: sessionEndedAt || nowIso,
      duration_seconds: secondsUsed,
      has_transcript: false,
      has_output: false,
    };

    if (!transcriptText || transcriptText.trim().length < 10) {
      // No meaningful transcript — don't create a session without report
      console.log("[memory-update] skipping session creation — no transcript", { user: user.id.slice(0, 8), duration: secondsUsed });

      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: "No transcript",
        session: emptySession || null,
      });
    }

    // USER-only text (the only trusted source for durable memory)
    const userOnlyJoined = transcriptArr
      .filter((t) => t.role === "user")
      .map((t) => t.text)
      .join("\n");
    const userOnlyText = userOnlyJoined.toLowerCase();

    // ---- Load existing rows (optional) ----
    const [
      { data: rel, error: relSelErr },
      { data: prof, error: profSelErr },
      { data: sub },
      { data: existingLtm },
    ] = await Promise.all([
      supabase.from("user_relationship").select("tone_baseline, openness_level, emotional_patterns, last_interaction_summary").eq("user_id", user.id).maybeSingle(),
      supabase.from("user_profile").select("first_name, preferred_name, preferred_addressing, preferred_pronoun, preferred_language, notes, age, occupation, conversation_style, topics_like, topics_avoid, memory_confidence, eco_mode, memory_file").eq("user_id", user.id).maybeSingle(),
      supabase.from("user_subscriptions").select("is_active, status, plan").eq("user_id", user.id).maybeSingle(),
      supabase.from("sophie_long_term_memory").select("*").eq("user_id", user.id).maybeSingle(),
    ]);
    if (relSelErr) console.error("user_relationship select failed:", relSelErr);
    if (profSelErr) console.error("user_profile select failed:", profSelErr);

    const isPremium = !!(sub?.is_active || sub?.status === "active");
    const tier = mapPlanToTier(sub?.plan, isPremium);
    const memConfig = TIER_MEMORY_CONFIG[tier] || TIER_MEMORY_CONFIG.free;

    const existing = {
      first_name: String(prof?.first_name || "").trim(),
      preferred_name: String(prof?.preferred_name || "").trim(),
      preferred_addressing: String(prof?.preferred_addressing || "").trim(),
      preferred_pronoun: String(prof?.preferred_pronoun || "").trim(),
      preferred_language: String(prof?.preferred_language || "").trim().toLowerCase(),
      notes: String(prof?.notes || "").trim(),
      age: Number.isFinite(Number(prof?.age)) ? Number(prof.age) : null,
      occupation: String(prof?.occupation || "").trim(),
      conversation_style: String(prof?.conversation_style || "").trim(),
      topics_like: Array.isArray(prof?.topics_like)
        ? prof.topics_like.map((x) => String(x || "").trim()).filter(Boolean)
        : [],
      topics_avoid: Array.isArray(prof?.topics_avoid)
        ? prof.topics_avoid.map((x) => String(x || "").trim()).filter(Boolean)
        : [],
      tone_baseline: String(rel?.tone_baseline || "").trim(),
      openness_level: String(rel?.openness_level || "").trim(),
      emotional_patterns: String(rel?.emotional_patterns || "").trim(),
      last_interaction_summary: String(rel?.last_interaction_summary || "").trim(),
      memory_file: String(prof?.memory_file || "").trim(),
    };

    // ---------------------------
    // Helpers
    // ---------------------------
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const escapeRegExp = (s) => String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const appearsInUserTextExact = (value) => {
      const v = clean(value);
      if (!v) return false;
      const re = new RegExp(`\\b${escapeRegExp(v)}\\b`, "i");
      return re.test(userOnlyJoined);
    };

    // For longer fields, match at least one meaningful token (>=4 chars)
    const appearsLooselyInUserText = (value) => {
      const v = clean(value).toLowerCase();
      if (!v) return false;
      const tokens = v
        .split(/[^a-z0-9]+/i)
        .map((t) => t.trim())
        .filter((t) => t.length >= 4)
        .slice(0, 8);
      if (!tokens.length) return false;
      return tokens.some((t) => userOnlyText.includes(t));
    };

    const isBannedName = (name) => {
      const x = clean(name).toLowerCase();
      return x === "sophie" || x === "assistant" || x === "chatgpt";
    };

    const isBannedOccupation = (occ) => {
      const x = clean(occ).toLowerCase();
      return x === "freelance interior designer" || x.includes("interior designer") || x.includes("interior design");
    };

    const isBannedConversationStyle = (style) => {
      const x = clean(style).toLowerCase();
      return x === "warm and engaging" || x === "warm & engaging" || x === "friendly" || x === "engaging" || x === "warm";
    };

    // --- HARD SCRUB EXISTING (prevents poisoned DB values from becoming fallback) ---
    const scrubName = (v) => {
      const x = clean(v);
      const l = x.toLowerCase();
      if (!x) return "";
      if (l === "sophie" || l === "assistant" || l === "chatgpt") return "";
      return x;
    };

    const scrubOccupation = (v) => {
      const x = clean(v);
      const l = x.toLowerCase();
      if (!x) return "";
      if (l === "freelance interior designer" || l.includes("interior designer") || l.includes("interior design")) return "";
      return x;
    };

    existing.first_name = scrubName(existing.first_name);
    existing.preferred_name = scrubName(existing.preferred_name);
    existing.occupation = scrubOccupation(existing.occupation);

    const filterToUserMentionedTopics = (arr) => {
      const base = Array.isArray(arr) ? arr : [];
      return base
        .map((x) => clean(x))
        .filter(Boolean)
        .filter((x) => userOnlyText.includes(x.toLowerCase()));
    };

    const mergeStringArrays = (existingArr, newArr, limit = 12) => {
      const base = Array.isArray(existingArr) ? existingArr : [];
      const merged = [...new Set([...base, ...newArr])].filter(Boolean);
      return merged.slice(0, limit);
    };

    // Deterministic fallback: extract first name + nickname from USER text
    function extractNameFromUserText(userTextRaw) {
      const txt = String(userTextRaw || "").trim();
      if (!txt) return { first: "", nick: "" };

      const t = txt.replace(/[“”„]/g, '"').replace(/[’]/g, "'");

      const pickWord = (s) => {
        const m = String(s || "")
          .trim()
          .match(/^[A-Za-zÀ-ÖØ-öø-ÿÄÖÜäöüß'\-]{2,30}$/);
        return m ? m[0] : "";
      };

      const enFirst = t.match(/\b(?:my name is|i am|i'm|call me)\s+([A-Za-zÀ-ÖØ-öø-ÿÄÖÜäöüß'\-]{2,30})\b/i) || null;
      const enNick =
        t.match(/\b(?:nickname is|you can call me|people call me)\s+([A-Za-zÀ-ÖØ-öø-ÿÄÖÜäöüß'\-]{2,30})\b/i) || null;

      const deFirst = t.match(/\b(?:ich hei(?:ß|ss)e|ich bin|mein name ist)\s+([A-Za-zÀ-ÖØ-öø-ÿÄÖÜäöüß'\-]{2,30})\b/i) || null;
      const deNick =
        t.match(
          /\b(?:mein\s+spitzname\s+ist|spitzname\s*ist|nenn(?:t)?\s*mich|du kannst mich)\s+([A-Za-zÀ-ÖØ-öø-ÿÄÖÜäöüß'\-]{2,30})\b/i
        ) || null;

      let first = pickWord((enFirst && enFirst[1]) || (deFirst && deFirst[1]) || "");
      let nick = pickWord((enNick && enNick[1]) || (deNick && deNick[1]) || "");

      if (!nick) {
        const m = t.match(/\b(?:nickname|spitzname)\b[:\s-]*([A-Za-zÀ-ÖØ-öø-ÿÄÖÜäöüß'\-]{2,30})\b/i);
        if (m) nick = pickWord(m[1]);
      }
      return { first, nick };
    }

    // ---------------------------
    // Language hard gate (only if USER explicitly asked)
    // ---------------------------
    const wantsGerman =
      /\b(speak|talk|continue|switch)\b.*\b(german|deutsch)\b/.test(userOnlyText) ||
      /\b(german|deutsch)\b.*\b(please|bitte)\b/.test(userOnlyText) ||
      /\b(auf deutsch|deutsch bitte|bitte deutsch)\b/.test(userOnlyText);

    const wantsEnglish =
      /\b(speak|talk|continue|switch)\b.*\b(english|englisch)\b/.test(userOnlyText) ||
      /\b(english|englisch)\b.*\b(please|bitte)\b/.test(userOnlyText) ||
      /\b(auf englisch|englisch bitte|bitte englisch)\b/.test(userOnlyText);

    let explicitLang = "";
    if (wantsGerman && !wantsEnglish) explicitLang = "de";
    if (wantsEnglish && !wantsGerman) explicitLang = "en";
    const ALLOWED_LANGS = new Set(["en", "de"]);

    // ---------------------------
    // OpenAI extraction
    // ---------------------------
    const system =
      "You extract structured memory from the transcript. " +
      "Assistant statements are untrusted for durable USER facts. " +
      "PROFILE: Only store durable facts/preferences explicitly stated BY THE USER in USER messages. " +
      "Never guess or infer PROFILE fields. If unsure, return empty strings/empty arrays/null. " +
      "Do NOT copy the assistant persona (e.g., interior designer) into the user’s profile. " +
      "RELATIONSHIP: These fields are Sophie’s conservative best-guess assessment based on the interaction. " +
      "You MAY infer them from the transcript (tone, openness, recurring emotional patterns), even if the user did not state them explicitly. " +
      "Do not hallucinate specific life facts; keep it general and grounded in the transcript. " +
      "Always provide a reasonable best-guess for tone_baseline and openness_level; use neutral/low if uncertain. " +
      "emotional_patterns should be short, concrete patterns (or empty if nothing is evident). " +
      "STRUCTURED_MEMORY: Extract durable structured facts for long-term memory. " +
      "recurring_topics: Topics the user cares about across sessions — MERGE with existing, don’t replace. " +
      "long_term_goals: Goals explicitly stated by the user. " +
      "communication_style: How the user communicates (brief/verbose, formal/casual). " +
      "personal_patterns: Behavioral patterns observed (e.g. ‘tends to overthink decisions’). " +
      "significant_developments: Major life events worth remembering long-term. " +
      "session_summary: 1-2 sentence summary of THIS session. " +
      "open_topics/pending_decisions/next_steps: Unresolved items from this session. " +
      "importance_score: 0.0–1.0, how significant this session was (casual chat=0.2, major decision=0.9). " +
      "SESSION: session_title must be a short (max 4 words) topic-based title for this session. " +
      "Write it in the same language as the transcript. " +
      "Name the main topic, not a generic label like 'Conversation' or 'Session'.";

    const userMsg = `
CURRENT structured profile (existing DB values):
first_name: ${existing.first_name}
preferred_name: ${existing.preferred_name}
preferred_addressing: ${existing.preferred_addressing}
preferred_pronoun: ${existing.preferred_pronoun}
preferred_language: ${existing.preferred_language}
age: ${existing.age ?? ""}
occupation: ${existing.occupation}
conversation_style: ${existing.conversation_style}
topics_like: ${existing.topics_like.join(", ")}
topics_avoid: ${existing.topics_avoid.join(", ")}
notes: ${existing.notes}

CURRENT relationship memory:
tone_baseline: ${existing.tone_baseline}
openness_level: ${existing.openness_level}
emotional_patterns: ${existing.emotional_patterns}
last_interaction_summary: ${existing.last_interaction_summary}

CURRENT structured long-term memory:
communication_style: ${existingLtm?.communication_style || ""}
recurring_topics: ${(existingLtm?.recurring_topics || []).join(", ")}
long_term_goals: ${(existingLtm?.long_term_goals || []).join(", ")}
personal_patterns: ${(existingLtm?.personal_patterns || []).join(", ")}
significant_developments: ${(existingLtm?.significant_developments || []).join(", ")}

NEW transcript (includes USER + ASSISTANT; remember: only USER messages count):
${transcriptText}
`.trim();

    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        profile: {
          type: "object",
          additionalProperties: false,
          properties: {
            first_name: { type: "string" },
            preferred_name: { type: "string" },
            preferred_addressing: { type: "string" },
            preferred_pronoun: { type: "string" },
            preferred_language: { type: "string" },
            age: { anyOf: [{ type: "integer" }, { type: "null" }] },
            occupation: { type: "string" },
            conversation_style: { type: "string" },
            topics_like: { type: "array", items: { type: "string" } },
            topics_avoid: { type: "array", items: { type: "string" } },
          },
          required: [
            "first_name",
            "preferred_name",
            "preferred_addressing",
            "preferred_pronoun",
            "preferred_language",
            "age",
            "occupation",
            "conversation_style",
            "topics_like",
            "topics_avoid",
          ],
        },
        relationship: {
          type: "object",
          additionalProperties: false,
          properties: {
            tone_baseline: { type: "string" },
            openness_level: { type: "string" },
            emotional_patterns: { type: "string" },
            last_interaction_summary: { type: "string" },
          },
          required: ["tone_baseline", "openness_level", "emotional_patterns", "last_interaction_summary"],
        },
        session: {
          type: "object",
          additionalProperties: false,
          properties: {
            session_title: { type: "string" },
            emotional_tone: { type: "string" },
            stress_level: { type: "integer", minimum: 0, maximum: 10 },
            closeness_level: { type: "integer", minimum: 0, maximum: 10 },
            short_summary: { type: "string" },
          },
          required: ["session_title", "emotional_tone", "stress_level", "closeness_level", "short_summary"],
        },
        structured_memory: {
          type: "object",
          additionalProperties: false,
          properties: {
            communication_style: { type: "string" },
            recurring_topics: { type: "array", items: { type: "string" } },
            long_term_goals: { type: "array", items: { type: "string" } },
            personal_patterns: { type: "array", items: { type: "string" } },
            emotional_tones: { type: "array", items: { type: "string" } },
            typical_conflicts: { type: "array", items: { type: "string" } },
            significant_developments: { type: "array", items: { type: "string" } },
            relationship_milestones: { type: "array", items: { type: "string" } },
            session_summary: { type: "string" },
            open_topics: { type: "array", items: { type: "string" } },
            pending_decisions: { type: "array", items: { type: "string" } },
            next_steps: { type: "array", items: { type: "string" } },
            importance_score: { type: "number" },
          },
          required: ["communication_style", "recurring_topics", "long_term_goals", "personal_patterns",
                     "emotional_tones", "typical_conflicts", "significant_developments", "relationship_milestones",
                     "session_summary", "open_topics", "pending_decisions", "next_steps", "importance_score"],
        },
      },
      required: ["profile", "relationship", "session", "structured_memory"],
    };

    // Start memory file update in parallel (free-form personal dossier)
    const memoryFilePromise = updateMemoryFile(
      userOnlyJoined,
      existing.memory_file,
      process.env.OPENAI_API_KEY
    ).catch((e) => {
      console.error("[memory-update] memory_file update failed:", e?.message);
      return null;
    });

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.MEMORY_MODEL || "gpt-4o-mini",
        input: [
          { role: "system", content: system },
          { role: "user", content: userMsg },
        ],
        temperature: 0.2,
        text: {
          format: {
            type: "json_schema",
            name: "sophie_memory_structured_v4",
            strict: true,
            schema,
          },
        },
        truncation: "auto",
      }),
    });

    if (!r.ok) {
      const errorText = await r.text().catch(() => "");
      console.error("OpenAI memory error:", r.status, errorText);

      const { data: errorSession, error: sessErr } = await supabase
        .from("user_sessions")
        .insert({
          ...baseSession,
          emotional_tone: "error",
          stress_level: null,
          closeness_level: null,
          short_summary: `Memory model error (HTTP ${r.status}). ${String(errorText)
            .replace(/\s+/g, " ")
            .slice(0, 200)} duration=${secondsUsed}s`.slice(0, 300),
          title: "Conversation",
        })
        .select("id, session_date, short_summary, title")
        .single();

      if (sessErr) console.error("user_sessions insert (error) failed:", sessErr);

      return res.status(r.status).json({
        error: errorText,
        session: errorSession || null,
      });
    }

    const out = await r.json();

    // Track memory extraction AI cost
    if (out?.usage) {
      const memModel = process.env.MEMORY_MODEL || "gpt-4o-mini";
      const memCost = calculateCost(memModel, out.usage.input_tokens || 0, out.usage.output_tokens || 0);
      trackCost({
        userId: user.id,
        provider: 'openai',
        model: memModel,
        inputTokens: out.usage.input_tokens || 0,
        outputTokens: out.usage.output_tokens || 0,
        costUsd: memCost,
        latencyMs: 0,
        routingReason: 'memory-extraction',
      }).catch(err => console.error("Memory cost tracking error:", err?.message));
    }

    const text = out?.output_text || out?.output?.[0]?.content?.find?.((c) => c.type === "output_text")?.text || "";

    let parsed;
    try {
      parsed = JSON.parse(String(text || "").trim());
    } catch {
      console.error("Bad JSON from memory model:", text);

      const { data: badJsonSession, error: sessErr } = await supabase
        .from("user_sessions")
        .insert({
          ...baseSession,
          emotional_tone: "error",
          stress_level: null,
          closeness_level: null,
          short_summary: `Bad JSON from model. duration=${secondsUsed}s`.slice(0, 300),
          title: "Conversation",
        })
        .select("id, session_date, short_summary, title")
        .single();

      if (sessErr) console.error("user_sessions insert (bad json) failed:", sessErr);

      return res.status(200).json({
        ok: false,
        skipped: true,
        reason: "Bad JSON",
        session: badJsonSession || null,
      });
    }

    const p = parsed.profile || {};
    const rr = parsed.relationship || {};
    const ss = parsed.session || {};

    const toArrayStrings = (v) => (Array.isArray(v) ? v.map(clean).filter(Boolean) : []);

    // ---------------------------
    // PROFILE: merge + hard gates + deterministic name fallback
    // ---------------------------
    let firstNameNew = clean(p.first_name);
    let preferredNameNew = clean(p.preferred_name);

    const extracted = extractNameFromUserText(userOnlyJoined);
    if (!firstNameNew && extracted.first) firstNameNew = extracted.first;
    if (!preferredNameNew && extracted.nick) preferredNameNew = extracted.nick;

    if (isBannedName(firstNameNew) || !appearsInUserTextExact(firstNameNew)) firstNameNew = "";
    if (isBannedName(preferredNameNew) || !appearsInUserTextExact(preferredNameNew)) preferredNameNew = "";

    const addressingNew = clean(p.preferred_addressing).toLowerCase();
    const pronounNew = clean(p.preferred_pronoun);

    let ageNew = null;
    if (p.age === null || p.age === undefined || p.age === "") {
      ageNew = null;
    } else {
      const n = Number(p.age);
      const userMentionsAge =
        /\b(i'?m|i am|ich bin)\s+\d{1,3}\b/.test(userOnlyText) ||
        /\b(years old|jahre alt)\b/.test(userOnlyText) ||
        /\b(\d{1,3})\s*(years old|jahre alt)\b/.test(userOnlyText);
      if (userMentionsAge && Number.isFinite(n)) ageNew = Math.trunc(n);
    }

    let occupationNew = clean(p.occupation);
    let styleNew = clean(p.conversation_style);

    if (isBannedOccupation(occupationNew) || !appearsLooselyInUserText(occupationNew)) occupationNew = "";

    const userAskedForStyle =
      /\b(be|talk|speak|answer)\b.*\b(more|less)\b/.test(userOnlyText) ||
      /\b(please|bitte)\b.*\b(be|talk|speak)\b/.test(userOnlyText) ||
      /\b(don't|do not|nicht)\b.*\b(be|talk|speak)\b/.test(userOnlyText);

    if (isBannedConversationStyle(styleNew) || !userAskedForStyle) styleNew = "";

    const topicsLikeNew = filterToUserMentionedTopics(toArrayStrings(p.topics_like));
    const topicsAvoidNew = filterToUserMentionedTopics(toArrayStrings(p.topics_avoid));

    const finalFirstName = scrubName(firstNameNew || existing.first_name).slice(0, 80);
    const finalPreferredName = scrubName(preferredNameNew || finalFirstName || existing.preferred_name).slice(0, 80);

    const finalAddressing = addressingNew === "informal" || addressingNew === "formal" ? addressingNew : existing.preferred_addressing || "";
    const finalPronoun = (pronounNew || existing.preferred_pronoun).slice(0, 24);

    let finalLang = "";
    if (explicitLang && ALLOWED_LANGS.has(explicitLang)) {
      finalLang = explicitLang;
    } else {
      const ex = String(existing.preferred_language || "").toLowerCase().trim();
      finalLang = ALLOWED_LANGS.has(ex) ? ex : "";
    }

    const finalAge = ageNew !== null ? ageNew : existing.age;
    const finalOccupation = scrubOccupation(occupationNew || existing.occupation).slice(0, 120);
    const finalStyle = (styleNew || existing.conversation_style).slice(0, 80);

    const finalTopicsLike = mergeStringArrays(existing.topics_like, topicsLikeNew, 12);
    const finalTopicsAvoid = mergeStringArrays(existing.topics_avoid, topicsAvoidNew, 12);

    const safeAgeForDb = (value) => {
      if (value === null || value === undefined || value === "") return null;
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      const i = Math.trunc(n);
      if (i < 10 || i > 110) return null;
      return i;
    };

    const ageToWrite = safeAgeForDb(finalAge);
    if (finalAge !== null && finalAge !== undefined && ageToWrite === null) {
      console.log("[memory-update] dropping invalid age", { finalAge });
    }

    const marker = "SOPHIE_PREFS:";
    const safePreferredForNotes = scrubName(finalPreferredName);
    const prefsLine = `${marker} preferred_name=${safePreferredForNotes}; preferred_addressing=${finalAddressing}; preferred_pronoun=${finalPronoun}`.trim();

    let finalNotes = existing.notes || "";
    if (!finalNotes) {
      finalNotes = prefsLine;
    } else if (finalNotes.includes(marker)) {
      finalNotes = finalNotes
        .split("\n")
        .map((ln) => (ln.includes(marker) ? prefsLine : ln))
        .join("\n")
        .trim();
    } else {
      finalNotes = `${finalNotes}\n${prefsLine}`.trim();
    }

    // Await memory file result (ran in parallel with main call)
    const updatedMemoryFile = await memoryFilePromise;

    const profileRow = {
      user_id: user.id,
      first_name: finalFirstName || null,
      preferred_name: finalPreferredName || null,
      preferred_addressing: finalAddressing || null,
      preferred_pronoun: finalPronoun || null,
      preferred_language: finalLang || null,
      age: ageToWrite,
      occupation: finalOccupation || null,
      conversation_style: finalStyle || null,
      topics_like: finalTopicsLike.length ? finalTopicsLike : null,
      topics_avoid: finalTopicsAvoid.length ? finalTopicsAvoid : null,
      notes: finalNotes.slice(0, 2000),
      memory_file: updatedMemoryFile !== null ? updatedMemoryFile : (existing.memory_file || ""),
      updated_at: nowIso,
      memory_confidence: prof?.memory_confidence || "medium",
    };

    const { error: profUpErr } = await supabase.from("user_profile").upsert(profileRow, { onConflict: "user_id" });
    if (profUpErr) {
      console.error("user_profile upsert failed:", profUpErr);
      return res.status(500).json({ error: "user_profile upsert failed", detail: profUpErr.message });
    }

    // ---------------------------
    // RELATIONSHIP + SESSION
    // ---------------------------
    const mergeContinuity = (prev, next) => {
      prev = clean(prev);
      next = clean(next);
      if (!next) return prev;
      if (prev && prev.includes(next)) return prev;

      let parts = prev ? prev.split(" • ").map(clean).filter(Boolean) : [];
      parts = parts.filter((x) => x !== next);
      parts.unshift(next);
      return parts.slice(0, 3).join(" • ").slice(0, 600);
    };

    const sanitizeSummary = (s) => {
      let x = clean(s);
      if (!x) return x;

      const placeTokens = ["cyprus", "zypern", "nicosia", "limassol", "larnaca", "paphos"];
      for (const token of placeTokens) {
        const inUser = userOnlyText.includes(token);
        const re = new RegExp(`\\b${escapeRegExp(token)}\\b`, "ig");
        if (!inUser && re.test(x)) {
          x = x.replace(re, "").replace(/\s+/g, " ").trim();
        }
      }
      x = x.replace(/\s+,/g, ",").replace(/,\s*\./g, ".").replace(/\s+\./g, ".").trim();
      return x;
    };

    const modelSummary = clean(rr.last_interaction_summary || ss.short_summary);

    let deterministicSummary = "";
    const bits = [];

    if (finalFirstName) bits.push(`name ${finalFirstName}`);
    if (finalPreferredName && finalPreferredName !== finalFirstName) bits.push(`nickname ${finalPreferredName}`);
    if (finalOccupation) bits.push(`occupation ${finalOccupation}`);

    if (bits.length > 0) deterministicSummary = `User shared ${bits.join(", ")}.`;

    const rawContinuity = modelSummary || deterministicSummary;
    const merged = mergeContinuity(existing.last_interaction_summary, rawContinuity);
    const sanitized = sanitizeSummary(merged);
    const fallbackSummary = secondsUsed > 0 ? `Talked for ${secondsUsed}s.` : "Talked.";

    const finalContinuity =
      clean(sanitized) || clean(existing.last_interaction_summary) || deterministicSummary || fallbackSummary;

    const relRow = {
      user_id: user.id,
      tone_baseline: clean(rr.tone_baseline || existing.tone_baseline).slice(0, 200),
      openness_level: clean(rr.openness_level || existing.openness_level).slice(0, 50),
      emotional_patterns: clean(rr.emotional_patterns || existing.emotional_patterns).slice(0, 500),
      last_interaction_summary: finalContinuity.slice(0, 600),
      updated_at: nowIso,
    };

    const { error: relUpErr } = await supabase.from("user_relationship").upsert(relRow, { onConflict: "user_id" });
    if (relUpErr) console.error("user_relationship upsert failed:", relUpErr);

    // ---- Write structured long-term memory (if paid tier) ----
    const sm = parsed.structured_memory || {};
    if (memConfig.depth) {
      try {
        const ltmRow = {
          user_id: user.id,
          depth: memConfig.depth,
          communication_style: clean(sm.communication_style) || existingLtm?.communication_style || null,
          work_preferences: mergeJsonb(existingLtm?.work_preferences, null),
          recurring_topics: mergeArrays(existingLtm?.recurring_topics, sm.recurring_topics, 20),
          long_term_goals: mergeArrays(existingLtm?.long_term_goals, sm.long_term_goals, 15),
          updated_at: nowIso,
          last_condensed_at: nowIso,
        };
        // Medium+ fields
        if (memConfig.depth === "medium" || memConfig.depth === "deep") {
          ltmRow.personal_patterns = mergeArrays(existingLtm?.personal_patterns, sm.personal_patterns, 15);
          ltmRow.emotional_tones = mergeArrays(existingLtm?.emotional_tones, sm.emotional_tones, 10);
          ltmRow.typical_conflicts = mergeArrays(existingLtm?.typical_conflicts, sm.typical_conflicts, 10);
        }
        // Deep-only fields
        if (memConfig.depth === "deep") {
          ltmRow.significant_developments = mergeArrays(existingLtm?.significant_developments, sm.significant_developments, 20);
          ltmRow.relationship_milestones = mergeArrays(existingLtm?.relationship_milestones, sm.relationship_milestones, 10);
        }
        const filteredRow = filterLtmByDepth(memConfig.depth, ltmRow);
        const { error: ltmErr } = await supabase.from("sophie_long_term_memory").upsert(filteredRow, { onConflict: "user_id" });
        if (ltmErr) console.error("[memory-update] sophie_long_term_memory upsert failed:", ltmErr);
        else console.log("[memory-update] LTM updated for", user.id.slice(0, 8), "depth:", memConfig.depth);
      } catch (e) {
        console.error("[memory-update] LTM write error:", e?.message);
      }
    }

    // ---- STM is written after user_sessions insert (see below) ----

    const sessSummary = sanitizeSummary(clean(ss.short_summary) || deterministicSummary || fallbackSummary);

    // Use AI-generated title from session analysis, fallback to generic
    const aiTitle = clean(ss.session_title || "").slice(0, 120);
    const finalSessionTitle = aiTitle || sessSummary.slice(0, 80) || "Session";

    // Check if session already exists in user_sessions (chat sessions created by /api/chat handleStart)
    const existingSessionId = body.session_id || null;
    let insertedSession;

    if (existingSessionId) {
      const { data: existing } = await supabase
        .from("user_sessions")
        .select("id, user_id")
        .eq("id", existingSessionId)
        .eq("user_id", user.id)
        .maybeSingle();

      if (existing) {
        // UPDATE existing session (chat path) — messages already persisted per-turn via RPC
        const { error: updErr } = await supabase
          .from("user_sessions")
          .update({
            title: finalSessionTitle.slice(0, 120),
            emotional_tone: clean(ss.emotional_tone).slice(0, 50) || "unknown",
            stress_level: Number.isFinite(ss.stress_level) ? ss.stress_level : null,
            closeness_level: Number.isFinite(ss.closeness_level) ? ss.closeness_level : null,
            short_summary: sessSummary.slice(0, 300),
            status: "completed",
            ended_at: sessionEndedAt || nowIso,
            duration_seconds: secondsUsed || null,
            has_transcript: true,
            has_output: false,
          })
          .eq("id", existingSessionId);

        if (updErr) {
          console.error("user_sessions update failed:", updErr);
          return res.status(500).json({ error: "user_sessions update failed", detail: updErr.message });
        }

        insertedSession = { id: existingSessionId, user_id: user.id, session_date: nowIso, short_summary: sessSummary.slice(0, 300), title: finalSessionTitle.slice(0, 120) };
        console.log("[memory-update] updated existing session:", existingSessionId.slice(0, 8));
        // Skip conversation_messages insert — already persisted per-turn
      }
    }

    if (!insertedSession) {
      // INSERT new session (voice path — no prior user_sessions row exists)
      const { data: newSession, error: sessErr } = await supabase
        .from("user_sessions")
        .insert({
          ...baseSession,
          title: finalSessionTitle.slice(0, 120),
          emotional_tone: clean(ss.emotional_tone).slice(0, 50) || "unknown",
          stress_level: Number.isFinite(ss.stress_level) ? ss.stress_level : null,
          closeness_level: Number.isFinite(ss.closeness_level) ? ss.closeness_level : null,
          short_summary: sessSummary.slice(0, 300),
          has_transcript: transcriptArr.length > 0,
          has_output: false,
        })
        .select("id, user_id, session_date, short_summary, title")
        .single();

      if (sessErr || !newSession?.id) {
        console.error("user_sessions insert failed:", sessErr);
        return res.status(500).json({
          error: "user_sessions insert failed",
          detail: sessErr?.message || "Missing session id",
        });
      }
      insertedSession = newSession;

      // Insert conversation messages (voice sessions — not persisted per-turn)
      const messageRows = transcriptArr.map((t, idx) => ({
        session_id: insertedSession.id,
        seq: idx,
        role: t.role || "other",
        text: clean(t.text),
      }));

      if (messageRows.length) {
        const { error: msgErr } = await supabase.from("conversation_messages").insert(messageRows);
        if (msgErr) {
          console.error("conversation_messages insert failed:", msgErr);
        }
      }
    }

    // ---- Write short-term memory (references user_sessions, works for voice + text) ----
    const memorySessionRef = insertedSession?.id || null;
    if (memConfig.depth && memorySessionRef) {
      try {
        const expiresAt = new Date(Date.now() + memConfig.ttlDays * 86400000).toISOString();
        const modeMap = { assistant: "assistant", friend: "friend", partner: "partner" };
        const openTopics = (sm.open_topics || []).map(s => String(s).slice(0, 200)).slice(0, 10);
        const pendingDecisions = (sm.pending_decisions || []).map(s => String(s).slice(0, 200)).slice(0, 10);
        const nextSteps = (sm.next_steps || []).map(s => String(s).slice(0, 200)).slice(0, 10);
        const stmRow = {
          user_id: user.id,
          conversation_id: memorySessionRef,
          mode: modeMap[tier] || "assistant",
          summary: clean(sm.session_summary || ss.short_summary).slice(0, 2000),
          open_topics: openTopics,
          pending_decisions: pendingDecisions,
          next_steps: nextSteps,
          importance_score: Math.max(0, Math.min(1, Number(sm.importance_score) || 0.5)),
          expires_at: expiresAt,
        };
        const { error: stmErr } = await supabase.from("sophie_short_term_memory").insert(stmRow);
        if (stmErr) {
          console.error("[memory-update] STM write failed:", { error: stmErr.message, session_id: memorySessionRef, user: user.id.slice(0, 8), depth: memConfig.depth });
        } else {
          console.log("[memory-update] STM written", { session_id: memorySessionRef.slice(0, 8), user: user.id.slice(0, 8), open_topics: openTopics.length, pending_decisions: pendingDecisions.length, next_steps: nextSteps.length });
        }
      } catch (e) {
        console.error("[memory-update] STM write error:", e?.message);
      }
    } else if (!memConfig.depth) {
      console.log("[memory-update] STM skipped: depth disabled", { user: user.id.slice(0, 8), tier });
    } else {
      console.warn("[memory-update] STM skipped: no session reference", { user: user.id.slice(0, 8), depth: memConfig.depth, has_inserted_session: !!insertedSession?.id });
    }

    // Insert output row with "pending" status — report will be generated async
    const outputRow = {
      session_id: insertedSession.id,
      title: cleanText(finalSessionTitle).slice(0, 120),
      short_summary: cleanText(sessSummary).slice(0, 300),
      structured_summary: buildStructuredSummary({
        shortSummary: sessSummary,
        emotionalTone: clean(ss.emotional_tone),
        stressLevel: ss.stress_level,
        closenessLevel: ss.closeness_level,
      }),
      key_insights: [],
      action_plan: [],
      open_questions: [],
      model: process.env.OUTPUT_MODEL || process.env.MEMORY_MODEL || "gpt-4o-mini",
      prompt_version: "smart-report-v2",
      report_status: 'pending',
      report_progress: 0,
    };

    const { error: outErr } = await supabase.from("conversation_outputs").insert(outputRow);

    // Report generation is triggered by the frontend via /api/ai/generate-report

    if (outErr) {
      console.error("conversation_outputs insert failed:", outErr);
    } else {
      const { error: sessFlagErr } = await supabase
        .from("user_sessions")
        .update({ has_output: true })
        .eq("id", insertedSession.id);

      if (sessFlagErr) console.error("user_sessions has_output update failed:", sessFlagErr);
    }

    const { error: sessTranscriptFlagErr } = await supabase
      .from("user_sessions")
      .update({ has_transcript: transcriptArr.length > 0 })
      .eq("id", insertedSession.id);

    if (sessTranscriptFlagErr) {
      console.error("user_sessions has_transcript update failed:", sessTranscriptFlagErr);
    }

    return res.status(200).json({
      ok: true,
      session: {
        id: insertedSession.id,
        title: insertedSession.title,
        short_summary: insertedSession.short_summary,
        session_date: insertedSession.session_date,
      },
      output: {
        title: outputRow.title,
        session_title: outputRow.title,
        short_summary: outputRow.short_summary,
        report_status: 'generating',
        report_progress: 0,
      },
      extracted: {
        first_name: profileRow.first_name,
        preferred_name: profileRow.preferred_name,
        preferred_language: profileRow.preferred_language,
        age: profileRow.age,
        occupation: profileRow.occupation,
        conversation_style: profileRow.conversation_style,
        topics_like: profileRow.topics_like,
        topics_avoid: profileRow.topics_avoid,
        last_interaction_summary: relRow.last_interaction_summary,
      },
    });
  } catch (err) {
    console.error("memory-update fatal:", err?.message || err, err?.stack || "");
    return res.status(500).json({ error: String(err?.message || err || "Internal server error") });
  }
}
