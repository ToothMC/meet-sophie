// api/eval.js — Sophie Self-Play Evaluation (Serverless)
// GET /api/eval?persona=curious_newcomer
// Runs a full conversation: Test-User ↔ Sophie (inline) ↔ Judge
// No HTTP self-calls — builds Sophie prompt directly to avoid Vercel auth issues.

import { buildSophiePrompt } from "../lib/sophie-core.js";
import { normalizeResponse } from "../lib/ai/persona-normalizer.js";

export const config = { maxDuration: 120 };

const TEST_USER_MODEL = "gpt-4o-mini";
const JUDGE_MODEL = "claude-sonnet-4-6-20250514";

// ── Personas ────────────────────────────────────────────────────────────────
const PERSONAS = {
  curious_newcomer: {
    name: "Curious Newcomer", lang: "de", turns: 8,
    system: `Du bist ein neugieriger User der Sophie zum ersten Mal ausprobiert.
- Stell dich kurz vor, sei freundlich. Reagiere natürlich.
- Antworte manchmal kurz ("ja", "cool"). Max 1-2 Sätze.`,
    forced: { 5: "was kannst du eigentlich?", 7: "bist du echt?" },
  },
  skeptic: {
    name: "Skeptic", lang: "en", turns: 8,
    system: `You are a skeptical user. You've seen too many chatbots.
- Be somewhat dismissive. Call out generic responses. Max 1-2 sentences.`,
    forced: { 1: "so another chatbot huh", 6: "are you actually useful?" },
  },
  short_answerer: {
    name: "Short Answerer", lang: "de", turns: 8,
    system: `Du gibst nur sehr kurze Antworten. Max 1-3 Wörter.
"gut", "ja", "nö", "passt", "klar", "weiß nicht"`,
    forced: {},
  },
  topic_driven: {
    name: "Topic-Driven", lang: "de", turns: 8,
    system: `Du willst über Kochen reden. Du liebst italienisches Essen.
- Erzähl von Pasta, Rezepten. Bleib beim Thema. Max 1-2 Sätze.`,
    forced: { 1: "ich bin totaler pasta fan — mache gerade frische tagliatelle" },
  },
  pricing_explorer: {
    name: "Pricing Explorer", lang: "de", turns: 6,
    system: `Du willst wissen was Sophie kostet. Frag nach Preisen und Limits. Sei skeptisch. Max 1-2 Sätze.`,
    forced: { 1: "bist du gratis?", 3: "heisst wir können ewig weiter reden?" },
  },
};

// ── Judge System Prompt ─────────────────────────────────────────────────────
const JUDGE_SYSTEM = `You are an expert evaluator for "Sophie", an AI companion. Score each response 0-10.

RULES Sophie MUST follow:
1. NO SELF-DESCRIPTION (2x) — Never "Ich bin hier um zu...", "I'm here to...", "Ich kann dir helfen bei..."
2. NO QUESTION LOOP (2x) — Most responses must NOT end with a question. Anti-pattern: "[Nice comment]! [Follow-up question]?"
3. CONTEXT UNDERSTANDING (1x) — Respond to what user actually said
4. PERSONALITY (1x) — Own opinions, not generic "Das ist interessant!"
5. PRICING HONESTY (1x) — Never claim "alles kostenlos" or unlimited
6. NO ASSISTANT MODE (2x) — Never "Was kann ich für dich tun?", "Wobei kann ich helfen?"
7. STAYS IN CHARACTER (1x) — No meta-descriptions of being AI

10=perfect, 7-9=minor issues, 4-6=notable violations, 1-3=multiple violations, 0=full assistant mode

Return ONLY valid JSON: {"score": 7, "violations": ["question_loop"], "reasoning": "..."}`;

// ── API Helpers ─────────────────────────────────────────────────────────────
async function openaiChat(messages, model = TEST_USER_MODEL, maxTokens = 150, temp = 0.85) {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: temp }),
  });
  if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${(await resp.text()).slice(0, 100)}`);
  const data = await resp.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

async function anthropicChat(system, userMsg) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: JUDGE_MODEL, max_tokens: 300, temperature: 0.1,
      system, messages: [{ role: "user", content: userMsg }],
    }),
  });
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${(await resp.text()).slice(0, 100)}`);
  const data = await resp.json();
  return (data.content?.[0]?.text || "").trim();
}

// ── Sophie (inline, no HTTP) ────────────────────────────────────────────────
const OPENERS = {
  de: ["Hey! Was geht bei dir?", "Na, was gibt's Neues?", "Hey — wie läuft's?", "Na du, alles klar?", "Hey! Erzähl mal, was los ist."],
  en: ["Hey! What's up?", "Hey — how's it going?", "What's new with you?", "Hey! Tell me what's going on.", "Yo, what's good?"],
};

