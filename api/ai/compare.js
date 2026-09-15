// api/ai/compare.js — Compare button: independent advisors answer in parallel,
// Sophie decides. Advisor answers are returned as clearly-labelled foreign-model
// evidence; only Sophie's verdict is her answer and only it is persisted.
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

  const council = await runCouncil({
    question,
    context: buildCouncilContext(messages),
    priorAnswer,
    mode: 'quick',
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

  const { remaining } = await finishCouncilRequest({
    supabase, user, sessionId, isCanonical, verdict: verdict.text, costKey: 'compare',
  });

  // Evidence, ordered by advisor latency — foreign-model output, never Sophie's voice.
  const okAdvisors = council.advisors.filter(a => a.ok).sort((a, b) => a.latencyMs - b.latencyMs);
  const excerptOf = (provider) => council.evidence.find(e => e.provider === provider)?.excerpt || '';
  const evidence = okAdvisors.map(a => ({
    provider: a.provider, model: a.model, content: excerptOf(a.provider), latencyMs: a.latencyMs, costUsd: 0,
  }));

  if (!evidence.length && !verdict.text) return res.status(502).json({ error: 'All providers failed' });

  return res.status(200).json({
    fastest: evidence[0] || null,
    others: evidence.slice(1),
    evidence,
    sophieVerdict: verdict.text,
    briefing: council.degraded ? null : {
      recommendation: council.recommendation,
      consensus: council.consensus,
      dissent: council.dissent,
      uncertainty: council.uncertainty,
      criticalAssumptions: council.criticalAssumptions,
      agreement: council.agreement,
    },
    advisors: okAdvisors.map(a => a.provider),
    degraded: council.degraded,
    totalCost: council.costUsd,
    providerCount: evidence.length,
    ...(remaining != null && { remaining_tokens: remaining }),
  });
}
