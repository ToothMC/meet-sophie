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

// Fixed in code, never admin-editable.
export const REVIEWER_CHAIN = [
  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { provider: 'openai',    model: 'gpt-4o' },
  { provider: 'google',    model: 'gemini-2.5-flash' },
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

export const TIMEOUTS = {
  advisorMs: 6000,
  reviewerMs: 6000,
  deepAdvisorMs: 8000,
  deepReviewerMs: 8000,
};

export const RATE_LIMITS = {
  perSession: 5,
  perDay: 30,
};

export const BRIEFING_LIMITS = {
  recommendation: 1200,
  listItems: 6,
  listItem: 300,
  spokenSummary: 280,
  evidenceExcerpt: 400,
};

export const CONFIG_CACHE_MS = 60_000;

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  advisors: ADVISORS,
  ecoAdvisors: ECO_ADVISORS,
});

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
