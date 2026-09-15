// api/ai/challenge.js — Challenge button: three rounds (independent answers →
// critical review → briefing), then Sophie decides. The synthesizer never speaks
// as Sophie; only her verdict reaches the user and the conversation history.
import { runCouncil, buildCouncilContext } from '../../lib/ai/council.js';
import { formulateSophieVerdict } from '../../lib/ai/sophie-verdict.js';
import { prepareCouncilRequest, finishCouncilRequest, lastUserQuestion } from '../../lib/ai/council-request.js';
import { trackCost } from '../../lib/ai/cost-tracker.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const prep = await prepareCouncilRequest(req);
  if (prep.error) return res.status(prep.error.status).json(prep.error.body);

  const { supabase, user, session, sessionId, isCanonical, messages, priorAnswer, isEco, tier } = prep;
  const question = lastUserQuestion(messages);
  if (!question) return res.status(400).json({ error: 'no_question' });

  const started = Date.now();
  const council = await runCouncil({
    question,
    context: buildCouncilContext(messages),
    priorAnswer,
    mode: 'deep',
    channel: 'chat',
    userId: user.id,
    sessionId,
    isEco,
    tier,
    supabase,
  });

  if (council.disabled) return res.status(503).json({ error: 'council_disabled' });

  const verdict = await formulateSophieVerdict({
    supabase, user, session, messages, council, isEco, tier,
  });
  if (verdict.usage) {
    trackCost({
      userId: user.id, provider: verdict.provider, model: verdict.model,
      inputTokens: verdict.usage.inputTokens, outputTokens: verdict.usage.outputTokens,
      costUsd: verdict.usage.costUsd, latencyMs: 0, routingReason: `council:verdict:${council.runId}`,
    }).catch(() => {});
  }

  if (!verdict.text) return res.status(502).json({ error: 'Council could not produce an answer' });

  const { remaining } = await finishCouncilRequest({
    supabase, user, sessionId, isCanonical, verdict: verdict.text, costKey: 'challenge',
  });

  const okAdvisors = council.advisors.filter(a => a.ok);

  return res.status(200).json({
    finalAnswer: verdict.text,
    sophieVerdict: verdict.text,
    briefing: council.degraded ? null : {
      recommendation: council.recommendation,
      consensus: council.consensus,
      dissent: council.dissent,
      uncertainty: council.uncertainty,
      criticalAssumptions: council.criticalAssumptions,
      agreement: council.agreement,
    },
    providers: okAdvisors.map(a => a.provider),
    advisors: okAdvisors.map(a => a.provider),
    degraded: council.degraded,
    totalCost: council.costUsd,
    totalLatencyMs: Date.now() - started,
    rounds: 3,
    ...(remaining != null && { remaining_tokens: remaining }),
  });
}
