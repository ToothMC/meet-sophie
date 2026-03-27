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
${modeHint} Erfinde NICHTS. Schreibe in der Sprache des Transcripts.

WICHTIG: Beginne deine Antwort mit GENAU EINER dieser Zeilen:
[TYPE:DESIGN] — wenn das Gespräch hauptsächlich darum geht, wie ein Dokument/Report/Template aussehen soll (Layout, Farben, Format, Stil)
[TYPE:CONTENT] — wenn es ein normales Gespräch ist (Meeting, Brainstorm, Beratung, Diskussion, etc.)

Danach folgt deine Analyse.`;

    // Run all 4 analyses in parallel for speed
    await supabase.from('conversation_outputs')
      .update({ report_progress: 10, report_status_detail: 'Analysiere mit 4 KIs parallel...' })
      .eq('session_id', session_id);

    const analysisResults = await Promise.allSettled(
      REPORT_PROVIDERS.map(async ({ provider, model }) => {
        const adapter = getAdapter(provider);
        const response = await adapter.complete({
          messages: [
            { role: 'system', content: analysisPrompt },
            { role: 'user', content: `Transcript:\n${transcript_text}` },
          ],
          model, maxTokens: 2048, temperature: 0.2,
        });
        return { provider, text: response.content };
      })
    );

    const analyses = analysisResults
      .filter(r => r.status === 'fulfilled' && r.value.text)
      .map(r => r.value);

    analysisResults
      .filter(r => r.status === 'rejected')
      .forEach(r => console.error(`[report] provider failed:`, r.reason?.message));

    if (analyses.length === 0) {
      await supabase.from('conversation_outputs')
        .update({ report_status: 'failed', report_progress: 100, report_status_detail: 'Keine AI-Provider verfügbar' })
        .eq('session_id', session_id);
      return res.status(500).json({ error: 'No providers available' });
    }

    // Step 2: Load user's saved template (if any)
    let savedTemplate = null;
    try {
      const { data: sess } = await supabase
        .from('user_sessions').select('user_id').eq('id', session_id).maybeSingle();
      if (sess?.user_id) {
        const { data: profile } = await supabase
          .from('user_profile').select('report_templates').eq('id', sess.user_id).maybeSingle();
        savedTemplate = profile?.report_templates?.[session_mode || 'default'] || null;
      }
    } catch (e) {
      console.error('[report] template load failed:', e?.message);
    }

    const hasTemplate = !!savedTemplate;

    // Step 3: Generate the final HTML report
    await supabase.from('conversation_outputs')
      .update({
        report_progress: 70,
        report_status_detail: hasTemplate
          ? `Fülle Template mit ${analyses.length} Analysen...`
          : `Erstelle Report aus ${analyses.length} Analysen...`,
      })
      .eq('session_id', session_id);

    const analysesBlock = analyses
      .map(a => `[${a.provider.toUpperCase()}]:\n${a.text}`)
      .join('\n\n---\n\n');

    let htmlPrompt;
    let synthProviders;

    if (hasTemplate) {
      // ── FAST PATH: Template exists → cheap model fills in content ──
      htmlPrompt = `Du füllst ein bestehendes Report-Template mit neuem Inhalt.

Der User hat dieses HTML-Layout als Vorlage gespeichert. Behalte die EXAKTE Struktur, CSS-Styles, Farben und Design-Elemente bei.
Ersetze NUR den Textinhalt mit den Fakten aus den Analysen unten.

REGELN:
- Behalte ALLE HTML-Tags, CSS-Klassen, Styles und Struktur des Templates EXAKT bei
- NUR Fakten verwenden die mindestens 2 KIs bestätigen
- Wenn das Template Sektionen hat die für den neuen Inhalt nicht passen, entferne sie
- Wenn neue Sektionen nötig sind, erstelle sie IM SELBEN Stil wie das Template
- Schreibe in der gleichen Sprache wie die Analysen
- Antworte NUR mit dem HTML. Kein Markdown, kein Text davor/danach.

TEMPLATE:
${savedTemplate.slice(0, 4000)}

DIE ${analyses.length} ANALYSEN:

