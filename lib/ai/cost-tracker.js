// lib/ai/cost-tracker.js — Cost Tracking + Budget Enforcement
import { createClient } from '@supabase/supabase-js';

function getServiceClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

/**
 * Log a completed AI request and update daily cost aggregate.
 * @param {{ userId: string, provider: string, model: string,
 *           inputTokens: number, outputTokens: number, costUsd: number,
 *           latencyMs: number, routingReason: string }} entry
 */
export async function trackCost(entry) {
  const supabase = getServiceClient();

  // 1. Insert detailed request log
  await supabase.from('ai_request_log').insert({
    user_id: entry.userId,
    provider: entry.provider,
    model: entry.model,
    tokens_in: entry.inputTokens,
    tokens_out: entry.outputTokens,
    cost_usd: entry.costUsd,
    latency_ms: entry.latencyMs,
    routing_reason: entry.routingReason,
    created_at: new Date().toISOString(),
  });

  // 2. Upsert daily aggregate
  const today = new Date().toISOString().split('T')[0];
  const { data: existing } = await supabase
    .from('ai_cost_daily')
    .select('*')
    .eq('user_id', entry.userId)
    .eq('date', today)
    .maybeSingle();

  if (existing) {
    const breakdown = existing.per_provider || {};
    breakdown[entry.provider] = (breakdown[entry.provider] || 0) + entry.costUsd;

    await supabase.from('ai_cost_daily').update({
      total_cost: existing.total_cost + entry.costUsd,
      per_provider: breakdown,
      request_count: existing.request_count + 1,
    }).eq('id', existing.id);
  } else {
    await supabase.from('ai_cost_daily').insert({
      user_id: entry.userId,
      date: today,
      total_cost: entry.costUsd,
      per_provider: { [entry.provider]: entry.costUsd },
      request_count: 1,
    });
  }
}

/**
 * Check whether a user is still within their daily budget cap.
 * @param {string} userId
 * @param {'free' | 'abo' | 'premium'} tier
 * @returns {Promise<boolean>} true = within budget
 */
export async function checkDailyBudget(userId, tier) {
  // Daily caps tied to plan price: ~2× daily share of monthly revenue
  // Start €9.90/30×2=€0.66≈$0.70, Premium €39.90/30×2=€2.66≈$2.70
  const caps = {
    free: parseFloat(process.env.AI_COST_CAP_FREE || '0.25'),
    abo: parseFloat(process.env.AI_COST_CAP_ABO || '0.70'),
    premium: parseFloat(process.env.AI_COST_CAP_PREMIUM || '2.70'),
  };

  const today = new Date().toISOString().split('T')[0];
  const { data } = await getServiceClient()
    .from('ai_cost_daily')
    .select('total_cost')
    .eq('user_id', userId)
    .eq('date', today)
    .maybeSingle();

  return (data?.total_cost ?? 0) < (caps[tier] ?? caps.abo);
}
