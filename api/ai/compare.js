// api/ai/compare.js — Compare Mode: same question to all healthy providers in parallel
// Returns fastest answer + deviations from others
import { createClient } from '@supabase/supabase-js';
import { getAdapter } from '../../lib/ai/adapters/index.js';
import { trackCost } from '../../lib/ai/cost-tracker.js';
import { normalizeResponse } from '../../lib/ai/persona-normalizer.js';
import { TOKEN_COSTS } from '../../lib/billing-constants.js';

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

  const { messages, priorAnswer, userId } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Missing messages array' });
  }

  // Build context-aware messages: include prior answer so all providers see it
  const contextMessages = [...messages];
  if (priorAnswer) {
    contextMessages.push({
      role: 'user',
      content: `Eine andere KI hat folgende Antwort gegeben:\n\n${priorAnswer}\n\nBeantworte die gleiche Frage. Nutze ALLE verfügbaren Informationen aus dem Gesprächsverlauf. Wenn die vorherige Antwort korrekt ist, bestätige und ergänze. Wenn sie Fehler enthält, korrigiere.`,
    });
  }

  // Query all providers in parallel (8s timeout per provider)
  const PER_PROVIDER_TIMEOUT = 8000;
  const results = await Promise.allSettled(
    COMPARE_PROVIDERS.map(async ({ provider, model }) => {
      const start = Date.now();
      try {
        const adapter = getAdapter(provider);
        const response = await Promise.race([
          adapter.complete({ messages: contextMessages, model, maxTokens: 1024, temperature: 0.85 }),
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

    // Deduct compare tokens (waterfall: free → paid → topup)
    try {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      const { data: usage } = await supabase
        .from('user_usage')
        .select('free_tokens_total, free_tokens_used, paid_tokens_total, paid_tokens_used, topup_tokens_balance')
        .eq('user_id', userId).maybeSingle();
      if (usage) {
        const freeRem = Math.max(0, (usage.free_tokens_total || 0) - (usage.free_tokens_used || 0));
        const paidRem = Math.max(0, (usage.paid_tokens_total || 0) - (usage.paid_tokens_used || 0));
        const topupRem = Math.max(0, usage.topup_tokens_balance || 0);
        let toDeduct = TOKEN_COSTS.compare;
        const updates = { updated_at: new Date().toISOString() };
        if (toDeduct > 0 && freeRem > 0) { const f = Math.min(toDeduct, freeRem); updates.free_tokens_used = (usage.free_tokens_used || 0) + f; toDeduct -= f; }
        if (toDeduct > 0 && paidRem > 0) { const p = Math.min(toDeduct, paidRem); updates.paid_tokens_used = (usage.paid_tokens_used || 0) + p; toDeduct -= p; }
        if (toDeduct > 0 && topupRem > 0) { const t = Math.min(toDeduct, topupRem); updates.topup_tokens_balance = (usage.topup_tokens_balance || 0) - t; toDeduct -= t; }
        await supabase.from('user_usage').update(updates).eq('user_id', userId);
      }
    } catch (e) { console.error('[compare] token deduction error:', e?.message); }
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
