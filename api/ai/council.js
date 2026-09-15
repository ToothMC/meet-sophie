// api/ai/council.js — Voice endpoint for Sophie's consult_council tool.
// Returns advisory data only: a spoken summary plus the briefing. Sophie decides.
import { createClient } from '@supabase/supabase-js';
import { runCouncil } from '../../lib/ai/council.js';
import { isSubscriptionActive } from '../../lib/billing-constants.js';
import { LIMITS } from '../../lib/ai/council-config.js';

export const config = { maxDuration: 30 };

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

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body && typeof body === 'object' ? body : {};

  const question = String(body.question || '').trim();
  const context = String(body.context || '').trim();
  if (!question) return res.status(400).json({ error: 'question_required' });
  if (question.length > LIMITS.question) return res.status(400).json({ error: 'question_too_long' });
  if (context.length > LIMITS.question) return res.status(400).json({ error: 'context_too_long' });

  const sessionId = typeof body.session_id === 'string' ? body.session_id : null;
  const [{ data: profile }, { data: sub }] = await Promise.all([
    supabase.from('user_profile').select('eco_mode').eq('user_id', user.id).maybeSingle(),
    supabase.from('user_subscriptions').select('plan, is_active, status, trial_end').eq('user_id', user.id).maybeSingle(),
  ]);
  const tier = isSubscriptionActive(sub) ? (sub?.plan === 'premium' ? 'premium' : 'abo') : 'free';

  let result;
  try {
    result = await runCouncil({
      question,
      context,
      mode: 'quick',
      channel: 'voice',
      userId: user.id,
      sessionId,
      isEco: !!profile?.eco_mode,
      tier,
      excludeProvider: 'openai', // Sophie speaks through OpenAI Realtime
      supabase,
    });
  } catch (e) {
    console.error('[council/voice] failed:', e?.message?.slice(0, 200));
    return res.status(200).json({ disabled: false, degraded: true });
  }

  if (result.disabled) return res.status(200).json({ disabled: true, degraded: true });
  if (result.degraded || !result.recommendation) {
    return res.status(200).json({ disabled: false, degraded: true, reason: result.reason || null });
  }

  return res.status(200).json({
    disabled: false,
    degraded: false,
    spokenSummary: result.spokenSummary,
    briefing: {
      recommendation: result.recommendation,
      dissent: result.dissent,
      uncertainty: result.uncertainty,
      agreement: result.agreement,
    },
    advisors: result.advisors.filter(a => a.ok).map(a => a.provider),
  });
}
