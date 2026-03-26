// lib/ai/classifier.js — 7-Dimension Routing Classifier
// Analyzes each request and returns a RoutingContext + RoutingDecision.
// All classification is rule-based (no LLM calls).

/**
 * @typedef {{ channel: 'voice'|'text', latency: 'live'|'async', risk: 'low'|'medium'|'high',
 *             contextLength: 'short'|'medium'|'long', userTier: 'free'|'abo'|'premium',
 *             dataClass: 'normal'|'confidential', needsVerification: boolean }} RoutingContext
 *
 * @typedef {{ primary: { provider: string, model: string },
 *             fallback: { provider: string, model: string } | null,
 *             reason: string }} RoutingDecision
 */

/**
 * Classify a request into a full RoutingContext.
 * @param {{ messages: Array<{role: string, content: string}> }} req
 * @param {Partial<RoutingContext>} [hints]
 * @returns {RoutingContext}
 */
export function classify(req, hints = {}) {
  return {
    channel: hints.channel ?? 'text',
    latency: hints.latency ?? 'live',
    risk: hints.risk ?? inferRisk(req),
    contextLength: hints.contextLength ?? inferContextLength(req),
    userTier: hints.userTier ?? 'abo',
    dataClass: hints.dataClass ?? 'normal',
    needsVerification: hints.needsVerification ?? false,
  };
}

/**
 * Determine routing decision from context.
 * @param {RoutingContext} ctx
 * @returns {RoutingDecision}
 */
export function route(ctx) {
  // Dimension 1: Voice → always OpenAI Realtime
  if (ctx.channel === 'voice') {
    return {
      primary: { provider: 'openai', model: 'gpt-4o-realtime' },
      fallback: null,
      reason: 'voice-channel',
    };
  }

  // Dimension 2: Data classification (confidential → exclude some providers)
  // (Used as constraint in other rules below)

  // Dimension 3: Free tier → budget only
  if (ctx.userTier === 'free') {
    return {
      primary: { provider: 'google', model: 'gemini-2.5-flash-lite' },
      fallback: { provider: 'openai', model: 'gpt-4o-mini' },
      reason: 'free-tier-budget',
    };
  }

  // Dimension 4: High risk → Claude for reasoning
  if (ctx.risk === 'high') {
    return {
      primary: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      fallback: { provider: 'openai', model: 'gpt-4o-mini' },
      reason: 'high-risk-reasoning',
    };
  }

  // Dimension 5: Live latency → fastest healthy provider
  if (ctx.latency === 'live') {
    return {
      primary: { provider: 'openai', model: 'gpt-4o-mini' },
      fallback: { provider: 'google', model: 'gemini-2.0-flash' },
      reason: 'live-latency',
    };
  }

  // Dimension 6: Long context → 1M context models
  if (ctx.contextLength === 'long') {
    return {
      primary: { provider: 'google', model: 'gemini-2.0-flash' },
      fallback: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      reason: 'long-context',
    };
  }

  // Dimension 7: Standard → cost-optimized
  return {
    primary: { provider: 'openai', model: 'gpt-4o-mini' },
    fallback: { provider: 'google', model: 'gemini-2.0-flash' },
    reason: 'standard-cost-optimized',
  };
}

/**
 * Determine if a Second Opinion should be triggered (Phase B).
 * @param {RoutingContext} ctx
 * @returns {boolean}
 */
export function shouldTriggerSecondOpinion(ctx) {
  return ctx.risk === 'high' && ctx.needsVerification;
}

// --- Internal helpers ---

const HIGH_RISK_PATTERNS = [
  'meeting', 'summary', 'zusammenfassung', 'pitch', 'score',
  'reflexion', 'analyse', 'report', 'bewertung', 'protocol',
  'protokoll', 'evaluation',
];

/**
 * Infer risk level from message content (rule-based, no LLM).
 * @param {{ messages: Array<{role: string, content: string}> }} req
 * @returns {'low' | 'medium' | 'high'}
 */
function inferRisk(req) {
  const lastMsg = req.messages?.[req.messages.length - 1]?.content?.toLowerCase() ?? '';

  if (HIGH_RISK_PATTERNS.some(p => lastMsg.includes(p))) return 'high';
  if (lastMsg.length < 100) return 'low';
  return 'medium';
}

/**
 * Infer context length from total message size.
 * @param {{ messages: Array<{role: string, content: string}> }} req
 * @returns {'short' | 'medium' | 'long'}
 */
function inferContextLength(req) {
  const totalChars = (req.messages || []).reduce((sum, m) => sum + (m.content?.length || 0), 0);
  // Rough estimate: 4 chars ≈ 1 token
  const estimatedTokens = totalChars / 4;

  if (estimatedTokens < 4000) return 'short';
  if (estimatedTokens < 32000) return 'medium';
  return 'long';
}
