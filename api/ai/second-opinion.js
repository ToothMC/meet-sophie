// api/ai/second-opinion.js — Second Opinion Engine (Phase B)
// Multi-provider parallel query + confidence scoring + synthesis for high-risk outputs
import { getAdapter } from '../../lib/ai/adapters/index.js';
import { trackCost } from '../../lib/ai/cost-tracker.js';
import { normalizeResponse } from '../../lib/ai/persona-normalizer.js';

const ALL_PROVIDERS = [
  { provider: 'openai', model: 'gpt-4o-mini' },
  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { provider: 'google', model: 'gemini-2.5-flash' },
  { provider: 'mistral', model: 'mistral-small-latest' },
];

const PER_PROVIDER_TIMEOUT = 8000;

/**
 * Get second opinions from all 3 remaining providers (excluding primary),
 * calculate confidence scoring, and synthesize if agreement is low.
 * @param {Array<{role: string, content: string}>} messages
 * @param {{ content: string, provider: string, model: string }} primaryResponse
 * @param {{ userId?: string }} [opts]
 * @returns {Promise<{ result: string, confidence: number, agreementLevel: string, synthesized: boolean, providers: string[] }>}
 */
export async function getSecondOpinion(messages, primaryResponse, opts = {}) {
  // Pick all providers except the primary
  const secondaryProviders = ALL_PROVIDERS.filter(p => p.provider !== primaryResponse.provider);

  // Query all secondary providers in parallel
  const secondaryResults = await Promise.allSettled(
    secondaryProviders.map(async ({ provider, model }) => {
      const adapter = getAdapter(provider);
      const start = Date.now();
      try {
        const response = await Promise.race([
          adapter.complete({
            messages: [
              ...messages,
              {
                role: 'system',
                content: `Du bekommst eine vorherige Antwort auf diese Frage. ` +
                  `Prüfe sie kritisch. Ergänze fehlende Punkte. Korrigiere Fehler. ` +
                  `Wenn die Antwort gut ist, bestätige das kurz.\n\n` +
                  `VORHERIGE ANTWORT:\n${primaryResponse.content}`,
              },
            ],
            model,
            maxTokens: 1024,
            temperature: 0.5,
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), PER_PROVIDER_TIMEOUT)),
        ]);
        response.content = normalizeResponse(response.content, provider);
        response.latencyMs = Date.now() - start;
        return response;
      } catch (err) {
        return {
          provider, model, content: null,
          error: err?.message?.slice(0, 200),
          latencyMs: Date.now() - start,
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        };
      }
    })
  );

  // Collect successful responses
  const secondaries = secondaryResults
    .map(r => r.status === 'fulfilled' ? r.value : r.reason)
    .filter(r => r.content);

  if (secondaries.length === 0) {
    // All secondaries failed — return primary as-is
    return {
      result: primaryResponse.content,
      confidence: 1,
      agreementLevel: 'high',
      synthesized: false,
      providers: [primaryResponse.provider],
    };
  }

  // Track costs (fire-and-forget)
  if (opts.userId) {
    for (const r of secondaries) {
      trackCost({
        userId: opts.userId,
        provider: r.provider,
        model: r.model,
        inputTokens: r.usage?.inputTokens || 0,
        outputTokens: r.usage?.outputTokens || 0,
        costUsd: r.usage?.costUsd || 0,
        latencyMs: r.latencyMs || 0,
        routingReason: 'second-opinion',
      }).catch(() => {});
    }
  }

  // Calculate confidence across all answers (primary + secondaries)
  const allTexts = [primaryResponse.content, ...secondaries.map(s => s.content)];
  const confidence = calculateMultiConfidence(allTexts);
  const agreementLevel = confidence > 0.7 ? 'high' : confidence > 0.4 ? 'medium' : 'low';

  // If high agreement → primary answer is good enough, skip synthesis
  if (agreementLevel === 'high') {
    return {
      result: primaryResponse.content,
      confidence,
      agreementLevel,
      synthesized: false,
      providers: [primaryResponse.provider, ...secondaries.map(s => s.provider)],
    };
  }

  // Synthesize: combine best parts of all answers
  const answersBlock = [
    `[${primaryResponse.provider.toUpperCase()} — PRIMARY]:\n${primaryResponse.content}`,
    ...secondaries.map(s => `[${s.provider.toUpperCase()}]:\n${s.content}`),
  ].join('\n\n---\n\n');

  // Extract the original user question for context
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const questionContext = lastUserMsg
    ? `URSPRÜNGLICHE FRAGE DES USERS:\n${lastUserMsg.content}\n\n`
    : '';

  const synthesisAdapter = getAdapter('anthropic');
  let synthesis;
  try {
    synthesis = await Promise.race([
      synthesisAdapter.complete({
        messages: [{
          role: 'user',
          content: `Du bist Sophie — warm, intelligent, natürlich.\n` +
            `${questionContext}` +
            `${allTexts.length} KIs haben auf diese Frage geantwortet. ` +
            `Die Übereinstimmung ist ${agreementLevel} (${Math.round(confidence * 100)}%).\n\n` +
            `Kombiniere die besten Teile aller Antworten zu EINER optimalen Antwort. ` +
            `Beantworte die Frage des Users direkt. Kein Meta-Kommentar, keine Erwähnung anderer KIs.\n\n` +
            `DIE ANTWORTEN:\n\n${answersBlock}`,
        }],
        model: 'claude-haiku-4-5',
        maxTokens: 1024,
        temperature: 0.7,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), PER_PROVIDER_TIMEOUT)),
    ]);
  } catch {
    // Synthesis failed — fall back to primary
    return {
      result: primaryResponse.content,
      confidence,
      agreementLevel,
      synthesized: false,
      providers: [primaryResponse.provider, ...secondaries.map(s => s.provider)],
    };
  }

  // Track synthesis cost
  if (opts.userId && synthesis.usage) {
    trackCost({
      userId: opts.userId,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      inputTokens: synthesis.usage.inputTokens || 0,
      outputTokens: synthesis.usage.outputTokens || 0,
      costUsd: synthesis.usage.costUsd || 0,
      latencyMs: 0,
      routingReason: 'second-opinion-synthesis',
    }).catch(() => {});
  }

  const finalContent = normalizeResponse(synthesis.content, 'anthropic');

  return {
    result: finalContent,
    confidence,
    agreementLevel,
    synthesized: true,
    providers: [primaryResponse.provider, ...secondaries.map(s => s.provider)],
  };
}

