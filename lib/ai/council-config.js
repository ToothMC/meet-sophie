// lib/ai/council-config.js — single source of truth for the Council Gateway.
// Advisor sets, reviewer chains, limits and the runtime config reader.

export const KNOWN_PROVIDERS = ['openai', 'anthropic', 'google', 'mistral'];

export const ADVISORS = [
  { provider: 'openai',    model: 'gpt-4o-mini' },
  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { provider: 'google',    model: 'gemini-2.5-flash' },
  { provider: 'mistral',   model: 'mistral-small-latest' },
];

// Three providers so that ≥ 2 distinct providers remain after excluding Sophie's own.
export const ECO_ADVISORS = [
  { provider: 'google',  model: 'gemini-2.5-flash-lite' },
  { provider: 'openai',  model: 'gpt-4o-mini' },
  { provider: 'mistral', model: 'mistral-small-latest' },
];

// Reviewer chains are fixed in code, never admin-editable.
// Deep mode buys thoroughness with latency; quick mode runs inside a live
// conversation, so it uses fast models that can produce the JSON briefing
// well within the synthesis timeout.
export const REVIEWER_CHAIN = [
  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { provider: 'openai',    model: 'gpt-4o' },
  { provider: 'google',    model: 'gemini-2.5-flash' },
];

// Ordered by how reliably the provider returns a bare JSON object: Google and
// OpenAI have a native JSON mode, Anthropic only an assistant prefill.
export const QUICK_REVIEWER_CHAIN = [
  { provider: 'google',    model: 'gemini-2.5-flash' },
  { provider: 'openai',    model: 'gpt-4o-mini' },
  { provider: 'anthropic', model: 'claude-haiku-4-5' },
];

export const ECO_REVIEWER_CHAIN = [
  { provider: 'openai',  model: 'gpt-4o-mini' },
  { provider: 'google',  model: 'gemini-2.5-flash-lite' },
  { provider: 'mistral', model: 'mistral-small-latest' },
];

export const MAX_COUNCIL_DEPTH = 1;
export const MIN_DISTINCT_PROVIDERS = 2;

export const LIMITS = {
  question: 2000,
  context: 12000,
  priorAnswer: 4000,
  tagArg: 300,
  contextTurns: 6,
};

// Budgets are sized from what each phase actually has to generate, then checked
// against the endpoint ceilings (voice 30s, chat 45s, challenge 60s):
//   voice  12 + 10            = 22s
//   chat   5 + 12 + 10 + 12   = 39s
//   deep   12 + 12 + 15 + 12  = 51s
// Advisors write reasoned prose and need the most room; synthesis runs on fast
// models and only reshapes their answers into JSON.
export const TIMEOUTS = {
  advisorMs: 12000,
  synthesisMs: 10000,
  deepAdvisorMs: 12000,
  deepReviewMs: 10000,
  deepSynthesisMs: 12000,
  // Hard ceiling for the whole run. The reviewer chain retries across providers,
  // so a per-attempt timeout alone multiplies: three providers at 10s each meant
  // the synthesis phase could eat 30s on its own and the serverless function was
  // killed mid-run — no answer, no audit entry. Every call is additionally
  // clamped to the time left before this deadline.
  // Checked against every caller's maxDuration:
  //   voice  /api/ai/council (45s): 26 + overhead
  //   chat   /api/chat       (45s): 5 primary + 26 + 12 formulation = 43
  //   deep   /api/ai/challenge (60s): 40 + 12 verdict = 52
  totalQuickMs: 26000,
  totalDeepMs: 40000,
};

// Advisor answers are condensed into the briefing and clipped to 400 chars of
// evidence — long completions only cost latency.
export const ADVISOR_MAX_TOKENS = 500;
// Must cover the largest briefing the schema allows, or the JSON arrives
// truncated mid-string and fails to parse. The synthesis prompt additionally
// asks for short entries so real output stays far below this ceiling.
export const REVIEWER_MAX_TOKENS = 3000;

export const RATE_LIMITS = {
  perSession: 5,
  perDay: 30,
};

export const BRIEFING_LIMITS = {
  recommendation: 1200,
  listItems: 4,
  listItem: 200,
  spokenSummary: 280,
  evidenceExcerpt: 400,
};