${analysesBlock}`;

      // Cheap+fast models first since this is just content injection
      synthProviders = [
        { provider: 'openai', model: 'gpt-4o-mini' },
        { provider: 'google', model: 'gemini-2.5-flash' },
        { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      ];

    } else {
      // ── CREATIVE PATH: No template → AI designs from scratch with full creative freedom ──
      // AIs classify the conversation type via [TYPE:DESIGN] or [TYPE:CONTENT] prefix
      const designVotes = analyses.filter(a => /^\[TYPE:DESIGN\]/i.test(a.text.trim())).length;
      const isDesignConversation = designVotes >= 2; // majority of AIs agree
      // Strip the type prefix from analyses for the report prompt
      for (const a of analyses) {
        a.text = a.text.replace(/^\[TYPE:(DESIGN|CONTENT)\]\s*/i, '').trim();
      }

      if (isDesignConversation) {
        // DESIGN-MODE: User discussed how a report/document should look
        // → Create an EXAMPLE document in that exact design, with placeholder content
        htmlPrompt = `Du bist ein HTML-Template-Designer.

Der User hat in einem Gespräch beschrieben, wie ein Dokument/Report aussehen soll.
${analyses.length} KIs haben die Designwünsche unabhängig analysiert.

DEINE AUFGABE:
Erstelle ein FERTIGES BEISPIEL-DOKUMENT als HTML das GENAU so aussieht wie der User es beschrieben hat.
- Verwende realistische Platzhalter-Inhalte (Beispiel-Meeting, Beispiel-Protokoll, etc.) um das Layout zu demonstrieren
- Das Ergebnis soll ein gebrauchsfertiges Template sein, KEIN Report über die Anforderungen
- Setze JEDE genannte Designanforderung 1:1 um: Farben, Schriften, Struktur, Format

BEISPIEL:
User sagt "schwarz-weiß, Meeting-Protokoll, DIN A4, professionell"
→ Du erstellst ein komplettes Meeting-Protokoll in schwarz-weiß mit Beispiel-Agenda, Beispiel-Beschlüssen, Beispiel-Action-Items. Es sieht aus wie ein echtes Dokument, nicht wie eine Zusammenfassung eines Gesprächs.

VERBOTEN:
- Keine Meta-Informationen ("der User wünscht sich...", "Anforderungen:", "Bestätigt von X KIs")
- Kein Report ÜBER das Gespräch
- Keine Analyse-Labels, keine KI-Badges

TECHNISCH:
- Reines HTML (nur <body> Inhalt, kein <html>/<head>)
- Inline CSS
- Schriftart: system font stack
- Responsive: max-width 100%, keine festen Pixel-Breiten
- Sprache: gleich wie die Analysen

Antworte NUR mit dem HTML.

DIE DESIGN-ANFORDERUNGEN AUS ${analyses.length} ANALYSEN:

${analysesBlock}`;
      } else {
        // CONTENT-MODE: Normal conversation → summarize content as report
        htmlPrompt = `Du bist ein Report-Designer.
${analyses.length} KIs haben dasselbe Gespräch unabhängig analysiert.

Erstelle einen REPORT als reines HTML (nur den <body> Inhalt, kein <html>/<head>).

Du hast völlige kreative Freiheit beim Design. Keine vorgegebenen Farben, keine vorgegebene Struktur. Gestalte passend zum Inhalt.

REGELN:
- NUR Fakten verwenden die mindestens 2 KIs bestätigen
- Der INHALT bestimmt ALLES — Form, Farben, Layout, Struktur
- Nutze moderne CSS (inline styles)
- Schriftart: system font stack
- Responsive: max-width 100%, keine festen Pixel-Breiten
- Schreibe in der gleichen Sprache wie die Analysen
- Bringe KEIN eigenes Branding mit. Starte neutral.

FORM-IDEEN (nur Inspiration):
- Routenplanung → Timeline/Stationen
- Sales Pitch → Score-Card mit Balken
- Meeting → Protokoll mit Beschlüssen + Action Items
- Brainstorm → Ideen-Cluster
- Kurzes Gespräch → Kompakte Zusammenfassung
- Entscheidung → Pro/Contra gegenübergestellt

Antworte NUR mit dem HTML. Kein Markdown, kein Text davor/danach.

DIE ${analyses.length} ANALYSEN:

${analysesBlock}`;
      }

      // Creative task needs strong model first
      synthProviders = [
        { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        { provider: 'openai', model: 'gpt-4o-mini' },
      ];
    }

    const maxTokens = hasTemplate ? 2000 : 4000;

    let reportHtml = null;
    for (const synth of synthProviders) {
      try {
        const adapter = getAdapter(synth.provider);
        const response = await adapter.complete({
          messages: [{ role: 'user', content: htmlPrompt }],
          model: synth.model, maxTokens, temperature: hasTemplate ? 0.2 : 0.4,
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

    console.log(`[report] ${hasTemplate ? 'TEMPLATE' : 'CREATIVE'} path — ${synthProviders[0].provider}/${synthProviders[0].model}, maxTokens=${maxTokens}`);

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
