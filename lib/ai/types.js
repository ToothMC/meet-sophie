// lib/ai/types.js — Shared types and pricing for Multi-AI Router
//
// AIRequest:  { messages, model?, maxTokens?, temperature?, stream? }
// AIResponse: { content, model, provider, usage: { inputTokens, outputTokens, costUsd }, latencyMs }
// AIAdapter:  { complete(req) → AIResponse, healthCheck() → { ok, latencyMs } }

/**
 * Pricing table: USD per 1M tokens
 * @type {Record<string, { input: number, output: number }>}
 */
export const PRICING = {
  'gpt-4o-mini':           { input: 0.15,  output: 0.60 },
  'gpt-4o':                { input: 2.50,  output: 10.00 },
  'claude-sonnet-4-6':     { input: 3.00,  output: 15.00 },
  'claude-opus-4-6':       { input: 15.00, output: 75.00 },
  'claude-haiku-4-5':      { input: 0.80,  output: 4.00 },
  'gemini-2.0-flash-lite': { input: 0.075, output: 0.30 },
  'gemini-2.0-flash':      { input: 0.10,  output: 0.40 },
  'gemini-2.5-flash-lite': { input: 0.075, output: 0.30 },
  'gemini-2.5-flash':      { input: 0.15,  output: 0.60 },
  'mistral-small-latest':  { input: 0.10,  output: 0.30 },
  'mistral-large-latest':  { input: 2.00,  output: 6.00 },
};

/**
 * Calculate cost in USD for a given model and token counts.
 * @param {string} model
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {number}
 */
export function calculateCost(model, inputTokens, outputTokens) {
  const p = PRICING[model];
  if (!p) return 0;
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

/**
 * Estimate cost for an OpenAI Realtime voice session based on duration.
 * OpenAI charges ~$0.06/min audio input + ~$0.24/min audio output.
 * Assuming ~50/50 user/Sophie split → ~$0.15/min effective + 10% buffer.
 * @param {number} durationSeconds
 * @returns {number} estimated cost in USD
 */
export function estimateRealtimeCost(durationSeconds) {
  const perMinute = parseFloat(process.env.REALTIME_COST_PER_MINUTE || '0.165');
  return (durationSeconds / 60) * perMinute;
}
