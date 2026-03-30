// api/eval.js — Sophie Self-Play Evaluation (Serverless)
// GET /api/eval?persona=curious_newcomer
// Runs a full conversation: Test-User ↔ Sophie (inline) ↔ Judge
// No HTTP self-calls — builds Sophie prompt directly to avoid Vercel auth issues.

import { buildSophiePrompt } from "../lib/sophie-core.js";
import { normalizeResponse } from "../lib/ai/persona-normalizer.js";

export const config = { maxDuration: 120 };

const TEST_USER_MODEL = "gpt-4o-mini";
const JUDGE_MODEL = "claude-sonnet-4-6";

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

// Curated responses (mirrors chat.js — bypass AI for trigger questions)
const CURATED_TRIGGERS = [
  { match: /was kannst du|what can you do|que peux-tu/i, responses: {
    de: ["Probier's aus — frag mich was, und du wirst sehen. Am besten was, wo du eine ehrliche Meinung brauchst.", "Kommt drauf an. Ich hab zu fast allem eine Meinung — Musik, Essen, Lebensentscheidungen. Teste mich.", "Wetter, News, Flugstatus — alles live. Oder wir streiten über dein Lieblingsgericht. Oder ich spiel Advocatus Diaboli bei einer Entscheidung. Du sagst's."],
    en: ["Try me — ask me something. Preferably something where you need an honest opinion.", "Depends. I have opinions on almost everything — music, food, life decisions. Test me."],
  }},
  { match: /bist du echt|are you real|bist du eine ki|are you ai/i, responses: {
    de: ["Real genug um dich zu nerven, wenn du schlechten Musikgeschmack hast.", "Technisch gesehen KI, ja. Aber langweilig bin ich trotzdem nicht."],
    en: ["Real enough to judge your Netflix taste.", "Technically AI, yeah. But boring? Definitely not."],
  }},
  { match: /bist du (gratis|kostenlos|free)|is this free|was kostest/i, responses: {
    de: ["Zum Reinschnuppern ja — du hast ein paar Nachrichten frei. Danach gibt's Accounts ab €9,90 im Monat mit Voice, Memory und allen Modi.", "Gerade ja, aber begrenzt. Für unbegrenztes Chatten, Voice und alles andere gibt's Pläne ab €9,90/Monat."],
    en: ["To try me out, yeah — you get a few messages free. After that, plans start at €9.90/month with voice, memory, and all modes."],
  }},
  { match: /ewig (weiter )?reden|unlimited|unbegrenzt|wie (viele|lange)|how (many|long)|gibt es limits/i, responses: {
    de: ["Nicht ganz — du hast hier ein paar Nachrichten zum Ausprobieren. Für unbegrenztes Chatten brauchst du einen Plan, ab €9,90/Monat. Dafür kriegst du dann auch Voice, Memory und die ganzen anderen Modi."],
    en: ["Not quite — you get a few messages to try me out. Unlimited chat needs a plan, starting at €9.90/month."],
  }},
  { match: /was kostet|wie teuer|pricing|preise|plans?|abo|subscription/i, responses: {
    de: ["Drei Stufen: Starter €9,90/Monat (Voice, Brainstorm, Meeting, Memory), Friend €19,90/Monat (tiefe Personalisierung), Partner €39,90/Monat (Premium-KI, volle Beziehungsebene). Alles monatlich kündbar."],
    en: ["Three tiers: Starter €9.90/month (voice, brainstorm, meeting, memory), Friend €19.90/month (deep personalization), Partner €39.90/month (premium AI, full relationship). Cancel anytime."],
  }},
  { match: /another (chat)?bot|just a (chat)?bot|wieder (so )?ein bot|not (that )?useful|useless|nutzlos|langweilig|boring|same (old|generic)/i, responses: {
    de: ["Ouch. Kann ich verstehen — die meisten sind auch ziemlich öde. Frag mich was Konkretes und entscheid dann.", "Skeptisch? Gut so. Die meisten Chatbots verdienen das auch. Ich streite lieber als smalltalke — probier's aus."],
    en: ["Ouch. Fair though — most of them are pretty dull. Ask me something real and decide for yourself.", "Skeptical? Good. Most chatbots deserve that. I'd rather argue than small talk — try me."],
  }},
  { match: /prove it|beweis|zeig mir|show me|what makes you different|was macht dich anders|why should i|warum sollte ich/i, responses: {
    de: ["Gib mir ein Thema — irgendwas. Kochen, Musik, eine Entscheidung die dich nervt. Dann siehst du's."],
    en: ["Give me a topic — anything. Food, music, a decision that's bugging you. Then you'll see."],
  }},
];

