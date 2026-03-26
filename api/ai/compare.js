// api/ai/compare.js — Compare Mode: same question to all healthy providers in parallel
// Returns fastest answer + deviations from others
import { createClient } from '@supabase/supabase-js';
import { getAdapter } from '../../lib/ai/adapters/index.js';
import { trackCost } from '../../lib/ai/cost-tracker.js';
import { normalizeResponse } from '../../lib/ai/persona-normalizer.js';

const COMPARE_PROVIDERS = [
  { provider: 'openai', model: 'gpt-4o-mini' },
  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { provider: 'google', model: 'gemini-2.5-flash' },
  { provider: 'mistral', model: 'mistral-small-latest' },
];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Missing Supabase env vars' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body && typeof body === 'object' ? body : {};

  const { messages, userId } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Missing messages array' });
  }

  // Query all providers in parallel (8s timeout per provider)
  const PER_PROVIDER_TIMEOUT = 8000;
  const results = await Promise.allSettled(
    COMPARE_PROVIDERS.map(async ({ provider, model }) => {
      const start = Date.now();
      try {
        const adapter = getAdapter(provider);
        const response = await Promise.race([
          adapter.complete({ messages, model, maxTokens: 1024, temperature: 0.85 }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), PER_PROVIDER_TIMEOUT)),
        ]);
        response.content = normalizeResponse(response.content, provider);
        response.latencyMs = Date.now() - start;
        return response;
      } catch (err) {
        return {
          provider,
          model,
          content: null,
          error: err?.message?.slice(0, 200),
          latencyMs: Date.now() - start,
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        };
      }
    })
  );

  // Collect successful responses
  const responses = results
    .map(r => r.status === 'fulfilled' ? r.value : r.reason)
    .filter(r => r.content);

  if (responses.length === 0) {
    return res.status(502).json({ error: 'All providers failed' });
  }

  // Find fastest response
  const fastest = responses.reduce((a, b) => a.latencyMs < b.latencyMs ? a : b);

  // Calculate total cost
  const totalCost = responses.reduce((sum, r) => sum + (r.usage?.costUsd || 0), 0);

  // Track costs (fire-and-forget)
  if (userId) {
    for (const r of responses) {
      trackCost({
        userId,
        provider: r.provider,
        model: r.model,
        inputTokens: r.usage?.inputTokens || 0,
        outputTokens: r.usage?.outputTokens || 0,
        costUsd: r.usage?.costUsd || 0,
        latencyMs: r.latencyMs,
        routingReason: 'compare-mode',
      }).catch(() => {});
    }
  }

  return res.status(200).json({
    fastest: {
      provider: fastest.provider,
      model: fastest.model,
      content: fastest.content,
      latencyMs: fastest.latencyMs,
      costUsd: fastest.usage?.costUsd || 0,
    },
    others: responses
      .filter(r => r.provider !== fastest.provider)
      .map(r => ({
        provider: r.provider,
        model: r.model,
        content: r.content,
        latencyMs: r.latencyMs,
        costUsd: r.usage?.costUsd || 0,
      })),
    totalCost,
    providerCount: responses.length,
  });
}
