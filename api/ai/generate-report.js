// api/ai/generate-report.js — Async Report Generator
// Called after session ends. Queries all AI providers, synthesizes the best report.
// Stores progress + result in conversation_outputs table.
import { createClient } from '@supabase/supabase-js';
import { getAdapter } from '../../lib/ai/adapters/index.js';

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

  // Mark report as generating
  await supabase.from('conversation_outputs')
    .update({ report_status: 'generating', report_progress: 5 })
    .eq('session_id', session_id);

  // Respond immediately — processing happens after
  res.status(202).json({ ok: true, status: 'generating' });

  // === ASYNC PROCESSING (after response sent) ===
  try {
    const modeHint = session_mode ? `\nDer Session-Modus war: "${session_mode}". Berücksichtige das bei deiner Analyse.` : '';

    const analysisPrompt = `Analysiere dieses Gesprächs-Transcript. Extrahiere ALLES was relevant ist.
Keine starre Vorlage — extrahiere was DA ist:
- Wenn Scores/Bewertungen vorkommen → extrahiere sie mit Zahlen
- Wenn Teilnehmer erkennbar → nenne sie
- Wenn Entscheidungen getroffen wurden → liste sie
- Wenn Action Items besprochen wurden → mit Owner und Deadline
- Wenn es ein Pitch war → bewerte Kriterien wie Clarity, Value Proposition etc. mit Score 0-5
- Wenn es ein Meeting war → Agenda, Beschlüsse, Protokoll
- Wenn es ein kurzes Gespräch war → kurze Zusammenfassung reicht
Antworte als freies JSON-Objekt. Nutze die Felder die PASSEN. Erfinde NICHTS.${modeHint}
Schreibe in der GLEICHEN Sprache wie das Transcript.`;

    // Step 1: Query all providers SEQUENTIALLY (no timeout pressure)
    const analyses = [];
    for (let i = 0; i < REPORT_PROVIDERS.length; i++) {
      const { provider, model } = REPORT_PROVIDERS[i];
      const progress = 10 + Math.round((i / REPORT_PROVIDERS.length) * 50);
      await supabase.from('conversation_outputs')
        .update({ report_progress: progress, report_status_detail: `Analysiere mit ${provider}...` })
        .eq('session_id', session_id);

      try {
        const adapter = getAdapter(provider);
        const response = await adapter.complete({
          messages: [
            { role: 'system', content: analysisPrompt },
            { role: 'user', content: `Transcript:\n${transcript_text}` },
          ],
          model,
          maxTokens: 2048,
          temperature: 0.2,
        });
        const text = response.content || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            analyses.push({ provider, data: JSON.parse(jsonMatch[0]) });
          } catch { console.error(`[report] ${provider} bad JSON`); }
        }
      } catch (e) {
        console.error(`[report] ${provider} failed:`, e?.message);
      }
    }

    if (analyses.length === 0) {
      await supabase.from('conversation_outputs')
        .update({
          report_status: 'failed',
          report_progress: 100,
          report_status_detail: 'Keine AI-Provider verfügbar',
        })
        .eq('session_id', session_id);
      return;
    }

    // Step 2: Synthesis with Claude Sonnet
    await supabase.from('conversation_outputs')
      .update({ report_progress: 70, report_status_detail: `Synthese aus ${analyses.length} Analysen...` })
      .eq('session_id', session_id);

    const analysesBlock = analyses
      .map(a => `[${a.provider.toUpperCase()}]:\n${JSON.stringify(a.data, null, 2)}`)
      .join('\n\n---\n\n');

    const synthesisPrompt = `Du bist ein Premium Report-Designer für eine hochintelligente KI namens Sophie.
${analyses.length} KIs haben dasselbe Gespräch unabhängig analysiert. Erstelle den BESTEN Report.

DESIGN-PRINZIPIEN:
- Modern, elegant, visuell ansprechend — der User soll merken dass er mit einer intelligenten KI arbeitet
- NUR Informationen die von mindestens 2 KIs bestätigt werden (Confidence-Check gegen Halluzinationen)
- Der Inhalt bestimmt die Form — wähle frei welche Blöcke passen
- Wenn es ein kurzes Gespräch war → kurzer Report. Keine künstliche Tiefe
- Schreibe in der gleichen Sprache wie die Analysen

KONSISTENZ-LEITPLANKEN (damit wiederholte Sessions vergleichbar bleiben):
- SALES PITCH → IMMER Scorecard mit diesen 8 Kriterien: Clarity, Problem Sharpness, Value Proposition, Differentiation, Credibility, Audience Fit, Objection Handling, Persuasiveness (Score 0-5). Plus: Stärken, Schwächen, Overall Score.
- MEETING → IMMER: Agenda/Themen → Beschlüsse → Action Items (mit Owner + Deadline) → Offene Punkte.
- BRAINSTORM → IMMER: Ideen-Cluster → Favoriten → Nächste Schritte.
- REFLEXION/COACHING → Frei, aber Erkenntnisse und offene Fragen sollten dabei sein.
- CASUAL/KURZ → Kompakte Zusammenfassung, keine erzwungene Tiefe.

VERFÜGBARE BLOCK-TYPEN (nutze NUR was zum Inhalt passt):
{"type":"title","text":"...","subtitle":"..."} — Titel
{"type":"metadata","date":"...","duration":"...","mood":"..."} — Kontext-Pills
{"type":"summary","text":"..."} — Zusammenfassung
{"type":"highlights","items":["..."]} — Wichtigste Punkte (visuell hervorgehoben)
{"type":"scorecard","items":[{"label":"...","score":0-5,"note":"..."}]} — Bewertung mit Scores
{"type":"decisions","items":["..."]} — Getroffene Beschlüsse
{"type":"actions","items":[{"task":"...","owner":"...","deadline":"..."}]} — Aufgaben
{"type":"participants","items":["..."]} — Teilnehmer
{"type":"insights","items":["..."]} — Erkenntnisse
{"type":"questions","items":["..."]} — Offene Fragen
{"type":"quote","text":"...","source":"..."} — Markantes Zitat

Antworte NUR mit dem JSON-Array. Kein Text davor oder danach.

DIE ${analyses.length} ANALYSEN:

${analysesBlock}`;

    let blocks = null;
    let synthesisProvider = 'anthropic';

    // Try Claude Sonnet first, then GPT-4o as fallback
    for (const synth of [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openai', model: 'gpt-4o-mini' },
    ]) {
      try {
        const adapter = getAdapter(synth.provider);
        const response = await adapter.complete({
          messages: [{ role: 'user', content: synthesisPrompt }],
          model: synth.model,
          maxTokens: 4000,
          temperature: 0.3,
        });
        const text = response.content || '';
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          blocks = JSON.parse(jsonMatch[0]);
          synthesisProvider = synth.provider;
          break;
        }
      } catch (e) {
        console.error(`[report] synthesis with ${synth.provider} failed:`, e?.message);
      }
    }

    // Step 3: If synthesis failed, build blocks from best analysis
    if (!blocks || !Array.isArray(blocks) || blocks.length === 0) {
      const best = analyses[0].data;
      blocks = [
        { type: 'title', text: best.title || 'Session Report', subtitle: '' },
        { type: 'summary', text: best.summary || '' },
      ];
      if (best.highlights?.length) blocks.push({ type: 'highlights', items: best.highlights });
      if (best.key_points?.length) blocks.push({ type: 'insights', items: best.key_points });
      if (best.scores?.length) blocks.push({ type: 'scorecard', items: best.scores });
      if (best.decisions?.length) blocks.push({ type: 'decisions', items: best.decisions });
      if (best.action_items?.length) blocks.push({ type: 'actions', items: best.action_items });
      if (best.participants?.length) blocks.push({ type: 'participants', items: best.participants });
      if (best.open_questions?.length) blocks.push({ type: 'questions', items: best.open_questions });
    }

    // Step 4: Save to DB
    await supabase.from('conversation_outputs')
      .update({
        report_status: 'done',
        report_progress: 100,
        report_status_detail: null,
        report_blocks: blocks,
        report_providers: analyses.map(a => a.provider),
        report_style: 'smart',
      })
      .eq('session_id', session_id);

    // Also update has_output flag
    await supabase.from('user_sessions')
      .update({ has_output: true })
      .eq('id', session_id);

    console.log(`[report] Done for session ${session_id}: ${blocks.length} blocks from ${analyses.length} providers, synthesized by ${synthesisProvider}`);
  } catch (err) {
    console.error(`[report] Fatal error for session ${session_id}:`, err?.message);
    await supabase.from('conversation_outputs')
      .update({
        report_status: 'failed',
        report_progress: 100,
        report_status_detail: err?.message || 'Unknown error',
      })
      .eq('session_id', session_id);
  }
}
