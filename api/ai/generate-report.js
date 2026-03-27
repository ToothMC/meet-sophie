// api/ai/generate-report.js — Smart Report Generator
// Uses system templates as defaults, user templates override.
import { createClient } from '@supabase/supabase-js';
import { getAdapter } from '../../lib/ai/adapters/index.js';
import { DEFAULT_TEMPLATES } from '../../lib/report-templates.js';

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
    const todayDate = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const dateInstruction = `Das heutige Datum ist ${todayDate}. Wandle ALLE relativen Zeitangaben (z.B. "nächste Woche", "morgen", "in 2 Tagen", "nächsten Dienstag") in konkrete Daten im Format TT.MM.JJJJ um.`;

    // ══════════════════════════════════════════════════════════════════
    // MEETING DIRECT PATH — Skip 4-AI pipeline, single AI + transcript
    // Meetings have clear transcripts. Multi-AI consensus adds errors.
    // ══════════════════════════════════════════════════════════════════
    if (session_mode === 'meeting') {
      console.log(`[report] ${session_id} — MEETING DIRECT PATH (single AI)`);

      await supabase.from('conversation_outputs')
        .update({ report_progress: 30, report_status_detail: 'Erstelle Meeting-Protokoll...' })
        .eq('session_id', session_id);

      // Load template
      let meetingTemplate = null;
      try {
        const { data: sess } = await supabase.from('user_sessions').select('user_id').eq('id', session_id).maybeSingle();
        if (sess?.user_id) {
          const { data: profile } = await supabase.from('user_profile').select('report_templates').eq('user_id', sess.user_id).maybeSingle();
          const userTemplates = profile?.report_templates || {};
          meetingTemplate = userTemplates['meeting'] || userTemplates['default'] || null;
        }
      } catch (_) {}
      if (!meetingTemplate) {
        const { DEFAULT_TEMPLATES: DT } = await import('../../lib/report-templates.js');
        meetingTemplate = DT?.meeting || DT?.default || null;
      }

      const meetingPrompt = `Du erstellst ein Meeting-Protokoll aus einem Voice-Transcript.
${dateInstruction}

${meetingTemplate ? `TEMPLATE (Design beibehalten, nur Textinhalte ersetzen):
${meetingTemplate.slice(0, 8000)}

` : ''}TRANSCRIPT:
${transcript_text}

REGELN:
1. Protokoll/Erstellt von: IMMER "Sophie"
2. NUR Informationen verwenden die WÖRTLICH im Transcript stehen
   AUSNAHME — Häufige Spracherkennungsfehler korrigieren: "Lead Check" / "Lead-Check" → "Lean Check", "Mietsophie" / "Mietzophie" / "Meet Sofie" → "MeetSophie"
3. KLAR UNTERSCHEIDEN:
   - Metadaten DIESES Meetings (Datum, Ort, Uhrzeit) — nur wenn explizit über DIESES Meeting gesagt
   - Infos über ZUKÜNFTIGE Termine → gehören in Action Items oder "Nächster Termin", NICHT in den Header
   - "Nächstes Meeting am Mittwoch 15 Uhr in Nikosia" → Action Item, NICHT Uhrzeit/Ort dieses Meetings
4. Wenn eine Info nicht im Transcript vorkommt → Sektion KOMPLETT ENTFERNEN (nicht "[Name]" oder "—")
5. Teilnehmer: NUR namentlich Genannte. Unbekannte → Sektion entfernen
6. Uhrzeit: NUR wenn für DIESES Meeting genannt. Sonst entfernen.
7. Ort: NUR wenn für DIESES Meeting genannt. Sonst entfernen.
8. NIEMALS erfinden: keine Namen, Uhrzeiten, Orte, Rollen, Fristen
9. Leere Sektionen (keine Beschlüsse, keine Action Items) → KOMPLETT ENTFERNEN
10. LEAN CHECK — Extra Sektion VOR dem Gesprächsprotokoll, eingewickelt in <div data-section="lean-check">:
    Analysiere das Gespräch und erstelle eine Lean-Analyse mit diesen Kategorien:
    - ✅ FAKTEN: Was wurde als bewiesene/validierte Tatsache genannt? (mit Quelle/Evidenz wenn erkennbar)
    - ⚠️ ANNAHMEN: Was wurde als Fakt behandelt, ist aber eigentlich eine ungeprüfte Annahme?
    - 💡 HYPOTHESEN: Welche "Wenn-Dann" Hypothesen wurden aufgestellt?
    - 🧪 TESTS: Welche Tests/Experimente wurden beschlossen um Hypothesen zu prüfen?
    - 🚦 SIGNAL: Was wurde als Kriterium definiert um weiterzumachen / zu stoppen / anzupassen?
    - NUR Kategorien einbauen die wirklich Inhalte haben. Leere Kategorien weglassen.
    - Wenn das Meeting keine relevanten Lean-Aspekte hat (z.B. reines Status-Update): Lean Check KOMPLETT weglassen
    - Design: dezente, professionelle Box — nicht aufdringlich, aber klar lesbar
11. Das vollständige Gesprächsprotokoll (wörtliches Transcript) MUSS als letzte Sektion enthalten sein, eingewickelt in: <div data-section="full-transcript">...</div>
12. Das HTML MUSS einen <style>-Block mit @media print CSS enthalten für DIN A4 PDF-Export:
    - @page { size: A4; margin: 20mm 18mm; }
    - Sektionen: page-break-inside: avoid
    - Gesprächsprotokoll (data-section="full-transcript"): page-break-before: always
    - -webkit-print-color-adjust: exact; print-color-adjust: exact

${meetingTemplate ? 'Antworte NUR mit dem ausgefüllten HTML. Behalte das exakte Design bei.' : 'Antworte NUR mit HTML (inline CSS, system font stack, responsive). Professionelles Meeting-Protokoll-Design.'}`;

      // Use strong model — Claude first, GPT-4o fallback
      const meetingSynthProviders = [
        { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        { provider: 'openai', model: 'gpt-4o' },
      ];

      let reportHtml = null;
      for (const synth of meetingSynthProviders) {
        try {
          const adapter = getAdapter(synth.provider);
          const response = await adapter.complete({
            messages: [{ role: 'user', content: meetingPrompt }],
            model: synth.model, maxTokens: 6000, temperature: 0.15,
          });
          const text = (response.content || '').trim();
          reportHtml = text.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim();
          if (reportHtml.length > 100) {
            console.log(`[report] ${session_id} — meeting report via ${synth.provider} (${reportHtml.length} chars)`);
            break;
          }
          reportHtml = null;
        } catch (e) {
          console.error(`[report] meeting ${synth.provider} failed:`, e?.message);
        }
      }

      if (reportHtml) {
        await supabase.from('conversation_outputs')
          .update({ report_progress: 80, report_status_detail: 'Extrahiere Beschlüsse & Action Items...' })
          .eq('session_id', session_id);

        const titleMatch = reportHtml.match(/<(?:h1|h2)[^>]*>([^<]+)/i);
        const reportTitle = titleMatch ? titleMatch[1].trim().slice(0, 120) : 'Meeting Report';
        const { error: saveErr } = await supabase.from('conversation_outputs').update({
          report_html: reportHtml,
          report_status: 'done',
          report_progress: 100,
          title: reportTitle,
          report_providers: ['meeting-direct'],
          report_status_detail: null,
        }).eq('session_id', session_id);
        if (saveErr) console.error(`[report] meeting DB save failed:`, saveErr.message);

        await supabase.from('user_sessions').update({ has_output: true }).eq('id', session_id);
        console.log(`[report] Meeting done: ${session_id} — ${reportHtml.length} chars HTML`);

        // ── Extract structured data from report for Decision/Action/Open logs ──
        // Quick cheap call with GPT-4o-mini to parse the HTML report into JSON
        try {
          const extractAdapter = getAdapter('openai');
          const extractResp = await extractAdapter.complete({
            messages: [{ role: 'user', content: `Extrahiere aus diesem Meeting-Protokoll die strukturierten Daten als JSON.
${dateInstruction}

HTML-REPORT:
${reportHtml.slice(0, 10000)}

Antworte NUR mit JSON in exakt diesem Format:
{
  "short_summary": "1-2 Sätze Zusammenfassung",
  "decisions": [{"text": "...", "owner": "..."}],
  "action_items": [{"text": "...", "owner": "...", "due": "...", "status": "open"}],
  "open_points": [{"text": "..."}],
  "lean_check": {
    "facts": ["Was als validierte Tatsache genannt wurde"],
    "assumptions": ["Was als Fakt behandelt wurde aber ungeprüft ist"],
    "hypotheses": ["Wenn-Dann Hypothesen die aufgestellt wurden"],
    "tests": ["Beschlossene Tests/Experimente"],
    "signals": ["Kriterien für weitermachen/stoppen/anpassen"]
  }
}

REGELN:
- NUR was im Report steht — nichts erfinden
- "owner" nur wenn namentlich zugeordnet, sonst ""
- "due" nur wenn Datum/Frist genannt, sonst ""
- Wenn eine Kategorie leer ist: leeres Array []
- status ist immer "open" (wird später aktualisiert)
- lean_check: nur Kategorien mit Inhalt. Wenn das Meeting keine Lean-Aspekte hat, lean_check weglassen` }],
            model: 'gpt-4o-mini', maxTokens: 1500, temperature: 0.1,
          });
          const jsonText = (extractResp.content || '').replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
          const structured = JSON.parse(jsonText);

          // Find meeting_id linked to this session
          const { data: meetingRow } = await supabase.from('meetings')
            .select('id').eq('session_id', session_id).maybeSingle();

          if (meetingRow?.id) {
            const upsertData = {
              meeting_id: meetingRow.id,
              short_summary: structured.short_summary || reportTitle,
              decisions: structured.decisions || [],
              action_items: structured.action_items || [],
              open_points: structured.open_points || [],
              risks: [],
            };
            if (structured.lean_check) upsertData.lean_check = structured.lean_check;

            const { error: sumErr } = await supabase.from('meeting_summary').upsert(upsertData, { onConflict: 'meeting_id' });
            if (sumErr) console.error(`[report] structured data save failed:`, sumErr.message);
            else console.log(`[report] Structured data saved: ${(structured.decisions||[]).length} decisions, ${(structured.action_items||[]).length} actions, ${(structured.open_points||[]).length} open, lean=${!!structured.lean_check}`);

            // Also update meeting title if empty
            const { data: mtg } = await supabase.from('meetings').select('title').eq('id', meetingRow.id).maybeSingle();
            if (mtg && !mtg.title && structured.short_summary) {
              await supabase.from('meetings').update({ title: structured.short_summary.slice(0, 60) }).eq('id', meetingRow.id);
            }
          }
        } catch (extractErr) {
          console.error(`[report] structured extraction failed (non-critical):`, extractErr?.message);
          // Non-critical — report is already saved, structured data is a bonus
        }
      } else {
        const { error: failErr } = await supabase.from('conversation_outputs').update({
          report_status: 'failed', report_progress: 100,
          report_status_detail: 'Meeting-Report Generation fehlgeschlagen',
        }).eq('session_id', session_id);
        if (failErr) console.error(`[report] meeting DB fail-update failed:`, failErr.message);
      }
      return res.status(200).json({ ok: true, status: reportHtml ? 'done' : 'failed' });
    }

    // ══════════════════════════════════════════════════════════════════
    // STANDARD PATH — 4-AI parallel analysis + synthesis (Talk, Brainstorm, etc.)
    // ══════════════════════════════════════════════════════════════════

    // Step 0: Load template — User template > System template
    const mode = session_mode || 'default';
    let savedTemplate = null;
    let templateSource = 'none';
    try {
      const { data: sess } = await supabase
        .from('user_sessions').select('user_id').eq('id', session_id).maybeSingle();
      if (sess?.user_id) {
        const { data: profile } = await supabase
          .from('user_profile').select('report_templates').eq('user_id', sess.user_id).maybeSingle();
        const userTemplates = profile?.report_templates || {};
        // User template for this mode? Then for 'default'?
        if (userTemplates[mode]) { savedTemplate = userTemplates[mode]; templateSource = 'user'; }
        else if (userTemplates['default']) { savedTemplate = userTemplates['default']; templateSource = 'user-default'; }
      }
    } catch (e) {
      console.error('[report] user template load failed:', e?.message);
    }

    // Fall back to system template if no user template
    if (!savedTemplate) {
      savedTemplate = DEFAULT_TEMPLATES[mode] || DEFAULT_TEMPLATES['default'] || null;
      if (savedTemplate) templateSource = 'system';
    }

    const hasTemplate = !!savedTemplate;
    console.log(`[report] ${session_id} — template=${templateSource}, mode=${mode}, len=${savedTemplate?.length || 0}`);

    // Step 1: All 4 AIs analyze the transcript (content only, no design classification if template exists)
    const structuredAnalysisInstructions = `Analysiere dieses Gespräch STRUKTURIERT. ${dateInstruction}
${modeHint}

Antworte in der Sprache des Transcripts mit EXAKT diesen Sektionen:

TITEL: [1 Satz — worum ging es]
TEILNEHMER: [Nur Namen die EXPLIZIT im Gespräch genannt werden. Wenn keine Namen fallen: "Nicht genannt"]
BESPROCHENE THEMEN:
- [Thema 1]: [Was dazu gesagt wurde]
- [Thema 2]: [Was dazu gesagt wurde]
BESCHLÜSSE:
- [Nur wenn explizit beschlossen/entschieden wurde, mit exaktem Wortlaut]
ACTION ITEMS:
- [Aufgabe] → [Verantwortlicher, nur wenn genannt] → [Frist, nur wenn genannt]
NÄCHSTES MEETING: [Datum, Uhrzeit, Ort — NUR wenn explizit genannt. Sonst: "Nicht vereinbart"]
OFFENE PUNKTE:
- [Themen die offen blieben]

KRITISCHE REGELN:
- Schreibe NUR was WÖRTLICH gesagt wurde. Erfinde NICHTS.
- Unterscheide klar: Infos über DIESES Meeting vs. Infos über ZUKÜNFTIGE Meetings/Termine
- "Nächstes Meeting am Mittwoch 15 Uhr" ist NICHT die Uhrzeit dieses Meetings — es ist ein zukünftiger Termin
- Wenn etwas nicht gesagt wurde, schreibe "Nicht genannt" — NIEMALS erfinden
- Keine Interpretation, keine Annahmen, keine Schlussfolgerungen`;

    const analysisPrompt = hasTemplate
      ? structuredAnalysisInstructions
      : `${structuredAnalysisInstructions}

ZUSÄTZLICH: Beginne deine Antwort mit GENAU EINER dieser Zeilen:
[TYPE:DESIGN] — wenn das Gespräch hauptsächlich darum geht, wie ein Dokument/Report/Template aussehen soll
[TYPE:CONTENT] — wenn es ein normales Gespräch ist (Meeting, Brainstorm, Beratung, etc.)
Danach folgt deine strukturierte Analyse.`;

    // Run all 4 analyses in parallel for speed
    await supabase.from('conversation_outputs')
      .update({ report_progress: 10, report_status_detail: hasTemplate ? 'Analysiere Inhalt...' : 'Analysiere mit 4 KIs parallel...' })
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
      // Pass full template (up to 8000 chars to stay within context limits)
      const templateHtml = savedTemplate.length > 8000 ? savedTemplate.slice(0, 8000) : savedTemplate;

      htmlPrompt = `Du füllst ein bestehendes Report-Template mit neuem Inhalt.

Der User hat dieses HTML-Layout als SEINE Vorlage gespeichert. Das Design ist HEILIG — ändere es NICHT.

AUFGABE:
1. Behalte die EXAKTE HTML-Struktur, ALLE CSS-Styles, Farben, Schriften und Design-Elemente bei
2. Ersetze NUR die Textinhalte (Platzhalter, Beispiel-Texte) mit den echten Fakten aus den Analysen
3. Passe die Anzahl der Sektionen/Zeilen an den tatsächlichen Inhalt an (mehr oder weniger Rows je nach Bedarf)
4. Neue Sektionen: im EXAKT SELBEN Stil wie bestehende Sektionen im Template
5. Sprache: gleich wie die Analysen
6. "Protokoll" ist IMMER "Sophie" (die KI-Assistentin die das Meeting protokolliert hat)

KRITISCH — ZUORDNUNG:
- Die Analysen haben eine klare Struktur (TITEL, TEILNEHMER, BESCHLÜSSE, NÄCHSTES MEETING, etc.)
- "NÄCHSTES MEETING" Infos (Datum, Uhrzeit, Ort) sind NICHT die Metadaten dieses Meetings!
  → Sie gehören in die Action Items oder einen eigenen Abschnitt "Nächster Termin"
- "Uhrzeit" im Template-Header: NUR verwenden wenn die Analysen eine Uhrzeit für DIESES Meeting nennen
- "Ort" im Template-Header: NUR verwenden wenn die Analysen einen Ort für DIESES Meeting nennen

KRITISCH — NICHT HALLUZINIEREN:
- Wenn eine Information NICHT in den Analysen steht, ENTFERNE die Sektion komplett aus dem HTML
- KEINE erfundenen Namen, Uhrzeiten, Orte, Rollen oder Fristen
- Wenn keine Teilnehmer namentlich genannt werden: Sektion "Teilnehmer" ENTFERNEN
- Wenn keine Uhrzeit für DIESES Meeting genannt wird: "Uhrzeit" Feld ENTFERNEN
- Wenn keine Beschlüsse gefasst wurden: "Beschlüsse" Sektion ENTFERNEN
- Wenn keine Action Items existieren: "Action Items" Sektion ENTFERNEN
- NIEMALS Platzhalter wie [Name], [Rolle], [00:00], — oder "Nicht spezifiziert" im Output
- Lieber eine Sektion weglassen als sie mit erfundenen Daten füllen

VERBOTEN:
- Design ändern
- Farben ändern
- Schriften ändern
- Layout-Struktur ändern
- Eigene Design-Elemente hinzufügen
- Inhalte erfinden die nicht im Transcript stehen

Antworte NUR mit dem HTML. Kein Markdown, kein Text davor/danach.

DAS TEMPLATE DES USERS:
${templateHtml}

DIE ${analyses.length} ANALYSEN (NUR INHALT):

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
${dateInstruction}

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
- "Protokoll" / "Erstellt von" ist IMMER "Sophie"

KRITISCH — NICHT HALLUZINIEREN:
- Wenn eine Information NICHT in den Analysen steht, LASSE SIE WEG
- KEINE erfundenen Namen, Uhrzeiten, Orte, Rollen oder Fristen
- KEINE Platzhalter wie [Name], [Rolle], —, "Nicht spezifiziert"
- Nur Sektionen einbauen für die es echte Inhalte gibt
- Lieber einen kürzeren Report als einen mit erfundenen Daten

FORM-IDEEN (nur Inspiration):
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

    const maxTokens = hasTemplate ? 4000 : 4000;

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
