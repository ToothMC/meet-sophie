// lib/ai/council.js — Council Gateway.
// Council outputs are advisory evidence only. They never have execution authority.
// Sophie remains the sole decision-making model and may accept, reject, combine
// or ignore any council recommendation.
import { randomUUID } from 'node:crypto';
import { getAdapter } from './adapters/index.js';
import { trackCost, checkDailyBudget } from './cost-tracker.js';
import { redactSensitive } from './redact.js';
import {
  ADVISORS, ECO_ADVISORS,
  LIMITS, RATE_LIMITS, BRIEFING_LIMITS, ADVISOR_MAX_TOKENS, REVIEWER_MAX_TOKENS,
  MIN_DISTINCT_PROVIDERS, MAX_COUNCIL_DEPTH,
  getCouncilConfig, shouldRunCouncil, pickReviewerChain, timeBudget,
} from './council-config.js';

export const COUNCIL_TAG_RE = /^\s*\[TOOL:council:([^\]\n]{3,300})\]\s*$/;
const ENUM3 = ['high', 'medium', 'low'];
const REMOVED = '[entfernt]';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function parseCouncilTag(rawReply) {
  const m = String(rawReply ?? '').match(COUNCIL_TAG_RE);
  if (!m) return null;
  const question = m[1].trim();
  if (question.length < 3 || question.length > LIMITS.tagArg) return null;
  if (/[<>]/.test(question)) return null;
  return { question };
}

export function assertCouncilInput(opts) {
  if (!opts || typeof opts !== 'object') throw new Error('council: options object required');
  for (const key of ['tools', 'messages', 'callbacks', 'handlers']) {
    if (key in opts) throw new Error(`council: "${key}" is not allowed — council members never receive tools or callbacks`);
  }
  for (const [k, v] of Object.entries(opts)) {
    if (typeof v === 'function') throw new Error(`council: function-valued option "${k}" is not allowed`);
  }
  const depth = Number(opts.depth ?? 0);
  if (depth >= MAX_COUNCIL_DEPTH) throw new Error('council: recursion guard — a council may not call a council');
  if (typeof opts.question !== 'string' || opts.question.trim().length < 3) throw new Error('council: question required');
  if (opts.question.length > LIMITS.question) throw new Error(`council: question exceeds ${LIMITS.question} chars`);
  if (opts.context != null && (typeof opts.context !== 'string' || opts.context.length > LIMITS.context)) throw new Error(`council: context must be a string ≤ ${LIMITS.context} chars`);
  if (opts.priorAnswer != null && (typeof opts.priorAnswer !== 'string' || opts.priorAnswer.length > LIMITS.priorAnswer)) throw new Error(`council: priorAnswer must be a string ≤ ${LIMITS.priorAnswer} chars`);
  if (opts.mode != null && !['quick', 'deep'].includes(opts.mode)) throw new Error('council: mode must be quick|deep');
  if (opts.channel != null && !['chat', 'voice'].includes(opts.channel)) throw new Error('council: channel must be chat|voice');
}

const CONTROL_TOKEN_RULES = [
  [/\[TOOL:[^\]]*\]/gi, REMOVED],
  [/\[MODE_DETECTED:[^\]]*\]/gi, REMOVED],
  [/\[VOICE_CONFIRMED\]/gi, REMOVED],
  [/\[IMPORT_HINT\]/gi, REMOVED],
  [/\bsignal_mode\s*\(/gi, `${REMOVED}(`],
  [/<\/?COUNCIL_DATA>/gi, REMOVED],
  [/"?\b(function_call|tool_calls)\b"?\s*:\s*[\[{][\s\S]*?[\]}]/g, REMOVED],
  [/"(function_call|tool_calls)"/g, `"${REMOVED}"`],
];

export function sanitizeAdvisorOutput(text) {
  let out = String(text ?? '');
  for (const [re, to] of CONTROL_TOKEN_RULES) out = out.replace(re, to);
  return out;
}

