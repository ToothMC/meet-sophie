// api/ai/generate-report.js — Smart Report Generator
// All 4 AIs analyze, Claude generates the final HTML report directly.
// No JSON blocks, no templates — pure HTML creativity.
import { createClient } from '@supabase/supabase-js';
import { getAdapter } from '../../lib/ai/adapters/index.js';

export const config = { maxDuration: 120 };

const REPORT_PROVIDERS = [
  { provider: 'openai', model: 'gpt-4o-mini' },
  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { provider: 'google', model: 'gemini-2.5-flash' },
  { provider: 'mistral', model: 'mistral-small-latest' },
];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const { session_id, transcript_text, session_mode } = body;
  if (!session_id || !transcript_text) return res.status(400).json({ error: 'Missing session_id or transcript_text' });

  await supabase.from('conversation_outputs')
    .update({ report_status: 'generating', report_progress: 5 })
    .eq('session_id', session_id);

  try {
    const modeHint = session_mode ? `Session-Modus: "${session_mode}".` : '';

    // Step 1: All 4 AIs analyze the transcript
    const analysisPrompt = `Analysiere dieses Gespräch. Extrahiere alles Relevante als freien Text.
${modeHint} Erfinde NICHTS. Schreibe in der Sprache des Transcripts.`;

    const analyses = [];
    for (let i = 0; i < REPORT_PROVIDERS.length; i++) {
      const { provider, model } = REPORT_PROVIDERS[i];
      await supabase.from('conversation_outputs')
        .update({ report_progress: 10 + Math.round((i / 4) * 50), report_status_detail: `Analysiere mit ${provider}...` })
        .eq('session_id', session_id);

      try {
        const adapter = getAdapter(provider);
        const response = await adapter.complete({
          messages: [
            { role: 'system', content: analysisPrompt },
            { role: 'user', content: `Transcript:\n${transcript_text}` },
          ],
          model, maxTokens: 2048, temperature: 0.2,
        });
        if (response.content) analyses.push({ provider, text: response.content });
      } catch (e) {
        console.error(`[report] ${provider} failed:`, e?.message);
      }
    }

    if (analyses.length === 0) {
      await supabase.from('conversation_outputs')
        .update({ report_status: 'failed', report_progress: 100, report_status_detail: 'Keine AI-Provider verfügbar' })
        .eq('session_id', session_id);
      return res.status(500).json({ error: 'No providers available' });
    }

    // Step 2: Claude generates the final HTML report
    await supabase.from('conversation_outputs')
      .update({ report_progress: 70, report_status_detail: `Erstelle Report aus ${analyses.length} Analysen...` })
      .eq('session_id', session_id);

    const analysesBlock = analyses
      .map(a => `[${a.provider.toUpperCase()}]:\n${a.text}`)
      .join('\n\n---\n\n');

    const htmlPrompt = `Du bist ein Premium Report-Designer für Sophie, eine hochintelligente KI.
${analyses.length} KIs haben dasselbe Gespräch unabhängig analysiert.

Erstelle einen REPORT als reines HTML (nur den <body> Inhalt, kein <html>/<head>).

DESIGN-REGELN:
- Modernes, elegantes Design — der User soll spüren dass er mit einer intelligenten KI arbeitet
- NUR Fakten verwenden die mindestens 2 KIs bestätigen
- Der INHALT bestimmt die FORM:
  → Routenplanung? Zeige die Route visuell als Timeline/Stationen mit Pfeilen, Distanzen, Fahrzeiten
  → Sales Pitch? Score-Card mit farbigen Balken (grün ≥4, gelb ≥3, rot <3), Overall Score
  → Meeting? Protokoll mit Agenda, Beschlüssen (✓), Action Items mit Owner
  → Brainstorm? Ideen-Cluster, Favoriten hervorgehoben
  → Kurzes Gespräch? Kompakte Zusammenfassung, keine erzwungene Tiefe
  → Entscheidung? Pro/Contra visuell gegenübergestellt
- KEINE starre Vorlage — jeder Report ist einzigartig, passend zum Inhalt
- Nutze moderne CSS: border-radius, subtle shadows, gradient accents, pill badges
- Farbpalette: #2a2420 (dark), #c4a882 (gold accent), #4a8c5c (green/positive), #b85a4a (red/negative), #f5f0ea (background)
- Schriftart: system font stack (wird vom Parent vererbt)
- Responsive: max-width 100%, keine festen Breiten
- Schreibe in der gleichen Sprache wie die Analysen

KONSISTENZ bei wiederholten Session-Typen:
- Sales Pitch: IMMER diese 8 Kriterien mit Score 0-5: Clarity, Problem Sharpness, Value Proposition, Differentiation, Credibility, Audience Fit, Objection Handling, Persuasiveness
- Meeting: IMMER Agenda → Beschlüsse → Action Items → Offene Punkte

Antworte NUR mit dem HTML. Kein Markdown, kein Text davor/danach.

DIE ${analyses.length} ANALYSEN:

${analysesBlock}`;

    let reportHtml = null;
    for (const synth of [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openai', model: 'gpt-4o-mini' },
    ]) {
      try {
        const adapter = getAdapter(synth.provider);
        const response = await adapter.complete({
          messages: [{ role: 'user', content: htmlPrompt }],
          model: synth.model, maxTokens: 4000, temperature: 0.4,
        });
        const text = (response.content || '').trim();
        // Strip markdown code fences if present
        reportHtml = text.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim();
        if (reportHtml.length > 50) break; // looks like real HTML
        reportHtml = null;
      } catch (e) {
        console.error(`[report] HTML generation with ${synth.provider} failed:`, e?.message);
      }
    }

    if (!reportHtml) {
      // Last resort fallback
      reportHtml = `<div style="padding:20px;"><h2>${session_mode || 'Session'} Report</h2><p>${analyses[0].text}</p></div>`;
    }

    // Extract title from HTML
    const titleMatch = reportHtml.match(/<h[12][^>]*>(.*?)<\/h[12]>/i);
    const reportTitle = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : 'Session Report';

    // Save to DB
    await supabase.from('conversation_outputs')
      .update({
        title: reportTitle.slice(0, 120),
        report_status: 'done',
        report_progress: 100,
        report_status_detail: null,
        report_html: reportHtml,
        report_providers: analyses.map(a => a.provider),
        report_style: 'smart',
      })
      .eq('session_id', session_id);

    await supabase.from('user_sessions').update({ has_output: true }).eq('id', session_id);

    console.log(`[report] Done: ${session_id} — ${reportHtml.length} chars HTML from ${analyses.length} providers`);
    return res.status(200).json({ ok: true, status: 'done' });

  } catch (err) {
    console.error(`[report] Fatal:`, err?.message);
    await supabase.from('conversation_outputs')
      .update({ report_status: 'failed', report_progress: 100, report_status_detail: err?.message })
      .eq('session_id', session_id);
    return res.status(500).json({ error: err?.message });
  }
}
