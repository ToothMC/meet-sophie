// api/ai/router.js — Multi-AI Router (POST handler)
// Classify → Route → Execute (with fallback) → Normalize → Track → Respond
import { createClient } from '@supabase/supabase-js';
import { classify, route } from '../../lib/ai/classifier.js';
import { getAdapter } from '../../lib/ai/adapters/index.js';
import { trackCost, checkDailyBudget } from '../../lib/ai/cost-tracker.js';
import { normalizeResponse } from '../../lib/ai/persona-normalizer.js';

const FALLBACK_TIMEOUT_MS = parseInt(process.env.AI_ROUTER_FALLBACK_TIMEOUT_MS || '3000', 10);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Missing Supabase env vars' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body && typeof body === 'object' ? body : {};

  const { messages, routingHints, userId } = body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Missing messages array' });
  }

  // 1. Classify
  const ctx = classify({ messages }, routingHints || {});

  // 2. Route
  const decision = route(ctx);

  // 3. Budget check — degrade if over cap
  if (userId) {
    const withinBudget = await checkDailyBudget(userId, ctx.userTier);
    if (!withinBudget) {
      decision.primary = { provider: 'google', model: 'gemini-2.0-flash-lite' };
      decision.fallback = null;
      decision.reason = 'budget-cap-degradation';
    }
  }

  // 4. Execute with timeout + fallback
  let response;
  const startMs = Date.now();

  try {
    const adapter = getAdapter(decision.primary.provider);
    response = await Promise.race([
      adapter.complete({ messages, model: decision.primary.model }),
      timeoutReject(FALLBACK_TIMEOUT_MS),
    ]);
  } catch (primaryErr) {
    // Try fallback
    if (decision.fallback) {
      try {
        const fallbackAdapter = getAdapter(decision.fallback.provider);
        response = await fallbackAdapter.complete({
          messages,
          model: decision.fallback.model,
        });
        decision.reason += '+fallback';
      } catch (fallbackErr) {
        return res.status(502).json({
          error: 'All AI providers failed',
          primary: primaryErr?.message?.slice(0, 200),
          fallback: fallbackErr?.message?.slice(0, 200),
        });
      }
    } else {
      return res.status(502).json({
        error: 'AI provider failed',
        detail: primaryErr?.message?.slice(0, 200),
      });
    }
  }

  // 5. Normalize response (strip provider-specific tics)
  response.content = normalizeResponse(response.content, response.provider);

  // 6. Track costs (fire-and-forget)
  if (userId) {
    trackCost({
      userId,
      provider: response.provider,
      model: response.model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costUsd: response.usage.costUsd,
      latencyMs: Date.now() - startMs,
      routingReason: decision.reason,
    }).catch(err => console.error('Cost tracking error:', err?.message));
  }

  // 7. Return response
  return res.status(200).json({
    content: response.content,
    model: response.model,
    provider: response.provider,
    usage: response.usage,
    latencyMs: Date.now() - startMs,
    routingReason: decision.reason,
  });
}

function timeoutReject(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
  );
}
