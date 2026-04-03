// api/ai/challenge.js — Challenge Mode: all AIs improve on existing answer
// Receives: messages (conversation history) + priorAnswer (last Sophie response)
// Round 1: All providers get full context + prior answer, asked to improve/correct
// Round 2: Claude reviews all answers critically
// Round 3: Synthesis — best parts combined into optimal answer
// WARNING: 3x cost of normal request (multiple rounds)
import { createClient } from '@supabase/supabase-js';
import { getAdapter } from '../../lib/ai/adapters/index.js';
import { trackCost } from '../../lib/ai/cost-tracker.js';
import { normalizeResponse } from '../../lib/ai/persona-normalizer.js';
import { TOKEN_COSTS } from '../../lib/billing-constants.js';
import { buildServerSystemPrompt } from '../../lib/server-prompt.js';

const CHALLENGE_PROVIDERS = [
  { provider: 'openai', model: 'gpt-4o-mini' },
  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { provider: 'google', model: 'gemini-2.5-flash' },
  { provider: 'mistral', model: 'mistral-small-latest' },
];

const ECO_CHALLENGE_PROVIDERS = [
  { provider: 'google', model: 'gemini-2.5-flash-lite' },
  { provider: 'openai', model: 'gpt-4o-mini' },
];

const PER_PROVIDER_TIMEOUT = 8000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Missing Supabase env vars' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body && typeof body === 'object' ? body : {};

  const { messages, priorAnswer, userId, session_id } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Missing messages array' });
  }

  const allCosts = [];
  const startTotal = Date.now();

  // Check eco mode + rebuild system prompt server-side
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  let isEco = false;
  let serverSystemPrompt = "";
  if (userId) {
    try {
      const { data: prof } = await supabase.from('user_profile').select('eco_mode').eq('user_id', userId).maybeSingle();
      isEco = !!prof?.eco_mode;
    } catch (_) {}

    // SECURITY: rebuild system prompt server-side instead of trusting client messages
    if (session_id) {
      try {
        const { data: session } = await supabase.from('chat_sessions')
          .select('session_mode, language, brainstorm_config, user_id')
          .eq('id', session_id).maybeSingle();
        if (session) {
          const { data: { user } } = await supabase.auth.admin.getUserById(session.user_id || userId);
          const { fullSystemPrompt } = await buildServerSystemPrompt({
            supabase, user: user || { id: userId },
            sessionMode: session.session_mode || null,
            brainstormConfig: session.brainstorm_config || null,
            language: session.language || 'en',
            conversationPolicy: null,
          });
          serverSystemPrompt = fullSystemPrompt;
        }
      } catch (e) { console.warn('[challenge] server prompt rebuild failed:', e?.message); }
    }
  }
  const providers = isEco ? ECO_CHALLENGE_PROVIDERS : CHALLENGE_PROVIDERS;

  // Replace client system prompt with server-built one
  const filteredMessages = messages.filter(m => m.role !== 'system');
  const baseMessages = [
    ...(serverSystemPrompt ? [{ role: 'system', content: serverSystemPrompt }] : []),
    ...filteredMessages,
  ];

  // Build context-aware prompt for Round 1
  // Each provider gets the full conversation + the prior answer to improve upon
  const contextBlock = priorAnswer
    ? `\n\nBEREITS GEGEBENE ANTWORT (von einem anderen Modell):\n${priorAnswer}\n\nDeine Aufgabe: Prüfe diese Antwort. Wenn sie korrekt und vollständig ist, bestätige und ergänze. Wenn sie Fehler enthält oder etwas fehlt, korrigiere und verbessere. Nutze ALLE dir verfügbaren Informationen aus dem Gesprächsverlauf.`
    : '';

  // ── ROUND 1: All providers answer with full context ──
  const round1Results = await Promise.allSettled(
    providers.map(async ({ provider, model }) => {
      const adapter = getAdapter(provider);
      const challengeMessages = [
        ...baseMessages,
        ...(contextBlock ? [{ role: 'user', content: contextBlock }] : []),
      ];
      try {
        const response = await Promise.race([
          adapter.complete({ messages: challengeMessages, model, maxTokens: 1024, temperature: 0.5 }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), PER_PROVIDER_TIMEOUT)),
        ]);
        allCosts.push({ provider, model, usage: response.usage, reason: 'challenge-round1' });
        return { provider, model, content: response.content, latencyMs: response.latencyMs };
      } catch (err) {
        return { provider, model, content: null, error: err?.message, latencyMs: 0 };
      }
    })
  );

  const round1 = round1Results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value)
    .filter(r => r.content);

  if (round1.length < 2) {
    return res.status(502).json({ error: 'Not enough providers responded for challenge' });
  }

  // ── ROUND 2: Critical review of all answers ──
  const answersBlock = round1
    .map(r => `[${r.provider.toUpperCase()}]:\n${r.content}`)
    .join('\n\n---\n\n');

  const priorBlock = priorAnswer
    ? `\nURSPRÜNGLICHE ANTWORT (die verbessert werden soll):\n${priorAnswer}\n`
    : '';

  const reviewPrompt = `Du bist ein kritischer Reviewer. ${priorBlock}
Hier sind ${round1.length} unabhängige Verbesserungsvorschläge/Antworten auf dieselbe Frage.

Prüfe kritisch:
- Welche Antwort nutzt die verfügbaren Daten am besten?
- Was ist korrekt, was ist falsch oder erfunden?
- Welche Informationen aus dem Gesprächsverlauf wurden korrekt verwendet?
- Welche Antwort ist die beste und warum?

Sei konkret und direkt. Antworte auf Deutsch.

DIE ANTWORTEN:

${answersBlock}`;

  const reviewProvider = isEco ? 'openai' : 'anthropic';
  const reviewModel = isEco ? 'gpt-4o-mini' : 'claude-sonnet-4-6';
  const reviewer = getAdapter(reviewProvider);
  let review;
  try {
    review = await Promise.race([
      reviewer.complete({ messages: [{ role: 'user', content: reviewPrompt }], model: reviewModel, maxTokens: 1024, temperature: 0.3 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), PER_PROVIDER_TIMEOUT)),
    ]);
    allCosts.push({ provider: reviewProvider, model: reviewModel, usage: review.usage, reason: 'challenge-round2-review' });
  } catch {
    const fallbackReviewer = getAdapter('openai');
    review = await fallbackReviewer.complete({
      messages: [{ role: 'user', content: reviewPrompt }], model: 'gpt-4o-mini', maxTokens: 1024, temperature: 0.3,
    });
    allCosts.push({ provider: 'openai', model: 'gpt-4o-mini', usage: review.usage, reason: 'challenge-round2-review' });
  }

  // ── ROUND 3: Synthesis — combine best parts ──
  const synthesisPrompt = `Du bist Sophie — warm, intelligent, natürlich.
Kombiniere die besten Teile aller Antworten zu EINER optimalen Antwort.
Berücksichtige die Kritik des Reviews. Behalte Sophie's Ton.
Nutze ALLE verfügbaren Informationen — wenn Nutzerdaten bekannt sind, verwende sie.
${priorBlock}
VERBESSERUNGSVORSCHLÄGE DER KIs:
${answersBlock}

KRITISCHES REVIEW:
${review.content}

Erstelle jetzt die bestmögliche Antwort. Antworte direkt, ohne Meta-Kommentare.`;

  let synthesis;
  try {
    synthesis = await Promise.race([
      reviewer.complete({ messages: [{ role: 'user', content: synthesisPrompt }], model: reviewModel, maxTokens: 1024, temperature: 0.7 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), PER_PROVIDER_TIMEOUT)),
    ]);
    allCosts.push({ provider: reviewProvider, model: reviewModel, usage: synthesis.usage, reason: 'challenge-round3-synthesis' });
  } catch {
    const fallback = getAdapter('openai');
    synthesis = await fallback.complete({
      messages: [{ role: 'user', content: synthesisPrompt }], model: 'gpt-4o-mini', maxTokens: 1024, temperature: 0.7,
    });
    allCosts.push({ provider: 'openai', model: 'gpt-4o-mini', usage: synthesis.usage, reason: 'challenge-round3-synthesis' });
  }

  const finalContent = normalizeResponse(synthesis.content, 'anthropic');

  const totalCost = allCosts.reduce((sum, c) => sum + (c.usage?.costUsd || 0), 0);
  const totalLatency = Date.now() - startTotal;

  // Track all costs (fire-and-forget)
  if (userId) {
    for (const c of allCosts) {
      trackCost({
        userId, provider: c.provider, model: c.model,
        inputTokens: c.usage?.inputTokens || 0, outputTokens: c.usage?.outputTokens || 0,
        costUsd: c.usage?.costUsd || 0, latencyMs: 0, routingReason: c.reason,
      }).catch(() => {});
    }

    // Deduct challenge tokens (waterfall: free → paid → topup)
    try {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      let usage = (await supabase
        .from('user_usage')
        .select('free_tokens_total, free_tokens_used, paid_tokens_total, paid_tokens_used, topup_tokens_balance')
        .eq('user_id', userId).maybeSingle()).data;
      if (!usage) {
        const { data: created } = await supabase.from('user_usage').upsert({
          user_id: userId, free_tokens_total: 50, free_tokens_used: 0,
          paid_tokens_total: 0, paid_tokens_used: 0, topup_tokens_balance: 0,
        }, { onConflict: 'user_id' }).select('free_tokens_total, free_tokens_used, paid_tokens_total, paid_tokens_used, topup_tokens_balance').single();
        if (created) usage = created;
      }
      if (usage) {
        const freeRem = Math.max(0, (usage.free_tokens_total || 0) - (usage.free_tokens_used || 0));
        const paidRem = Math.max(0, (usage.paid_tokens_total || 0) - (usage.paid_tokens_used || 0));
        const topupRem = Math.max(0, usage.topup_tokens_balance || 0);
        let toDeduct = TOKEN_COSTS.challenge;
        const updates = { updated_at: new Date().toISOString() };
        if (toDeduct > 0 && freeRem > 0) { const f = Math.min(toDeduct, freeRem); updates.free_tokens_used = (usage.free_tokens_used || 0) + f; toDeduct -= f; }
        if (toDeduct > 0 && paidRem > 0) { const p = Math.min(toDeduct, paidRem); updates.paid_tokens_used = (usage.paid_tokens_used || 0) + p; toDeduct -= p; }
        if (toDeduct > 0 && topupRem > 0) { const t = Math.min(toDeduct, topupRem); updates.topup_tokens_balance = (usage.topup_tokens_balance || 0) - t; toDeduct -= t; }
        await supabase.from('user_usage').update(updates).eq('user_id', userId);
      }
    } catch (e) { console.error('[challenge] token deduction error:', e?.message); }
  }

  return res.status(200).json({
    finalAnswer: finalContent,
    review: review.content,
    round1: round1.map(r => ({ provider: r.provider, model: r.model, content: r.content, latencyMs: r.latencyMs })),
    providers: round1.map(r => r.provider),
    totalCost,
    totalLatencyMs: totalLatency,
    rounds: 3,
  });
}
