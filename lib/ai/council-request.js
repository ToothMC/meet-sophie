// lib/ai/council-request.js — shared plumbing for the button-triggered council
// endpoints (compare, challenge): auth, session lookup, tier, billing, persistence.
import { createClient } from '@supabase/supabase-js';
import { isSubscriptionActive, TOKEN_COSTS } from '../billing-constants.js';
import { deductTokens } from '../token-deduct.js';
import { getCouncilConfig, shouldRunCouncil } from './council-config.js';

export function readBody(req) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  return body && typeof body === 'object' ? body : {};
}

/**
 * Authenticates the caller, loads session + tier, and checks the council gate.
 * @returns {Promise<{ error?: { status: number, body: object }, supabase?, user?, session?, messages?, isEco?, tier?, sessionId? }>}
 */
export async function prepareCouncilRequest(req) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { error: { status: 500, body: { error: 'missing_env' } } };
  }
  const body = readBody(req);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return { error: { status: 400, body: { error: 'Missing messages array' } } };

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { error: { status: 401, body: { error: 'no_token' } } };

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return { error: { status: 401, body: { error: 'invalid_token' } } };

  if (!shouldRunCouncil({ config: await getCouncilConfig(supabase) })) {
    return { error: { status: 503, body: { error: 'council_disabled' } } };
  }

  const sessionId = typeof body.session_id === 'string' ? body.session_id : null;
  let session = null;
  let isCanonical = false;
  if (sessionId) {
    const { data: canonical } = await supabase
      .from('user_sessions').select('session_mode, language, brainstorm_config, user_id').eq('id', sessionId).maybeSingle();
    if (canonical) { session = canonical; isCanonical = true; }
    else {
      const { data: legacy } = await supabase
        .from('chat_sessions').select('session_mode, language, brainstorm_config, user_id').eq('id', sessionId).maybeSingle();
      session = legacy || null;
    }
    if (session && session.user_id && session.user_id !== user.id) {
      return { error: { status: 403, body: { error: 'session_forbidden' } } };
    }
  }

  const [{ data: profile }, { data: sub }] = await Promise.all([
    supabase.from('user_profile').select('eco_mode').eq('user_id', user.id).maybeSingle(),
    supabase.from('user_subscriptions').select('plan, is_active, status, trial_end').eq('user_id', user.id).maybeSingle(),
  ]);
  const active = isSubscriptionActive(sub);
  const tier = active ? (sub?.plan === 'premium' ? 'premium' : 'abo') : 'free';

  return {
    supabase, user, session, sessionId, isCanonical,
    messages: messages.filter(m => m && (m.role === 'user' || m.role === 'assistant')),
    priorAnswer: typeof body.priorAnswer === 'string' ? body.priorAnswer : null,
    isEco: !!profile?.eco_mode, tier,
  };
}

/** Deducts the fixed button cost and persists Sophie's verdict (never council raw text). */
export async function finishCouncilRequest({ supabase, user, sessionId, isCanonical, verdict, costKey }) {
  let remaining = null;
  try {
    const amount = TOKEN_COSTS[costKey] ?? 1;
    const result = await deductTokens(supabase, user.id, amount);
    remaining = result.remaining;
  } catch (e) {
    console.error(`[${costKey}] token deduction error:`, e?.message);
  }
  if (verdict && sessionId && isCanonical) {
    try {
      await supabase.rpc('insert_conversation_message', {
        p_session_id: sessionId, p_role: 'assistant', p_text: verdict, p_modality: 'text',
      });
    } catch (e) {
      console.warn(`[${costKey}] verdict persist failed:`, e?.message);
    }
  }
  return { remaining };
}

export function lastUserQuestion(messages) {
  const last = [...messages].reverse().find(m => m.role === 'user');
  return String(last?.content || '').slice(0, 2000).trim();
}
