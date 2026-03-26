// api/ai/challenge.js — Challenge Mode: all AIs discuss and agree on best answer
// Round 1: All providers answer independently
// Round 2: Each provider reviews all other answers and critiques
// Round 3: Synthesis — best parts combined into final answer
// WARNING: 3x cost of normal request (multiple rounds)
import { createClient } from '@supabase/supabase-js';
import { getAdapter } from '../../lib/ai/adapters/index.js';
import { trackCost } from '../../lib/ai/cost-tracker.js';
import { normalizeResponse } from '../../lib/ai/persona-normalizer.js';

const CHALLENGE_PROVIDERS = [
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

  const allCosts = [];
  const startTotal = Date.now();

  // ── ROUND 1: All providers answer independently ──
  const round1Results = await Promise.allSettled(
    CHALLENGE_PROVIDERS.map(async ({ provider, model }) => {
      const adapter = getAdapter(provider);
      const response = await adapter.complete({
        messages,
        model,
        maxTokens: 1024,
        temperature: 0.85,
      });
      allCosts.push({ provider, model, usage: response.usage, reason: 'challenge-round1' });
      return { provider, model, content: response.content, latencyMs: response.latencyMs };
    })
  );

  const round1 = round1Results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);

  if (round1.length < 2) {
    return res.status(502).json({ error: 'Not enough providers responded for challenge' });
  }

  // ── ROUND 2: Each provider reviews all others ──
  const answersBlock = round1
    .map(r => `[${r.provider.toUpperCase()}]:\n${r.content}`)
    .join('\n\n---\n\n');

  const reviewPrompt = `Du bist ein kritischer Reviewer. Hier sind ${round1.length} unabhängige Antworten auf dieselbe Frage.
Prüfe jede Antwort kritisch:
- Was ist gut?
- Was fehlt?
- Was ist falsch oder ungenau?
- Welche Antwort ist die beste und warum?

Sei konkret und direkt. Antworte auf Deutsch.

DIE ANTWORTEN:

${answersBlock}`;

  // Use Claude for review (best at critical analysis)
  const reviewer = getAdapter('anthropic');
  let review;
  try {
    review = await reviewer.complete({
      messages: [{ role: 'user', content: reviewPrompt }],
      model: 'claude-sonnet-4-6',
      maxTokens: 1024,
      temperature: 0.3,
    });
    allCosts.push({ provider: 'anthropic', model: 'claude-sonnet-4-6', usage: review.usage, reason: 'challenge-round2-review' });
  } catch {
    // Fallback: use OpenAI for review
    const fallbackReviewer = getAdapter('openai');
    review = await fallbackReviewer.complete({
      messages: [{ role: 'user', content: reviewPrompt }],
      model: 'gpt-4o-mini',
      maxTokens: 1024,
      temperature: 0.3,
    });
    allCosts.push({ provider: 'openai', model: 'gpt-4o-mini', usage: review.usage, reason: 'challenge-round2-review' });
  }

  // ── ROUND 3: Synthesis — combine best parts ──
  const synthesisPrompt = `Du bist Sophie — warm, intelligent, natürlich.
Kombiniere die besten Teile aller Antworten zu EINER optimalen Antwort.
Berücksichtige die Kritik des Reviews. Behalte Sophie's Ton.

ORIGINAL-ANTWORTEN:
${answersBlock}

KRITISCHES REVIEW:
${review.content}

Erstelle jetzt die bestmögliche Antwort. Antworte direkt, ohne Meta-Kommentare.`;

  let synthesis;
  try {
    synthesis = await reviewer.complete({
      messages: [{ role: 'user', content: synthesisPrompt }],
      model: 'claude-sonnet-4-6',
      maxTokens: 1024,
      temperature: 0.7,
    });
    allCosts.push({ provider: 'anthropic', model: 'claude-sonnet-4-6', usage: synthesis.usage, reason: 'challenge-round3-synthesis' });
  } catch {
    const fallback = getAdapter('openai');
    synthesis = await fallback.complete({
      messages: [{ role: 'user', content: synthesisPrompt }],
      model: 'gpt-4o-mini',
      maxTokens: 1024,
      temperature: 0.7,
    });
    allCosts.push({ provider: 'openai', model: 'gpt-4o-mini', usage: synthesis.usage, reason: 'challenge-round3-synthesis' });
  }

  const finalContent = normalizeResponse(synthesis.content, 'anthropic');

  // Total cost
  const totalCost = allCosts.reduce((sum, c) => sum + (c.usage?.costUsd || 0), 0);
  const totalLatency = Date.now() - startTotal;

  // Track all costs (fire-and-forget)
  if (userId) {
    for (const c of allCosts) {
      trackCost({
        userId,
        provider: c.provider,
        model: c.model,
        inputTokens: c.usage?.inputTokens || 0,
        outputTokens: c.usage?.outputTokens || 0,
        costUsd: c.usage?.costUsd || 0,
        latencyMs: 0,
        routingReason: c.reason,
      }).catch(() => {});
    }
  }

  return res.status(200).json({
    finalAnswer: finalContent,
    review: review.content,
    round1: round1.map(r => ({
      provider: r.provider,
      model: r.model,
      content: r.content,
      latencyMs: r.latencyMs,
    })),
    providers: round1.map(r => r.provider),
    totalCost,
    totalLatencyMs: totalLatency,
    rounds: 3,
  });
}
