// api/settings.js — Settings API (sources, costs, health)
import { createClient } from '@supabase/supabase-js';
import { listSources, decoupleSource, deleteRawData, deleteAll } from '../lib/import/source-ledger.js';

export default async function handler(req, res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Missing Supabase env vars' });
  }

  // Auth
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  const action = req.query?.action || '';

  // ── GET: Sources ──
  if (action === 'sources' && req.method === 'GET') {
    const sources = await listSources(user.id);
    return res.status(200).json({ sources });
  }

  // ── GET: Costs ──
  if (action === 'costs' && req.method === 'GET') {
    const today = new Date().toISOString().split('T')[0];
    const { data } = await supabase
      .from('ai_cost_daily')
      .select('*')
      .eq('user_id', user.id)
      .eq('date', today)
      .maybeSingle();

    return res.status(200).json({
      date: today,
      totalCost: data?.total_cost || 0,
      perProvider: data?.per_provider || {},
      requestCount: data?.request_count || 0,
    });
  }

  // ── GET: Health ──
  if (action === 'health' && req.method === 'GET') {
    const { data } = await supabase
      .from('ai_provider_health')
      .select('*')
      .order('provider');

    return res.status(200).json({ providers: data || [] });
  }

  // ── POST: Source actions ──
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body && typeof body === 'object' ? body : {};

    const { sourceId } = body;
    if (!sourceId) return res.status(400).json({ error: 'Missing sourceId' });

    if (action === 'decouple') {
      await decoupleSource(sourceId, user.id);
      return res.status(200).json({ ok: true, action: 'decoupled' });
    }
    if (action === 'delete-raw') {
      await deleteRawData(sourceId, user.id);
      return res.status(200).json({ ok: true, action: 'raw_deleted' });
    }
    if (action === 'delete-all') {
      await deleteAll(sourceId, user.id);
      return res.status(200).json({ ok: true, action: 'all_deleted' });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
}
