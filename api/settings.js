// api/settings.js — Settings API (sources, costs, health)
import { createClient } from '@supabase/supabase-js';
import { listSources, decoupleSource, deleteRawData, deleteAll } from '../lib/import/source-ledger.js';
import { TOKEN_COSTS, SECONDS_PER_TOKEN } from '../lib/billing-constants.js';

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

  // ── GET: Usage (balance + daily cost cap) ──
  if (action === 'usage' && req.method === 'GET') {
    const [usageRes, subRes, costRes] = await Promise.all([
      supabase.from('user_usage')
        .select('free_tokens_total, free_tokens_used, paid_tokens_total, paid_tokens_used, topup_tokens_balance')
        .eq('user_id', user.id).maybeSingle(),
      supabase.from('user_subscriptions')
        .select('is_active, status, plan, current_period_end')
        .eq('user_id', user.id).maybeSingle(),
      supabase.from('ai_cost_daily')
        .select('total_cost')
        .eq('user_id', user.id)
        .eq('date', new Date().toISOString().split('T')[0])
        .maybeSingle(),
    ]);

    const usage = usageRes.data;
    const sub = subRes.data;
    const active = !!(sub?.is_active || sub?.status === 'active' || sub?.status === 'trialing');

    const freeTotal = usage?.free_tokens_total ?? 50;
    const freeUsed = usage?.free_tokens_used ?? 0;
    const freeRemaining = Math.max(0, freeTotal - freeUsed);

    const paidTotal = usage?.paid_tokens_total ?? 0;
    const paidUsed = usage?.paid_tokens_used ?? 0;
    const paidRemaining = Math.max(0, paidTotal - paidUsed);

    const topupRemaining = Math.max(0, usage?.topup_tokens_balance ?? 0);

    const totalTokens = freeTotal + paidTotal + topupRemaining;
    const remainingTokens = freeRemaining + paidRemaining + topupRemaining;
    const usedTokens = totalTokens - remainingTokens;
    const usagePercent = totalTokens > 0 ? Math.round((usedTokens / totalTokens) * 100) : 0;

    // Derived values
    const estimatedVoiceMinutes = Math.floor(remainingTokens / TOKEN_COSTS.voice_minute);
    const remainingSeconds = remainingTokens * SECONDS_PER_TOKEN; // backward compat

    // Daily AI cost cap
    const tier = active ? (sub?.plan === 'premium' ? 'premium' : 'abo') : 'free';
    const caps = { free: 0.50, abo: 5.00, premium: 15.00 };
    const dailyCost = costRes.data?.total_cost ?? 0;
    const dailyCap = caps[tier] ?? caps.abo;

    return res.status(200).json({
      remainingTokens,
      totalTokens,
      remainingSeconds,
      estimatedVoiceMinutes,
      usagePercent,
      freeRemaining,
      paidRemaining,
      topupRemaining,
      plan: sub?.plan || null,
      isActive: active,
      periodEnd: sub?.current_period_end || null,
      dailyCost,
      dailyCap,
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
      // Meeting report — check for HTML report first, fallback to summary
      const { data: mtg } = await supabase
        .from('meetings').select('id, title, meeting_type, session_id')
        .eq('id', sessionId).eq('user_id', user.id).maybeSingle();
      if (!mtg) return res.status(404).json({ error: 'Meeting not found' });

      // Try to load HTML report from conversation_outputs (via meeting's session_id)
      let reportHtml = null;
      if (mtg.session_id) {
        const { data: co } = await supabase
          .from('conversation_outputs').select('report_html')
          .eq('session_id', mtg.session_id).maybeSingle();
        if (co?.report_html) reportHtml = co.report_html;
      }

      // Load structured summary
      const { data } = await supabase
        .from('meeting_summary')
        .select('meeting_id, short_summary, decisions, action_items, open_points, risks, created_at')
        .eq('meeting_id', sessionId).maybeSingle();

      if (!data && !reportHtml) return res.status(404).json({ error: 'Meeting report not found' });

      return res.status(200).json({
        ...(data || {}),
        report_html: reportHtml,
        session_id: sessionId,
        title: mtg.title || mtg.meeting_type || 'Meeting',
        source: 'meeting',
      });
    }

    // Talk report from conversation_outputs
    const { data: session } = await supabase
      .from('user_sessions').select('id').eq('id', sessionId).eq('user_id', user.id).maybeSingle();
    if (!session) return res.status(404).json({ error: 'Report not found' });

    const { data } = await supabase
      .from('conversation_outputs')
      .select('session_id, title, report_html, report_providers, report_status, report_style, created_at')
      .eq('session_id', sessionId)
      .maybeSingle();

    if (!data) return res.status(404).json({ error: 'Report not found' });
    return res.status(200).json({ ...data, source: 'talk' });
  }

  // ── GET: Pitch Journey — consolidated pitch progress per topic ──
  if (action === 'pitch-journey' && req.method === 'GET') {
    const { data: pitches } = await supabase
      .from('sophie_pitch_memory')
      .select('id, topic, target_audience, pitch_type, goal_type, score, scores_content, scores_delivery, strengths, weaknesses, version, parent_pitch_id, conversation_id, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true });

    if (!pitches || pitches.length === 0) {
      return res.status(200).json({ journeys: [] });
    }

    // Group by topic
    const byTopic = {};
    for (const p of pitches) {
      const key = (p.topic || 'Untitled').trim();
      if (!byTopic[key]) byTopic[key] = [];
      byTopic[key].push(p);
    }

    const journeys = Object.entries(byTopic).map(([topic, versions]) => {
      const latest = versions[versions.length - 1];
      const first = versions[0];
      const overallLatest = latest.score || 0;
      const overallFirst = first.score || 0;

      // Compute per-criterion trends (latest vs first)
      const trends = {};
      if (versions.length > 1 && latest.scores_content && first.scores_content) {
        for (const k of Object.keys(latest.scores_content)) {
          const cur = latest.scores_content[k] || 0;
          const prev = first.scores_content[k] || 0;
          trends[k] = cur > prev + 0.3 ? '▲' : cur < prev - 0.3 ? '▼' : '●';
        }
      }
      if (versions.length > 1 && latest.scores_delivery && first.scores_delivery) {
        for (const k of Object.keys(latest.scores_delivery)) {
          const cur = latest.scores_delivery[k] || 0;
          const prev = first.scores_delivery[k] || 0;
          trends[k] = cur > prev + 0.3 ? '▲' : cur < prev - 0.3 ? '▼' : '●';
        }
      }

      // Score history for sparkline
      const scoreHistory = versions.map(v => ({ version: v.version || 1, score: v.score || 0, date: v.created_at }));

      return {
        topic,
        pitchType: latest.pitch_type,
        goalType: latest.goal_type,
        audience: latest.target_audience,
        versionCount: versions.length,
        latest: {
          id: latest.id,
          version: latest.version || versions.length,
          score: overallLatest,
          scoresContent: latest.scores_content,
          scoresDelivery: latest.scores_delivery,
          strengths: latest.strengths || [],
          weaknesses: latest.weaknesses || [],
          conversationId: latest.conversation_id,
          date: latest.created_at,
        },
        first: {
          score: overallFirst,
          date: first.created_at,
        },
        scoreDelta: overallLatest - overallFirst,
        trends,
        scoreHistory,
      };
    });

    // Sort by most recent activity
    journeys.sort((a, b) => new Date(b.latest.date) - new Date(a.latest.date));
    return res.status(200).json({ journeys });
  }

  // ── GET: Single pitch journey detail (for handover) ──
  if (action === 'pitch-journey-detail' && req.method === 'GET') {
    const topic = req.query?.topic;
    if (!topic) return res.status(400).json({ error: 'Missing topic' });

    const { data: latest } = await supabase
      .from('sophie_pitch_memory')
      .select('id, topic, target_audience, pitch_type, goal_type, score, scores_content, scores_delivery, strengths, weaknesses, version, created_at')
      .eq('user_id', user.id)
      .eq('topic', topic)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!latest) return res.status(404).json({ error: 'No pitch found for topic' });

    // Load the actual pitch transcript + report for demo context
    let pitchTranscript = '';
    let reportSummary = '';
    if (latest.conversation_id) {
      try {
        // Get transcript from conversation_messages
        const { data: msgs } = await supabase
          .from('conversation_messages')
          .select('role, text')
          .eq('session_id', latest.conversation_id)
          .order('seq', { ascending: true })
          .limit(100);
        if (msgs?.length) {
          pitchTranscript = msgs
            .filter(m => m.text?.trim())
            .map(m => `[${m.role}]: ${m.text}`)
            .join('\n')
            .slice(0, 6000); // Cap at 6k chars
        }

        // Get report text (strip HTML)
        const { data: output } = await supabase
          .from('conversation_outputs')
          .select('report_html, title')
          .eq('session_id', latest.conversation_id)
          .maybeSingle();
        if (output?.report_html) {
          // Simple HTML strip for text extraction
          reportSummary = output.report_html
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 4000);
        }
      } catch (e) { console.error('[pitch-journey-detail] transcript load error:', e?.message); }
    }

    return res.status(200).json({ ...latest, pitchTranscript, reportSummary });
  }

  // ── POST: Generate demo pitch text server-side (Claude/GPT, not Realtime) ──
  if (action === 'generate-demo-pitch' && req.method === 'POST') {
    const { session_id } = req.body || {};
    if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

    // Load transcript + report
    let transcript = '';
    let reportText = '';
    try {
      const { data: msgs } = await supabase
        .from('conversation_messages')
        .select('role, text')
        .eq('session_id', session_id)
        .order('seq', { ascending: true })
        .limit(100);
      if (msgs?.length) {
        transcript = msgs.filter(m => m.text?.trim()).map(m => `[${m.role}]: ${m.text}`).join('\n').slice(0, 6000);
      }

      const { data: output } = await supabase
        .from('conversation_outputs')
        .select('report_html')
        .eq('session_id', session_id)
        .maybeSingle();
      if (output?.report_html) {
        reportText = output.report_html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
      }
    } catch (e) { console.error('[generate-demo] load failed:', e?.message); }

    if (!transcript) return res.status(400).json({ error: 'No transcript found for this session' });

    // Generate optimized pitch via text AI (much more reliable than Realtime)
    try {
      const { getAdapter } = await import('../lib/ai/adapters/index.js');
      const adapter = getAdapter('openai');
      const resp = await adapter.complete({
        messages: [{ role: 'user', content: `Du bist ein Pitch-Coach. Unten ist das Transcript eines Sales Pitches.

DEINE AUFGABE: Schreibe eine VERBESSERTE VERSION dieses Pitches.
- Verwende NUR Fakten und Informationen aus dem Transcript
- ERFINDE NICHTS NEUES — keine Features, keine Eigenschaften, keine Partnerschaften
- Verbessere: Struktur (Hook → Problem → Lösung → Beweis → CTA), Rhetorik, Klarheit, roter Faden
- Wenn der Produktname im Transcript steht, verwende EXAKT diesen Namen
- Halte den Pitch auf 2-3 Minuten Sprechdauer (ca. 400-500 Wörter)
- Schreibe ihn so dass er laut vorgelesen werden kann (natürliche Sprache, keine Stichpunkte)
- Am Ende füge 3-4 Zeilen hinzu die erklären was du strukturell anders gemacht hast

${reportText ? `BEWERTUNG DES ORIGINAL-PITCHES:\n${reportText.slice(0, 2000)}\n` : ''}

ORIGINAL PITCH-TRANSCRIPT:
${transcript}

Schreibe NUR den optimierten Pitch-Text. Keine Einleitung, kein "Hier ist der verbesserte Pitch". Direkt der Pitch.` }],
        model: 'gpt-4o', maxTokens: 2000, temperature: 0.4,
      });

      const demoPitch = (resp.content || '').trim();
      if (!demoPitch || demoPitch.length < 100) {
        return res.status(500).json({ error: 'Demo pitch generation failed' });
      }

      console.log(`[generate-demo] created ${demoPitch.length}c pitch for session ${session_id}`);
      return res.status(200).json({ demoPitch });
    } catch (e) {
      console.error('[generate-demo] AI failed:', e?.message);
      return res.status(500).json({ error: 'AI generation failed' });
    }
  }

  // ── POST: Save Sophie's demo pitch transcript for iterative improvement ──
  if (action === 'save-demo-pitch' && req.method === 'POST') {
    const { topic, transcript } = req.body || {};
    if (!topic || !transcript) return res.status(400).json({ error: 'Missing topic or transcript' });

    // Extract Sophie's self-critique from the end of the transcript
    const lines = transcript.split('\n');
    const critiqueStart = lines.findIndex(l => /anders|besser|unterschied|verbessert|changed|different|improved/i.test(l));
    const selfCritique = critiqueStart >= 0 ? lines.slice(critiqueStart).join('\n').slice(0, 2000) : '';

    const { error } = await supabase.from('sophie_pitch_memory').insert({
      user_id: user.id,
      topic: topic,
      pitch_type: 'demo',
      strengths: selfCritique ? [selfCritique] : [],
      weaknesses: [],
      score: 0,
      version: 1,
      recurring_errors: [transcript.slice(0, 8000)], // Store full demo transcript in recurring_errors field
    });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  // ── GET: Load latest demo pitch transcript for a topic ──
  if (action === 'get-demo-pitch' && req.method === 'GET') {
    const topic = req.query?.topic;
    if (!topic) return res.status(400).json({ error: 'Missing topic' });

    const { data } = await supabase.from('sophie_pitch_memory')
      .select('recurring_errors, strengths, created_at')
      .eq('user_id', user.id)
      .eq('topic', topic)
      .eq('pitch_type', 'demo')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) return res.status(200).json({ found: false });
    return res.status(200).json({
      found: true,
      transcript: (data.recurring_errors || [])[0] || '',
      selfCritique: (data.strengths || [])[0] || '',
      date: data.created_at,
    });
  }

  // ── Custom Rules: Sophie-learned behavioral rules ──
  if (action === 'custom-rules' && req.method === 'GET') {
    const { data } = await supabase.from('user_profile').select('custom_rules').eq('user_id', user.id).maybeSingle();
    return res.status(200).json({ rules: data?.custom_rules || [] });
  }

  if (action === 'save-custom-rule' && req.method === 'POST') {
    const { rule, context } = req.body || {};
    if (!rule) return res.status(400).json({ error: 'Missing rule' });

    // Load existing rules
    const { data: profile } = await supabase.from('user_profile').select('custom_rules').eq('user_id', user.id).maybeSingle();
    const rules = Array.isArray(profile?.custom_rules) ? profile.custom_rules : [];

    // Max 20 rules per user
    if (rules.length >= 20) return res.status(400).json({ error: 'Max 20 rules reached' });

    // Deduplicate — don't add if very similar rule exists
    const isDuplicate = rules.some(r => r.rule === rule);
    if (isDuplicate) return res.status(200).json({ ok: true, duplicate: true });

    rules.push({ rule, context: context || '', created_at: new Date().toISOString() });
    const { error } = await supabase.from('user_profile').update({ custom_rules: rules }).eq('user_id', user.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, count: rules.length });
  }

  if (action === 'delete-custom-rule' && req.method === 'POST') {
    const { index } = req.body || {};
    if (index == null) return res.status(400).json({ error: 'Missing index' });

    const { data: profile } = await supabase.from('user_profile').select('custom_rules').eq('user_id', user.id).maybeSingle();
    const rules = Array.isArray(profile?.custom_rules) ? [...profile.custom_rules] : [];
    if (index >= 0 && index < rules.length) rules.splice(index, 1);
    const { error } = await supabase.from('user_profile').update({ custom_rules: rules }).eq('user_id', user.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, count: rules.length });
  }

  if (action === 'reset-custom-rules' && req.method === 'POST') {
    const { error } = await supabase.from('user_profile').update({ custom_rules: [] }).eq('user_id', user.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  // ── GET: Pitch transcript by session_id (fallback for old pitches without pitch_memory) ──
  if (action === 'pitch-transcript' && req.method === 'GET') {
    const sid = req.query?.session_id;
    if (!sid) return res.status(400).json({ error: 'Missing session_id' });

    // Verify session belongs to user
    const { data: sess } = await supabase.from('user_sessions').select('id').eq('id', sid).eq('user_id', user.id).maybeSingle();
    if (!sess) return res.status(404).json({ error: 'Session not found' });

    let transcript = '';
    try {
      const { data: msgs } = await supabase
        .from('conversation_messages')
        .select('role, text')
        .eq('session_id', sid)
        .order('seq', { ascending: true })
        .limit(100);
      if (msgs?.length) {
        transcript = msgs.filter(m => m.text?.trim()).map(m => `[${m.role}]: ${m.text}`).join('\n').slice(0, 6000);
      }
    } catch (_) {}

    return res.status(200).json({ transcript });
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

    // Delete a report (only report, keep meeting structure)
    if (action === 'delete-report') {
      const { session_id, source } = body;
      if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

      if (source === 'meeting') {
        await supabase.from('meeting_summary').delete().eq('meeting_id', session_id);
        const { data: mtg } = await supabase.from('meetings').select('session_id').eq('id', session_id).maybeSingle();
        if (mtg?.session_id) {
          await supabase.from('conversation_outputs').delete().eq('session_id', mtg.session_id);
        }
      } else {
        await supabase.from('conversation_outputs').delete().eq('session_id', session_id);
        await supabase.from('user_sessions').delete().eq('id', session_id).eq('user_id', user.id);
      }

      return res.status(200).json({ ok: true });
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