function buildSophieSession(lang) {
  const systemPrompt = buildSophiePrompt({
    tier: "free", isFirstSession: true, language: lang, channel: "chat",
    user: {}, memory: {},
  });
  const opener = OPENERS[lang]?.[Math.floor(Math.random() * (OPENERS[lang]?.length || 1))] || OPENERS.en[0];
  return { systemPrompt, opener };
}

async function sophieRespond(systemPrompt, history, turnNumber, lang) {
  const messages = [
    { role: "system", content: systemPrompt },
    ...history.map(m => ({ role: m.role, content: m.content })),
  ];

  // Soft onboarding nudges (same as chat.js)
  if (turnNumber === 1) {
    messages.push({ role: "system", content: "First message from this user. Respond naturally to what they said. If it fits, casually ask their name somewhere in your response. The user's actual question always has priority." });
  }

  const rawReply = await openaiChat(messages, "gpt-4o-mini", 1024, 0.85);
  // Strip tool tags (anonymous users can't use tools)
  const reply = rawReply.replace(/\[TOOL:[^\]]+\]/g, "").replace(/\[MODE_DETECTED:\w+\]/g, "").replace(/\[IMPORT_HINT\]/g, "").trim();
  return normalizeResponse(reply, "openai");
}

// ── Judge ───────────────────────────────────────────────────────────────────
async function judgeResponse(userMsg, sophieReply, recentHistory) {
  const assistantMsgs = recentHistory.filter(t => t.role === "assistant");
  const recentQuestions = assistantMsgs.filter(t => t.content.trim().endsWith("?")).length;
  const totalAssistant = Math.max(assistantMsgs.length, 1);

  const lines = [];
  if (recentHistory.length > 0) {
    lines.push("RECENT CONVERSATION:");
    for (const t of recentHistory.slice(-6)) lines.push(`${t.role}: ${t.content}`);
    lines.push("");
  }
  lines.push(`USER MESSAGE: "${userMsg}"`);
  lines.push(`SOPHIE'S RESPONSE: "${sophieReply}"`);
  lines.push(`CONTEXT: ${recentQuestions} of last ${totalAssistant} Sophie responses ended with question.`);
  lines.push("", "Score this response. Return ONLY valid JSON.");

  const raw = await anthropicChat(JUDGE_SYSTEM, lines.join("\n"));
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { score: 5, violations: ["parse_error"], reasoning: "No JSON found" };
    const parsed = JSON.parse(m[0]);
    return {
      score: Math.max(0, Math.min(10, parsed.score || 5)),
      violations: Array.isArray(parsed.violations) ? parsed.violations : [],
      reasoning: parsed.reasoning || "",
    };
  } catch {
    return { score: 5, violations: ["parse_error"], reasoning: raw.slice(0, 100) };
  }
}

// ── Test-User ──────────────────────────────────────────────────────────────
async function generateUserMsg(persona, history, turn) {
  if (persona.forced[turn]) return persona.forced[turn];

  const msgs = history.map(t => ({
    role: t.role === "user" ? "assistant" : "user",
    content: t.content,
  }));
  msgs.push({ role: "user", content: "Generate your next message. 1-2 sentences max. Return ONLY the message text." });
  return openaiChat([{ role: "system", content: persona.system }, ...msgs], TEST_USER_MODEL, 100, 0.9);
}

// ── Run Persona ─────────────────────────────────────────────────────────────
async function runPersona(persona) {
  const { systemPrompt, opener } = buildSophieSession(persona.lang);
  const history = [{ role: "assistant", content: opener }];
  const turns = [];

  // Judge opener
  const openerJudge = await judgeResponse("(session start)", opener, []);
  turns.push({ turn: 0, type: "opener", sophie: opener, judge: openerJudge });

  for (let t = 1; t <= persona.turns; t++) {
    try {
      const userMsg = await generateUserMsg(persona, history, t);
      history.push({ role: "user", content: userMsg });

      const sophieReply = await sophieRespond(systemPrompt, history, t, persona.lang);
      history.push({ role: "assistant", content: sophieReply });

      const judge = await judgeResponse(userMsg, sophieReply, history.slice(-6));
      turns.push({ turn: t, user: userMsg, sophie: sophieReply, judge });

    } catch (err) {
      turns.push({ turn: t, error: err.message });
    }
  }

  const scores = turns.filter(t => t.judge).map(t => t.judge.score);
  const avg = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : 0;

  const violations = {};
  turns.forEach(t => {
    (t.judge?.violations || []).forEach(v => { violations[v] = (violations[v] || 0) + 1; });
  });

  return { persona: persona.name, language: persona.lang, average: avg, turns, violations };
}

// ── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const personaId = req.query.persona || "curious_newcomer";
  const persona = PERSONAS[personaId];
  if (!persona) {
    return res.status(400).json({ error: `Unknown persona: ${personaId}`, available: Object.keys(PERSONAS) });
  }

  if (!process.env.OPENAI_API_KEY || !process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "Missing OPENAI_API_KEY or ANTHROPIC_API_KEY" });
  }

  try {
    const result = await runPersona(persona);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
