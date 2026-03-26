// api/ai/health.js — Health Check Endpoint (Vercel Cron: every 60s)
// GET /api/ai/health → pings all 4 providers, upserts status into Supabase
import { createClient } from '@supabase/supabase-js';
import { getAdapter } from '../../lib/ai/adapters/index.js';

const PROVIDERS = ['openai', 'anthropic', 'google', 'mistral'];

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Missing Supabase env vars' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );

  const results = [];

  for (const provider of PROVIDERS) {
    const start = Date.now();
    try {
      const adapter = getAdapter(provider);
      const health = await adapter.healthCheck();
      results.push({
        provider,
        status: health.ok ? 'healthy' : 'degraded',
        latency_ms: health.latencyMs,
        last_check: new Date().toISOString(),
        error: null,
      });
    } catch (err) {
      results.push({
        provider,
        status: 'down',
        latency_ms: Date.now() - start,
        last_check: new Date().toISOString(),
        error: err?.message?.slice(0, 500) || 'Unknown error',
      });
    }
  }

  // Upsert all results into Supabase
  await supabase.from('ai_provider_health').upsert(results, {
    onConflict: 'provider',
  });

  return res.status(200).json({ results });
}
