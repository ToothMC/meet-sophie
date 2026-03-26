// api/ai/second-opinion.js — Second Opinion Engine (Phase B)
// Parallel-query + synthesis for high-risk outputs
import { getAdapter } from '../../lib/ai/adapters/index.js';

/**
 * Get a second opinion by querying a secondary provider and synthesizing both answers.
 * @param {Array<{role: string, content: string}>} messages
 * @param {{ content: string, provider: string }} primaryResponse
 * @returns {Promise<{ synthesis: string, confidence: number }>}
 */
export async function getSecondOpinion(messages, primaryResponse) {
  // Pick a secondary provider different from primary
  const secondaryProvider = primaryResponse.provider === 'anthropic' ? 'openai' : 'anthropic';
  const secondaryModel = secondaryProvider === 'anthropic'
    ? 'claude-sonnet-4-6'
    : 'gpt-4o-mini';

  const adapter = getAdapter(secondaryProvider);
  const secondaryResponse = await adapter.complete({
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
    model: secondaryModel,
  });

  // Synthesize: combine best parts of both
  const synthesisAdapter = getAdapter('anthropic');
  const synthesis = await synthesisAdapter.complete({
    messages: [{
      role: 'user',
      content: `Kombiniere die besten Teile dieser zwei Antworten zu einer optimalen Antwort. ` +
        `Behalte Sophie's Ton (warm, natürlich, intelligent).\n\n` +
        `ANTWORT A:\n${primaryResponse.content}\n\n` +
        `ANTWORT B:\n${secondaryResponse.content}`,
    }],
    model: 'claude-haiku-4-5',
  });

  return {
    synthesis: synthesis.content,
    confidence: calculateConfidence(primaryResponse.content, secondaryResponse.content),
  };
}

/**
 * Simple confidence score: how similar are the two answers?
 * Higher similarity = higher confidence.
 */
function calculateConfidence(textA, textB) {
  const wordsA = new Set(textA.toLowerCase().split(/\s+/));
  const wordsB = new Set(textB.toLowerCase().split(/\s+/));

  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }

  const total = Math.max(wordsA.size, wordsB.size);
  if (total === 0) return 1;
  return Math.round((overlap / total) * 100) / 100;
}
