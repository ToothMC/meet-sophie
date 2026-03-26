// api/ai/report-status.js — Poll report generation progress
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const sessionId = req.query.session_id;
  if (!sessionId) return res.status(400).json({ error: 'Missing session_id' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data, error } = await supabase
    .from('conversation_outputs')
    .select('report_status, report_progress, report_status_detail, report_html, report_providers, title')
    .eq('session_id', sessionId)
    .maybeSingle();

  if (error || !data) {
    return res.status(404).json({ error: 'Report not found' });
  }

  return res.status(200).json({
    status: data.report_status || 'pending',
    progress: data.report_progress || 0,
    detail: data.report_status_detail || null,
    ...(data.report_status === 'done' ? {
      title: data.title,
      report_html: data.report_html,
      report_providers: data.report_providers,
    } : {}),
  });
}
