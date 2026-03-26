// lib/ai/adapters/index.js — Adapter Registry + Fallback Chains
import { OpenAIAdapter } from './openai.js';
import { AnthropicAdapter } from './anthropic.js';
import { BudgetAdapter } from './budget.js';

/** @type {Record<string, import('../types.js').AIAdapter>} */
const adapters = {};

/**
 * Get (or lazily create) an adapter for the given provider.
 * @param {string} provider - 'openai' | 'anthropic' | 'google' | 'mistral'
 */
export function getAdapter(provider) {
  if (!adapters[provider]) {
    switch (provider) {
      case 'openai':    adapters[provider] = new OpenAIAdapter(); break;
      case 'anthropic': adapters[provider] = new AnthropicAdapter(); break;
      case 'google':    adapters[provider] = new BudgetAdapter('google'); break;
      case 'mistral':   adapters[provider] = new BudgetAdapter('mistral'); break;
      default: throw new Error(`Unknown AI provider: ${provider}`);
    }
  }
  return adapters[provider];
}

/** Fallback chain per provider */
export const FALLBACK_CHAINS = {
  'openai':    ['google', 'anthropic'],
  'anthropic': ['openai', 'google'],
  'google':    ['openai', 'mistral'],
  'mistral':   ['google', 'openai'],
};

/**
 * Find the first healthy fallback for a given primary provider.
 * @param {string} primary
 * @param {Map<string, string>} healthCache - provider → 'healthy' | 'degraded' | 'down'
 * @returns {string | null}
 */
export function getHealthyFallback(primary, healthCache) {
  const chain = FALLBACK_CHAINS[primary] || [];
  return chain.find(p => healthCache.get(p) !== 'down') ?? null;
}
