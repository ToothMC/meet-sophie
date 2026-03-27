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
    // Get user's sessions first, then their reports
    const { data: sessions } = await supabase
      .from('user_sessions')
      .select('id')
      .eq('user_id', user.id)
      .eq('has_output', true)
      .order('started_at', { ascending: false })
      .limit(50);

    if (!sessions?.length) return res.status(200).json({ reports: [] });

    const sessionIds = sessions.map(s => s.id);
    const { data } = await supabase
      .from('conversation_outputs')
      .select('session_id, title, report_status, report_style, created_at')
      .in('session_id', sessionIds)
      .not('report_html', 'is', null)
      .order('created_at', { ascending: false });

    return res.status(200).json({ reports: data || [] });
  }

  // ── GET: Report detail ──
  if (action === 'report-detail' && req.method === 'GET') {
    const sessionId = req.query?.session_id;
    if (!sessionId) return res.status(400).json({ error: 'Missing session_id' });

    // Verify ownership via user_sessions
    const { data: session } = await supabase
      .from('user_sessions')
      .select('id')
      .eq('id', sessionId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (!session) return res.status(404).json({ error: 'Report not found' });

    const { data } = await supabase
      .from('conversation_outputs')
      .select('session_id, title, report_html, report_providers, report_status, created_at')
      .eq('session_id', sessionId)
      .maybeSingle();

    if (!data) return res.status(404).json({ error: 'Report not found' });
    return res.status(200).json(data);
  }

  // ── GET: Report template (single) ──
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

  // ── GET: All templates overview ──
  if (action === 'templates' && req.method === 'GET') {
    const { data } = await supabase
      .from('user_profile')
      .select('report_templates')
      .eq('id', user.id)
      .maybeSingle();

    const templates = data?.report_templates || {};
    // Return mode names + preview (first 200 chars of HTML)
    const list = Object.entries(templates).map(([mode, html]) => ({
      mode,
      preview: html ? html.replace(/<[^>]*>/g, '').slice(0, 150).trim() : '',
      length: html?.length || 0,
    }));
    return res.status(200).json({ templates: list });
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

    // Delete a report
    if (action === 'delete-report') {
      const { session_id: delSessionId } = body;
      if (!delSessionId) return res.status(400).json({ error: 'Missing session_id' });

      // Verify ownership
      const { data: sess } = await supabase
        .from('user_sessions').select('id').eq('id', delSessionId).eq('user_id', user.id).maybeSingle();
      if (!sess) return res.status(404).json({ error: 'Session not found' });

      // Clear report fields (keep the conversation_outputs row for potential other data)
      await supabase.from('conversation_outputs')
        .update({
          report_html: null, report_status: null, report_progress: null,
          report_status_detail: null, report_providers: null, report_style: null,
        })
        .eq('session_id', delSessionId);

      await supabase.from('user_sessions').update({ has_output: false }).eq('id', delSessionId);

      return res.status(200).json({ ok: true, action: 'report_deleted' });
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
