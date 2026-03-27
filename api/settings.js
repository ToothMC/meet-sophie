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

  // ── GET: Reports list ──
  if (action === 'reports' && req.method === 'GET') {
    const { data } = await supabase
      .from('conversation_outputs')
      .select('session_id, title, report_status, report_style, created_at')
      .eq('user_id', user.id)
      .not('report_html', 'is', null)
      .order('created_at', { ascending: false })
      .limit(50);

    // Enrich with session mode
    if (data?.length) {
      const sessionIds = data.map(r => r.session_id).filter(Boolean);
      const { data: sessions } = await supabase
        .from('user_sessions')
        .select('id, session_mode')
        .in('id', sessionIds);
      const modeMap = Object.fromEntries((sessions || []).map(s => [s.id, s.session_mode]));
      for (const r of data) r.session_mode = modeMap[r.session_id] || null;
    }

    return res.status(200).json({ reports: data || [] });
  }

  // ── GET: Report detail ──
  if (action === 'report-detail' && req.method === 'GET') {
    const sessionId = req.query?.session_id;
    if (!sessionId) return res.status(400).json({ error: 'Missing session_id' });

    const { data } = await supabase
      .from('conversation_outputs')
      .select('session_id, title, report_html, report_providers, report_status, created_at')
      .eq('session_id', sessionId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (!data) return res.status(404).json({ error: 'Report not found' });
    return res.status(200).json(data);
  }

  // ── GET: Report template ──
  if (action === 'get-report-template' && req.method === 'GET') {
    const mode = req.query?.mode || 'default';
    const { data } = await supabase
      .from('user_profile')
      .select('report_templates')
      .eq('id', user.id)
      .maybeSingle();

    const templates = data?.report_templates || {};
    return res.status(200).json({ mode, template_html: templates[mode] || null });
  }

  // ── POST: Source actions + Report template ──
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body && typeof body === 'object' ? body : {};

    // Save report template
    if (action === 'save-report-template') {
      const { mode, report_html } = body;
      if (!report_html) return res.status(400).json({ error: 'Missing report_html' });
      const templateMode = mode || 'default';

      // Get current templates, merge new one
      const { data: profile } = await supabase
        .from('user_profile')
        .select('report_templates')
        .eq('id', user.id)
        .maybeSingle();

      const templates = profile?.report_templates || {};
      templates[templateMode] = report_html;

      await supabase
        .from('user_profile')
        .update({ report_templates: templates })
        .eq('id', user.id);

      return res.status(200).json({ ok: true, mode: templateMode });
    }

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