/** Worst-case briefing size the schema permits, in characters. */
export function maxBriefingChars(l = BRIEFING_LIMITS) {
  return l.recommendation + 3 * l.listItems * l.listItem + l.listItems * 2 * l.listItem + l.spokenSummary;
}

export const CONFIG_CACHE_MS = 60_000;

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  advisors: ADVISORS,
  ecoAdvisors: ECO_ADVISORS,
});

/** Reviewer chain for a run. Never admin-editable. */
export function pickReviewerChain({ mode = 'quick', isEco = false } = {}) {
  if (isEco) return ECO_REVIEWER_CHAIN;
  return mode === 'deep' ? REVIEWER_CHAIN : QUICK_REVIEWER_CHAIN;
}

/** Per-phase time budget for a run. */
export function timeBudget({ mode = 'quick' } = {}) {
  return mode === 'deep'
    ? { advisorMs: TIMEOUTS.deepAdvisorMs, reviewMs: TIMEOUTS.deepReviewMs, synthesisMs: TIMEOUTS.deepSynthesisMs, totalMs: TIMEOUTS.totalDeepMs }
    : { advisorMs: TIMEOUTS.advisorMs, reviewMs: TIMEOUTS.synthesisMs, synthesisMs: TIMEOUTS.synthesisMs, totalMs: TIMEOUTS.totalQuickMs };
}

/** Time left before the run's hard deadline, clamped to the per-attempt budget. */
export function remainingBudget(startedAt, totalMs, perAttemptMs, now = Date.now()) {
  return Math.min(perAttemptMs, Math.max(0, startedAt + totalMs - now));
}

export function shouldRunCouncil({ env = process.env, config } = {}) {
  if (String(env?.COUNCIL_HARD_DISABLED || '').toLowerCase() === 'true') return false;
  return config?.enabled === true;
}

function normalizeList(raw, allowed) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const match = allowed.find(a => a.provider === item.provider && a.model === item.model);
    if (!match) continue;
    const key = `${match.provider}/${match.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(match);
  }
  return out;
}

function distinctProviders(list) {
  return new Set(list.map(a => a.provider)).size;
}

export function resolveCouncilConfig(raw, defaults = DEFAULT_CONFIG) {
  const result = {
    enabled: raw?.enabled === true,
    advisors: defaults.advisors,
    ecoAdvisors: defaults.ecoAdvisors,
    invalid: false,
  };
  if (!raw || typeof raw !== 'object') {
    return { ...result, enabled: false, invalid: true };
  }
  const advisors = normalizeList(raw.advisors, ADVISORS);
  const ecoAdvisors = normalizeList(raw.eco_advisors ?? raw.ecoAdvisors, ECO_ADVISORS);
  if (distinctProviders(advisors) >= MIN_DISTINCT_PROVIDERS) result.advisors = advisors; else result.invalid = true;
  if (distinctProviders(ecoAdvisors) >= MIN_DISTINCT_PROVIDERS) result.ecoAdvisors = ecoAdvisors; else result.invalid = true;
  return result;
}

let cache = { at: 0, config: null };

// `enabled` is always read fresh unless allowCache is set (UX-only callers).
// Any read error fails closed: enabled=false, default advisor lists.
export async function getCouncilConfig(supabase, { allowCache = false } = {}) {
  if (allowCache && cache.config && Date.now() - cache.at < CONFIG_CACHE_MS) return cache.config;
  try {
    const { data, error } = await supabase
      .from('ai_council_config')
      .select('enabled, advisors, eco_advisors')
      .eq('id', 'global')
      .maybeSingle();
    if (error || !data) {
      const closed = { ...DEFAULT_CONFIG, enabled: false, invalid: true, error: error?.message || 'missing' };
      return closed;
    }
    const resolved = resolveCouncilConfig(data);
    cache = { at: Date.now(), config: resolved };
    return resolved;
  } catch (e) {
    return { ...DEFAULT_CONFIG, enabled: false, invalid: true, error: e?.message || 'read_failed' };
  }
}

export function _resetCouncilConfigCache() { cache = { at: 0, config: null }; }
