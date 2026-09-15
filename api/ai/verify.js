// api/ai/verify.js — post-hoc fact check for the voice channel.
// Sophie has already spoken; this reports back only what the web contradicts,
// so she can correct herself in her own words.
import { createClient } from '@supabase/supabase-js';
import { verifyAnswer, LIMITS } from '../../lib/ai/fact-check.js';
import { webSearch, groundedSearch } from './tools.js';
import { trackCost, checkDailyBudget } from '../../lib/ai/cost-tracker.js';
import { isSubscriptionActive } from '../../lib/billing-constants.js';

export const config = { maxDuration: 30 };

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 20;
const rateMap = new Map();

function isRateLimited(userId) {
  const now = Date.now();
  const entry = rateMap.get(userId);
  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    rateMap.set(userId, { start: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

// Web search first (fast, reliable); Gemini grounding only as a fallback.
async function search(query) {
  try {
    const r = await webSearch(query, { withSources: true });
    if (r?.text && !r.text.includes('Keine Ergebnisse')) return r;
  } catch (_) {}
  try {
    const g = await groundedSearch(query);
    if (g?.facts?.length) return { text: g.facts.join('\n'), sources: g.sources || [] };
  } catch (_) {}
  return { text: '', sources: [] };
}

function logAttempt(supabase, userId, sessionId, meta) {
  return supabase.from('analytics_events').insert({
    user_id: userId || null,
    session_id: typeof sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(sessionId) ? sessionId : null,
    event_name: 'fact_check',
    meta,
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'missing_env' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no_token' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'invalid_token' });
  if (isRateLimited(user.id)) {
    await logAttempt(supabase, user.id, null, { skipped: 'rate_limited' }).catch(() => {});
    return res.status(200).json({ corrections: [], skipped: 'rate_limited' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body && typeof body === 'object' ? body : {};

  const question = String(body.question || '').slice(0, LIMITS.question);
  const answer = String(body.answer || '').slice(0, LIMITS.answer);
  if (!answer.trim()) return res.status(400).json({ error: 'answer_required' });

  const { data: sub } = await supabase
    .from('user_subscriptions').select('plan, is_active, status, trial_end').eq('user_id', user.id).maybeSingle();
  const tier = isSubscriptionActive(sub) ? (sub?.plan === 'premium' ? 'premium' : 'abo') : 'free';
  try {
    if (!(await checkDailyBudget(user.id, tier))) {
      await logAttempt(supabase, user.id, body.session_id, { skipped: 'budget_cap' }).catch(() => {});
      return res.status(200).json({ corrections: [], skipped: 'budget_cap' });
    }
  } catch (_) {}

  const started = Date.now();
  const costs = [];
  let result;
  try {
    result = await verifyAnswer({ question, answer, search, onCost: e => costs.push(e) });
  } catch (e) {
    console.error('[verify] failed:', e?.message?.slice(0, 200));
    await logAttempt(supabase, user.id, body.session_id, { skipped: 'failed', error: e?.message?.slice(0, 160) }).catch(() => {});
    return res.status(200).json({ corrections: [], skipped: 'failed' });
  }

  const writes = costs.map(c => trackCost({
    userId: user.id, provider: c.provider, model: c.model,
    inputTokens: c.usage?.inputTokens || 0, outputTokens: c.usage?.outputTokens || 0,
    costUsd: c.usage?.costUsd || 0, latencyMs: 0, routingReason: `factcheck:${c.role}`,
  }));
  const costUsd = costs.reduce((s, c) => s + (c.usage?.costUsd || 0), 0);

  writes.push(logAttempt(supabase, user.id, body.session_id, {
    checked: result.checked, verdicts: result.verdicts,
    corrections: result.corrections.length,
    costUsd: Number(costUsd.toFixed(6)), latencyMs: Date.now() - started,
  }));
  await Promise.allSettled(writes);

  if (result.corrections.length) {
    console.log(`[verify] ${result.corrections.length} correction(s):`,
      result.corrections.map(c => `"${c.claim.slice(0, 80)}" → "${c.correction.slice(0, 120)}"`).join(' | '));
  }

  return res.status(200).json({ corrections: result.corrections, checked: result.checked });
}