/**
 * Multi-answer confidence score combining:
 * - Pairwise Jaccard similarity (word overlap)
 * - Answer length consistency
 * @param {string[]} texts — all answers (primary + secondaries)
 * @returns {number} 0-1 confidence score
 */
function calculateMultiConfidence(texts) {
  if (texts.length < 2) return 1;

  // Tokenize all texts
  const tokenSets = texts.map(t => new Set(t.toLowerCase().split(/\s+/).filter(w => w.length > 2)));

  // Pairwise Jaccard similarity
  let totalJaccard = 0;
  let pairs = 0;
  for (let i = 0; i < tokenSets.length; i++) {
    for (let j = i + 1; j < tokenSets.length; j++) {
      const a = tokenSets[i];
      const b = tokenSets[j];
      let intersection = 0;
      for (const w of a) { if (b.has(w)) intersection++; }
      const union = new Set([...a, ...b]).size;
      totalJaccard += union > 0 ? intersection / union : 1;
      pairs++;
    }
  }
  const avgJaccard = pairs > 0 ? totalJaccard / pairs : 1;

  // Length consistency: how similar are answer lengths?
  const lengths = texts.map(t => t.length);
  const avgLen = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const maxDeviation = Math.max(...lengths.map(l => Math.abs(l - avgLen) / avgLen));
  const lengthScore = Math.max(0, 1 - maxDeviation);

  // Weighted combination: 70% content overlap, 30% length consistency
  const score = avgJaccard * 0.7 + lengthScore * 0.3;
  return Math.round(score * 100) / 100;
}