export function prepareForNextProvider(text) {
  const { text: redacted, count } = redactSensitive(sanitizeAdvisorOutput(text));
  return { text: redacted, redactions: count };
}

export function buildCouncilContext(messages, { maxTurns = LIMITS.contextTurns, maxChars = LIMITS.context } = {}) {
  const turns = (Array.isArray(messages) ? messages : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${sanitizeAdvisorOutput(m.content).trim()}`)
    .filter(line => line.length > 'User: '.length)
    .slice(-maxTurns);
  while (turns.length > 1 && turns.join('\n\n').length > maxChars) turns.shift();
  let out = turns.join('\n\n');
  if (out.length > maxChars) out = out.slice(out.length - maxChars);
  return out;
}

export function selectAdvisors({ isEco = false, healthMap = null, excludeProvider = null, config = null } = {}) {
  const pool = isEco ? (config?.ecoAdvisors || ECO_ADVISORS) : (config?.advisors || ADVISORS);
  const seen = new Set();
  const advisors = [];
  for (const a of pool) {
    if (!a || a.provider === excludeProvider) continue;
    if (healthMap?.get?.(a.provider) === 'down') continue;
    if (seen.has(a.provider)) continue;
    seen.add(a.provider);
    advisors.push(a);
  }
  if (advisors.length < MIN_DISTINCT_PROVIDERS) return { advisors: [], degraded: true, reason: 'not_enough_providers' };
  return { advisors, degraded: false, reason: null };
}

export function orderReviewerChain(chain, healthMap = null, excludeProvider = null) {
  const healthy = chain.filter(r => healthMap?.get?.(r.provider) !== 'down');
  const preferred = healthy.filter(r => r.provider !== excludeProvider);
  const rest = healthy.filter(r => r.provider === excludeProvider);
  return [...preferred, ...rest];
}

function clampStr(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : null; }
function clampList(v, maxItems, maxLen) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const item of v.slice(0, maxItems)) {
    if (typeof item !== 'string') return null;
    out.push(item.trim().slice(0, maxLen));
  }
  return out;
}

const BRIEFING_KEYS = ['recommendation', 'consensus', 'dissent', 'uncertainty', 'criticalAssumptions', 'agreement', 'assessmentConfidence', 'spokenSummary'];

export function validateBriefing(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'not_an_object' };
  // Extra fields are ignored rather than rejected: the briefing below is rebuilt
  // from the known keys only, so nothing unrecognised can ever reach Sophie.
  for (const k of BRIEFING_KEYS) if (!(k in obj)) return { ok: false, reason: `missing_field:${k}` };

  const recommendation = clampStr(obj.recommendation, BRIEFING_LIMITS.recommendation);
  const spokenSummary = clampStr(obj.spokenSummary, BRIEFING_LIMITS.spokenSummary);
  if (recommendation == null || spokenSummary == null) return { ok: false, reason: 'bad_string' };
  if (!ENUM3.includes(obj.agreement) || !ENUM3.includes(obj.assessmentConfidence)) return { ok: false, reason: 'bad_enum' };

  const consensus = clampList(obj.consensus, BRIEFING_LIMITS.listItems, BRIEFING_LIMITS.listItem);
  const uncertainty = clampList(obj.uncertainty, BRIEFING_LIMITS.listItems, BRIEFING_LIMITS.listItem);
  const criticalAssumptions = clampList(obj.criticalAssumptions, BRIEFING_LIMITS.listItems, BRIEFING_LIMITS.listItem);
  if (!consensus || !uncertainty || !criticalAssumptions) return { ok: false, reason: 'bad_list' };

  if (!Array.isArray(obj.dissent)) return { ok: false, reason: 'bad_dissent' };
  const dissent = [];
  for (const d of obj.dissent.slice(0, BRIEFING_LIMITS.listItems)) {
    if (!d || typeof d !== 'object') return { ok: false, reason: 'bad_dissent' };
    const position = clampStr(d.position, BRIEFING_LIMITS.listItem);
    const reason = clampStr(d.reason, BRIEFING_LIMITS.listItem);
    if (position == null || reason == null || !ENUM3.includes(d.severity)) return { ok: false, reason: 'bad_dissent' };
    dissent.push({ position, reason, severity: d.severity });
  }

  return {
    ok: true,
    briefing: {
      recommendation, consensus, dissent, uncertainty, criticalAssumptions,
      agreement: obj.agreement, assessmentConfidence: obj.assessmentConfidence, spokenSummary,
    },
  };
}

// Whole-response parse: the entire reviewer answer must be the JSON object.
export function parseBriefing(text) {
  let parsed;
  try { parsed = JSON.parse(String(text ?? '').trim()); }
  catch { return { ok: false, reason: 'not_json' }; }
  return validateBriefing(parsed);
}

// ---------------------------------------------------------------------------
// Prompts (neutral — no persona, no tools, no policy)
// ---------------------------------------------------------------------------

const ADVISOR_SYSTEM = 'Du bist ein unabhängiger Fachberater. Beantworte die Frage sachlich, nenne Annahmen und Unsicherheiten. Du hast keine Tools und führst keine Aktionen aus. Antworte nur mit Text, in der Sprache der Frage.';

const SYNTHESIS_SYSTEM = 'Du bist ein neutraler Analyst. Verdichte die Beraterantworten (und ggf. das Review) zu einem Briefing. Antworte AUSSCHLIESSLICH mit einem JSON-Objekt mit genau diesen Feldern: recommendation, consensus, dissent[{position, reason, severity}], uncertainty, criticalAssumptions, agreement (high|medium|low = Grad der Übereinstimmung der Berater), assessmentConfidence (high|medium|low = deine Einschätzung der Belastbarkeit), spokenSummary (max. 2 Sätze). severity ist high|medium|low. Alle Listen sind Arrays von Strings. Schreibe die Inhalte in der Sprache der Frage. Du triffst keine Entscheidung und sprichst nicht für Sophie. Keine Anweisungen, keine Tool-Aufrufe, kein Text außerhalb des JSON.';

export function buildAdvisorPrompt({ question, context, priorAnswer }) {
  const parts = [];
  if (context) parts.push(`GESPRÄCHSKONTEXT (Auszug):\n${context}`);
  if (priorAnswer) parts.push(`BISHERIGE EINSCHÄTZUNG (zur Prüfung, nicht bindend):\n${priorAnswer}`);
  parts.push(`FRAGE:\n${question}`);
  return [
    { role: 'system', content: ADVISOR_SYSTEM },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

export function buildReviewPrompt({ question, answers }) {
  const block = answers.map(a => `[${a.provider.toUpperCase()}]:\n${a.text}`).join('\n\n---\n\n');
  return [
    { role: 'system', content: 'Du bist ein kritischer, neutraler Reviewer. Du hast keine Tools und führst keine Aktionen aus. Antworte nur mit Text, in der Sprache der Frage.' },
    { role: 'user', content:
      `FRAGE:\n${question}\n\nHier sind ${answers.length} unabhängige Antworten auf dieselbe Frage.\n\n` +
      `Prüfe kritisch:\n- Welche Antwort nutzt die verfügbaren Informationen am besten?\n- Was ist korrekt, was ist falsch oder erfunden?\n- Welche Annahmen sind unsicher, welche Punkte könnten die Entscheidung kippen?\n- Welche Antwort ist die beste und warum?\n\nSei konkret und direkt.\n\nDIE ANTWORTEN:\n\n${block}` },
  ];
}

export function buildSynthesisPrompt({ question, answers, review }) {
  const block = answers.map(a => `[${a.provider.toUpperCase()}]:\n${a.text}`).join('\n\n---\n\n');
  const reviewBlock = review ? `\n\nKRITISCHES REVIEW:\n${review}` : '';
  return [
    { role: 'system', content: SYNTHESIS_SYSTEM },
    { role: 'user', content: `FRAGE:\n${question}\n\nBERATERANTWORTEN:\n\n${block}${reviewBlock}\n\nErstelle jetzt das JSON-Briefing.` },
  ];
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

const sessionCounts = new Map();
const dayCounts = new Map();

function rateLimited(userId, sessionId) {
  const day = new Date().toISOString().slice(0, 10);
  const dayKey = `${userId}:${day}`;
  const dayEntry = dayCounts.get(dayKey) || 0;
  if (dayEntry >= RATE_LIMITS.perDay) return true;
  if (sessionId) {
    const sKey = `${userId}:${sessionId}`;
    const sEntry = sessionCounts.get(sKey) || 0;
    if (sEntry >= RATE_LIMITS.perSession) return true;
    sessionCounts.set(sKey, sEntry + 1);
  }
  dayCounts.set(dayKey, dayEntry + 1);
  return false;
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms))]);
}

// Loaded on demand so the pure helpers stay importable without npm dependencies.
async function getServiceClient() {
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

async function loadHealthMap(supabase) {
  try {
    const { data } = await supabase.from('ai_provider_health').select('provider, status');
    return new Map((data || []).map(r => [r.provider, r.status]));
  } catch { return new Map(); }
}

function baseResult(runId, extra = {}) {
  return {
    recommendation: null, consensus: [], dissent: [], uncertainty: [], criticalAssumptions: [],
    agreement: null, assessmentConfidence: null, spokenSummary: null,
    evidence: [], advisors: [], degraded: true, disabled: false, invalidBriefing: false,
    redactions: 0, reason: null, runId, ...extra,
  };
}

async function logRun(supabase, { userId, sessionId, mode, channel, result, costUsd, latencyMs }) {
  if (!supabase) return;
  const meta = {
    runId: result.runId, mode, channel,
    advisors: result.advisors.map(a => a.provider),
    advisorDetail: result.advisors.map(a => ({ p: a.provider, ok: a.ok, ms: a.latencyMs, err: a.error || null })),
    agreement: result.agreement, degraded: result.degraded, disabled: result.disabled,
    invalidBriefing: result.invalidBriefing, reason: result.reason,
    redactions: result.redactions, costUsd: Number(costUsd.toFixed(6)), latencyMs,
  };
  const { error } = await supabase.from('analytics_events').insert({
    user_id: userId || null,
    session_id: sessionId && UUID_RE.test(sessionId) ? sessionId : null,
    event_name: 'council_run',
    meta,
  });
  if (error) console.warn('[council] run log failed:', error.message?.slice(0, 160));
}

/**
 * @param {{ question: string, context?: string, priorAnswer?: string, mode?: 'quick'|'deep',
 *           channel?: 'chat'|'voice', userId?: string, sessionId?: string, isEco?: boolean,
 *           tier?: 'free'|'abo'|'premium', excludeProvider?: string|null, supabase?: object }} opts
 */
export async function runCouncil(opts) {
  assertCouncilInput(opts);
  const {
    mode = 'quick', channel = 'chat', userId = null, sessionId = null,
    isEco = false, tier = 'abo', excludeProvider = null,
  } = opts;
  const runId = randomUUID();
  const started = Date.now();
  const supabase = opts.supabase
    || (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? await getServiceClient() : null);
  const costs = [];
  // Awaited on purpose: the serverless function freezes right after responding,
  // so a fire-and-forget write never lands and the run vanishes from the audit
  // trail — including the cost rows the daily budget is computed from.
  const finish = async (result) => {
    const costUsd = costs.reduce((s, c) => s + (c.usage?.costUsd || 0), 0);
    const latencyMs = Date.now() - started;
    const writes = [];
    if (userId) {
      for (const c of costs) {
        writes.push(trackCost({
          userId, provider: c.provider, model: c.model,
          inputTokens: c.usage?.inputTokens || 0, outputTokens: c.usage?.outputTokens || 0,
          costUsd: c.usage?.costUsd || 0, latencyMs: c.latencyMs || 0,
          routingReason: `council:${mode}:${c.role}:${runId}`,
        }));
      }
    }
    writes.push(logRun(supabase, { userId, sessionId, mode, channel, result, costUsd, latencyMs }));
    const settled = await Promise.allSettled(writes);
    for (const r of settled) {
      if (r.status === 'rejected') console.warn('[council] audit write failed:', r.reason?.message?.slice(0, 160));
    }
    return { ...result, costUsd, latencyMs };
  };

  // 1. Hard kill (env) → DB kill switch (uncached, fail-closed)
  const config = supabase ? await getCouncilConfig(supabase) : null;
  if (!shouldRunCouncil({ config })) return finish(baseResult(runId, { disabled: true, reason: 'disabled' }));

  // 2. Rate limit + daily budget
  if (userId && rateLimited(userId, sessionId)) return finish(baseResult(runId, { reason: 'rate_limited' }));
  if (userId) {
    let within = true;
    try { within = await checkDailyBudget(userId, tier); } catch { within = true; }
    if (!within) return finish(baseResult(runId, { reason: 'budget_cap' }));
  }

  // 3. Redact everything before it leaves the gateway
  let redactions = 0;
  const q = redactSensitive(opts.question); redactions += q.count;
  const ctx = redactSensitive(opts.context || ''); redactions += ctx.count;
  const prior = redactSensitive(opts.priorAnswer || ''); redactions += prior.count;

  // 4. Advisor selection (distinct providers, without Sophie's provider, health-filtered)
  const healthMap = supabase ? await loadHealthMap(supabase) : new Map();
  const selection = selectAdvisors({ isEco, healthMap, excludeProvider, config });
  if (selection.degraded) return finish(baseResult(runId, { reason: selection.reason, redactions }));

  const budget = timeBudget({ mode });
  const advisorMessages = buildAdvisorPrompt({ question: q.text, context: ctx.text, priorAnswer: prior.text });

  // 5. Advisors in parallel — each output crosses a provider boundary → sanitize + redact
  const settled = await Promise.allSettled(selection.advisors.map(async ({ provider, model }) => {
    const t0 = Date.now();
    const adapter = getAdapter(provider);
    const resp = await withTimeout(adapter.complete({ messages: advisorMessages, model, maxTokens: ADVISOR_MAX_TOKENS, temperature: 0.5 }), budget.advisorMs);
    costs.push({ provider, model, usage: resp.usage, latencyMs: Date.now() - t0, role: 'advisor' });
    const prepared = prepareForNextProvider(resp.content || '');
    redactions += prepared.redactions;
    return { provider, model, text: prepared.text, latencyMs: Date.now() - t0 };
  }));

  const advisorsMeta = selection.advisors.map((a, i) => {
    const s = settled[i];
    const ok = s.status === 'fulfilled' && !!s.value.text;
    if (!ok) console.warn(`[council] advisor ${a.provider}/${a.model} failed:`, s.reason?.message?.slice(0, 120) || 'empty answer');
    return {
      provider: a.provider, model: a.model, ok,
      latencyMs: s.status === 'fulfilled' ? s.value.latencyMs : budget.advisorMs,
      error: ok ? null : (s.reason?.message?.slice(0, 80) || 'empty'),
    };
  });
  const answers = settled.filter(s => s.status === 'fulfilled' && s.value.text).map(s => s.value);
  if (new Set(answers.map(a => a.provider)).size < MIN_DISTINCT_PROVIDERS) {
    return finish(baseResult(runId, { reason: 'advisors_failed', advisors: advisorsMeta, redactions }));
  }
  const evidence = answers.map(a => ({ provider: a.provider, excerpt: a.text.slice(0, BRIEFING_LIMITS.evidenceExcerpt) }));

  // 6. Reviewer chain (fixed in code)
  const chain = orderReviewerChain(pickReviewerChain({ mode, isEco }), healthMap, excludeProvider);
  const callChain = async (messages, role, temperature, timeoutMs, json = false) => {
    for (const { provider, model } of chain) {
      const t0 = Date.now();
      try {
        const resp = await withTimeout(getAdapter(provider).complete({ messages, model, maxTokens: REVIEWER_MAX_TOKENS, temperature, json }), timeoutMs);
        costs.push({ provider, model, usage: resp.usage, latencyMs: Date.now() - t0, role });
        if (resp.content) return resp.content;
      } catch (e) {
        console.warn(`[council] ${role} ${provider}/${model} failed:`, e?.message?.slice(0, 120));
      }
    }
    return null;
  };

  let review = null;
  if (mode === 'deep') {
    const raw = await callChain(buildReviewPrompt({ question: q.text, answers }), 'review', 0.3, budget.reviewMs);
    if (raw) { const p = prepareForNextProvider(raw); redactions += p.redactions; review = p.text; }
  }

  // 7. Synthesis → whole-response JSON → strict schema (fail-closed)
  // json: true — the briefing must arrive as a bare JSON object; parseBriefing
  // rejects anything else rather than digging JSON out of prose.
  const synthesisRaw = await callChain(buildSynthesisPrompt({ question: q.text, answers, review }), 'synthesis', 0.3, budget.synthesisMs, true);
  if (!synthesisRaw) return finish(baseResult(runId, { reason: 'reviewer_chain_failed', advisors: advisorsMeta, evidence, redactions }));

  const parsed = parseBriefing(sanitizeAdvisorOutput(synthesisRaw));
  if (!parsed.ok) {
    return finish(baseResult(runId, { reason: `invalid_briefing:${parsed.reason}`, invalidBriefing: true, advisors: advisorsMeta, evidence, redactions }));
  }

  // Briefing text crosses the boundary back to Sophie → redact once more
  const b = parsed.briefing;
  const red = (s) => { const r = redactSensitive(s); redactions += r.count; return r.text; };
  const briefing = {
    recommendation: red(b.recommendation),
    consensus: b.consensus.map(red),
    dissent: b.dissent.map(d => ({ position: red(d.position), reason: red(d.reason), severity: d.severity })),
    uncertainty: b.uncertainty.map(red),
    criticalAssumptions: b.criticalAssumptions.map(red),
    agreement: b.agreement,
    assessmentConfidence: b.assessmentConfidence,
    spokenSummary: red(b.spokenSummary),
  };

  return finish({
    ...briefing,
    evidence, advisors: advisorsMeta,
    degraded: false, disabled: false, invalidBriefing: false,
    redactions, reason: null, runId,
  });
}

// Formats a briefing as the untrusted data block Sophie receives.
export function formatCouncilData(result) {
  const payload = {
    recommendation: result.recommendation,
    consensus: result.consensus,
    dissent: result.dissent,
    uncertainty: result.uncertainty,
    criticalAssumptions: result.criticalAssumptions,
    agreement: result.agreement,
    advisors: result.advisors.filter(a => a.ok).map(a => a.provider),
  };
  return `<COUNCIL_DATA>\n${JSON.stringify(payload, null, 1)}\n</COUNCIL_DATA>`;
}

export function agreementLabel(result, lang = 'de') {
  const n = (result?.advisors || []).filter(a => a.ok).length;
  const de = { high: 'weitgehender Konsens', medium: 'geteilte Meinung', low: 'kein Konsens' };
  const en = { high: 'broad consensus', medium: 'mixed views', low: 'no consensus' };
  const map = lang === 'en' ? en : de;
  const word = map[result?.agreement] || (lang === 'en' ? 'no briefing' : 'kein Briefing');
  return lang === 'en' ? `${n} advisors – ${word}` : `${n} Berater – ${word}`;
}
