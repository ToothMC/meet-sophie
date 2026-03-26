// api/ai/challenge.js — Challenge Mode: all AIs improve on existing answer
// Receives: messages (conversation history) + priorAnswer (last Sophie response)
// Round 1: All providers get full context + prior answer, asked to improve/correct
// Round 2: Claude reviews all answers critically
// Round 3: Synthesis — best parts combined into optimal answer
// WARNING: 3x cost of normal request (multiple rounds)
import { getAdapter } from '../../lib/ai/adapters/index.js';
import { trackCost } from '../../lib/ai/cost-tracker.js';
import { normalizeResponse } from '../../lib/ai/persona-normalizer.js';

const CHALLENGE_PROVIDERS = [
  { provider: 'openai', model: 'gpt-4o-mini' },
  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { provider: 'google', model: 'gemini-2.5-flash' },
  { provider: 'mistral', model: 'mistral-small-latest' },
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

  const { messages, priorAnswer, userId } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Missing messages array' });
  }

  const allCosts = [];
  const startTotal = Date.now();

  // Build context-aware prompt for Round 1
  // Each provider gets the full conversation + the prior answer to improve upon
  const contextBlock = priorAnswer
    ? `\n\nBEREITS GEGEBENE ANTWORT (von einem anderen Modell):\n${priorAnswer}\n\nDeine Aufgabe: Prüfe diese Antwort. Wenn sie korrekt und vollständig ist, bestätige und ergänze. Wenn sie Fehler enthält oder etwas fehlt, korrigiere und verbessere. Nutze ALLE dir verfügbaren Informationen aus dem Gesprächsverlauf.`
    : '';

  // ── ROUND 1: All providers answer with full context ──
  const round1Results = await Promise.allSettled(
    CHALLENGE_PROVIDERS.map(async ({ provider, model }) => {
      const adapter = getAdapter(provider);
      const challengeMessages = [
        ...messages,
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

  const reviewer = getAdapter('anthropic');
  let review;
  try {
    review = await Promise.race([
      reviewer.complete({ messages: [{ role: 'user', content: reviewPrompt }], model: 'claude-sonnet-4-6', maxTokens: 1024, temperature: 0.3 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), PER_PROVIDER_TIMEOUT)),
    ]);
    allCosts.push({ provider: 'anthropic', model: 'claude-sonnet-4-6', usage: review.usage, reason: 'challenge-round2-review' });
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
      reviewer.complete({ messages: [{ role: 'user', content: synthesisPrompt }], model: 'claude-sonnet-4-6', maxTokens: 1024, temperature: 0.7 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), PER_PROVIDER_TIMEOUT)),
    ]);
    allCosts.push({ provider: 'anthropic', model: 'claude-sonnet-4-6', usage: synthesis.usage, reason: 'challenge-round3-synthesis' });
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
