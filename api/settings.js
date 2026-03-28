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

  // ── GET: Account (profile + subscription) ──
  if (action === 'account' && req.method === 'GET') {
    const [profRes, subRes] = await Promise.all([
      supabase.from('user_profile').select('preferred_name, first_name').eq('user_id', user.id).maybeSingle(),
      supabase.from('user_subscriptions').select('is_active, status, plan').eq('user_id', user.id).maybeSingle(),
    ]);
    return res.status(200).json({
      profile: profRes.data || null,
      subscription: subRes.data || null,
    });
  }

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
    // Load Talk reports from conversation_outputs
    const { data: sessions } = await supabase
      .from('user_sessions')
      .select('id')
      .eq('user_id', user.id)
      .eq('has_output', true)
      .order('started_at', { ascending: false })
      .limit(50);

    const talkReports = [];
    if (sessions?.length) {
      const sessionIds = sessions.map(s => s.id);
      const { data } = await supabase
        .from('conversation_outputs')
        .select('session_id, title, report_status, report_style, created_at')
        .in('session_id', sessionIds)
        .not('report_html', 'is', null)
        .order('created_at', { ascending: false });
      for (const r of (data || [])) {
        talkReports.push({ ...r, source: 'talk', id: r.session_id });
      }
    }

    // Load Meeting reports from meetings + meeting_summary
    const { data: meetings } = await supabase
      .from('meetings')
      .select('id, title, meeting_type, phase, started_at, session_id')
      .eq('user_id', user.id)
      .in('phase', ['post', 'closed'])
      .order('started_at', { ascending: false })
      .limit(50);

    const meetingReports = [];
    if (meetings?.length) {
      const meetingIds = meetings.map(m => m.id);
      const { data: summaries } = await supabase
        .from('meeting_summary')
        .select('meeting_id, short_summary, created_at')
        .in('meeting_id', meetingIds);
      const sumMap = Object.fromEntries((summaries || []).map(s => [s.meeting_id, s]));

      for (const m of meetings) {
        // Only show meetings that actually have a summary/report
        if (!sumMap[m.id]) continue;
        meetingReports.push({
          id: m.id,
          session_id: m.id,
          title: m.title || 'Meeting',
          report_status: 'done',
          report_style: m.meeting_type || 'meeting',
          created_at: sumMap[m.id]?.created_at || m.started_at,
          source: 'meeting',
        });
      }
    }

    // Remove talk reports that are already covered by a meeting (avoid duplicates)
    const meetingSessionIds = new Set((meetings || []).map(m => m.session_id).filter(Boolean));
    const dedupedTalkReports = talkReports.filter(r => !meetingSessionIds.has(r.session_id));

    // Merge and sort by date
    const all = [...dedupedTalkReports, ...meetingReports]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return res.status(200).json({ reports: all });
  }

  // ── GET: Report detail ──
  if (action === 'report-detail' && req.method === 'GET') {
    const sessionId = req.query?.session_id;
    const source = req.query?.source || 'talk';
    if (!sessionId) return res.status(400).json({ error: 'Missing session_id' });

    if (source === 'meeting') {
      // Meeting report from meeting_summary
      const { data: meeting } = await supabase
        .from('meetings').select('id').eq('id', sessionId).eq('user_id', user.id).maybeSingle();
      if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

      const { data } = await supabase
        .from('meeting_summary')
        .select('meeting_id, short_summary, decisions, action_items, open_points, risks, created_at')
        .eq('meeting_id', sessionId)
        .maybeSingle();

      if (!data) return res.status(404).json({ error: 'Meeting summary not found' });

      // Get meeting title
      const { data: mtg } = await supabase
        .from('meetings').select('title, meeting_type').eq('id', sessionId).maybeSingle();

      return res.status(200).json({
        ...data,
        session_id: data.meeting_id,
        title: mtg?.title || 'Meeting',
        source: 'meeting',
      });
    }

    // Talk report from conversation_outputs
    const { data: session } = await supabase
      .from('user_sessions').select('id').eq('id', sessionId).eq('user_id', user.id).maybeSingle();
    if (!session) return res.status(404).json({ error: 'Report not found' });

    const { data } = await supabase
      .from('conversation_outputs')
      .select('session_id, title, report_html, report_providers, report_status, created_at')
      .eq('session_id', sessionId)
      .maybeSingle();

    if (!data) return res.status(404).json({ error: 'Report not found' });
    return res.status(200).json({ ...data, source: 'talk' });
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

  // ── GET: All templates overview (system + user) ──
  if (action === 'templates' && req.method === 'GET') {
    // Import system defaults dynamically
    const { DEFAULT_TEMPLATES } = await import('../lib/report-templates.js');

    const { data } = await supabase
      .from('user_profile')
      .select('report_templates')
      .eq('user_id', user.id)
      .maybeSingle();

    const userTemplates = data?.report_templates || {};
    const allModes = new Set([...Object.keys(DEFAULT_TEMPLATES), ...Object.keys(userTemplates)]);

    const list = [];
    for (const mode of allModes) {
      const isUserCustom = !!userTemplates[mode];
      const html = isUserCustom ? userTemplates[mode] : DEFAULT_TEMPLATES[mode];
      list.push({
        mode,
        type: isUserCustom ? 'user' : 'system',
        preview: html ? html.replace(/<[^>]*>/g, '').slice(0, 150).trim() : '',
        length: html?.length || 0,
      });
    }
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

    // Delete a template
    if (action === 'delete-template') {
      const { mode } = body;
      if (!mode) return res.status(400).json({ error: 'Missing mode' });

      const { data: profile } = await supabase
        .from('user_profile').select('report_templates').eq('user_id', user.id).maybeSingle();
      const templates = profile?.report_templates || {};
      delete templates[mode];

      await supabase.from('user_profile').update({ report_templates: templates }).eq('user_id', user.id);
      return res.status(200).json({ ok: true, deleted: mode });
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

  // ── POST: Delete report ──
  if (action === 'delete-report' && req.method === 'POST') {
    const { session_id, source } = req.body || {};
    if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

    if (source === 'meeting') {
      // Only delete report/summary — keep meeting structure intact
      await supabase.from('meeting_summary').delete().eq('meeting_id', session_id);
      // Clean up linked report session if exists
      const { data: mtg } = await supabase.from('meetings').select('session_id').eq('id', session_id).maybeSingle();
      if (mtg?.session_id) {
        await supabase.from('conversation_outputs').delete().eq('session_id', mtg.session_id);
      }
    } else {
      // Delete talk report
      await supabase.from('conversation_outputs').delete().eq('session_id', session_id);
      await supabase.from('user_sessions').delete().eq('id', session_id).eq('user_id', user.id);
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