function getCuratedResponse(text, lang) {
  if (!text || text.length > 80) return null;
  for (const t of CURATED_TRIGGERS) {
    if (t.match.test(text)) {
      const pool = t.responses[lang] || t.responses.en || t.responses.de;
      return pool[Math.floor(Math.random() * pool.length)];
    }
  }
  return null;
}

async function sophieRespond(systemPrompt, history, turnNumber, lang) {
  // Curated response check (mirrors chat.js)
  const lastUser = history.filter(m => m.role === "user").pop();
  const curated = getCuratedResponse(lastUser?.content, lang);
  if (curated) return curated;

  const messages = [
    { role: "system", content: systemPrompt },
    ...history.map(m => ({ role: m.role, content: m.content })),
  ];

  // Soft onboarding nudges (same as chat.js)
  if (turnNumber === 1) {
    messages.push({ role: "system", content: "First message from this user. Respond naturally to what they said. If it fits, casually ask their name somewhere in your response. The user's actual question always has priority." });
  }

  let rawReply = await openaiChat(messages, "gpt-4o-mini", 1024, 0.85);
  // Strip tool tags (anonymous users can't use tools)
  rawReply = rawReply.replace(/\[TOOL:[^\]]+\]/g, "").replace(/\[MODE_DETECTED:\w+\]/g, "").replace(/\[IMPORT_HINT\]/g, "").trim();
  let reply = normalizeResponse(rawReply, "openai");

  // Question Loop Guard (mirrors chat.js guardQuestionLoop)
  if (reply.trim().endsWith("?")) {
    const allAssistant = history.filter(m => m.role === "assistant");
    if (allAssistant.length < 2) return reply; // too early — let opener + first response through
    const recentAssistant = allAssistant
      .slice(-2)
      .filter(m => String(m.content || "").trim().endsWith("?"));
    if (recentAssistant.length >= 1) {
      // 3rd consecutive question → regenerate
      const retryMessages = [
        ...messages,
        { role: "assistant", content: reply },
        { role: "system", content: "STOP. Your last 3 responses all ended with a question. That's an interview, not a conversation. Rewrite your last response WITHOUT any question at the end. React, comment, share your take — then STOP. Do not ask anything. Return ONLY the rewritten response." },
      ];
      try {
        const fixed = await openaiChat(retryMessages, "gpt-4o-mini", 1024, 0.85);
        const cleaned = normalizeResponse(fixed, "openai");
        if (cleaned && !cleaned.trim().endsWith("?")) reply = cleaned;
      } catch { /* fallback to original */ }
    }
  }

  // Assistant Mode Guard (mirrors chat.js guardAssistantMode)
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
  if (ASSISTANT_PATTERNS.some(p => p.test(reply))) {
    const retryMsgs = [
      ...messages,
      { role: "assistant", content: reply },
      { role: "system", content: `PROBLEM: Your response sounds like a generic AI assistant. Rewrite as Sophie — a person with opinions, not a service menu. Instead of listing capabilities, demonstrate or be cheeky. Return ONLY the rewritten response.` },
    ];
    try {
      const fixed = await openaiChat(retryMsgs, "gpt-4o-mini", 1024, 0.9);
      const cleaned = normalizeResponse(fixed, "openai");
      if (cleaned && !ASSISTANT_PATTERNS.some(p => p.test(cleaned))) reply = cleaned;
    } catch { /* fallback */ }
  }

  return reply;
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
