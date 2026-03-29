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

HINWEIS ZUM TRANSCRIPT-FORMAT:
- "[user]: [chat] ..." = Text-Nachrichten die der User WÄHREND des Meetings getippt hat. Enthalten oft wichtige Fakten, Links oder Korrekturen — gleichwertig behandeln.
- "[assistant]: [chat note] ..." = Notizen die Sophie im Chat-Panel angezeigt hat (Stichpunkte etc.).

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
10. LEAN CHECK — IMMER als letzte inhaltliche Sektion generieren, eingewickelt in <div data-section="lean-check">:
    Analysiere das Gespräch und erstelle eine Lean-Analyse mit diesen Kategorien:
    - FAKTEN: Was wurde als bewiesene/validierte Tatsache genannt?
    - ANNAHMEN: Was wurde als Fakt behandelt, ist aber eigentlich eine ungeprüfte Annahme?
    - HYPOTHESEN: Welche "Wenn-Dann" Hypothesen wurden aufgestellt?
    - TESTS: Welche Tests/Experimente wurden beschlossen um Hypothesen zu prüfen?
    - SIGNAL: Was wurde als Kriterium definiert um weiterzumachen / zu stoppen / anzupassen?
    - NUR Kategorien einbauen die wirklich Inhalte haben. Leere Kategorien weglassen.
    - Wenn das Meeting keine relevanten Lean-Aspekte hat (z.B. reines Status-Update): Lean Check KOMPLETT weglassen.
    - Design: dezente Box mit border-left 3px solid #c4a882, Hintergrund #faf9f6, professionell.
    - Keine Emojis in der Lean-Analyse.
11. GESPRÄCHSPROTOKOLL — IMMER als allerletzte Sektion generieren, eingewickelt in <div data-section="full-transcript">:
    - Wörtliches Transcript aus dem Input, formatiert als Fließtext.
    - CSS: display:none als Default (wird vom Frontend bei Bedarf eingeblendet).
12. Das HTML MUSS einen <style>-Block mit @media print CSS enthalten für DIN A4 PDF-Export:
    - @page { size: A4; margin: 20mm 18mm; }
    - Sektionen: page-break-inside: avoid
    - -webkit-print-color-adjust: exact; print-color-adjust: exact

DESIGN-REGELN (WICHTIG):
- Font: system-ui, -apple-system, sans-serif
- Hauptfarbe: #2a2420 (Text), #c4a882 (Akzent, Linien, Überschriften-Deko)
- Hintergrund: #fff, Sektionen mit feinem Border (#ede8e2) oder dezenter Hintergrund (#faf9f6)
- Header: Titel groß (24px), Metadaten (Datum, Protokoll) klein darunter, kein fetter Rahmen
- Sektionen: klare Überschriften (uppercase, 11px, letter-spacing, Farbe #a09080), Inhalt 14px
- Tagesordnungspunkte: nummeriert, klare Trennung, genug Whitespace
- Action Items: mit Verantwortlichem und Frist falls genannt
- Gesamteindruck: elegant, professionell, viel Weißraum. Wie ein Dokument von einer Premium-Beratung — nicht wie ein automatisch generiertes Formular.
- Keine Emojis im finalen Report.

${meetingTemplate ? 'Antworte NUR mit dem ausgefüllten HTML. Behalte das exakte Design bei.' : 'Antworte NUR mit sauberem HTML (inline CSS). Kein Markdown, kein Codezaun.'}`;

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
    // SALESPITCH DIRECT PATH — Single strong AI scores the pitch honestly
    // Template-filling via generic path produces fake scores. This path
    // evaluates the actual pitch content and generates real HTML.
    // ══════════════════════════════════════════════════════════════════
    if (session_mode === 'salespitch') {
      console.log(`[report] ${session_id} — SALESPITCH DIRECT PATH (single AI)`);

      await supabase.from('conversation_outputs')
        .update({ report_progress: 30, report_status_detail: 'Bewerte Pitch...' })
        .eq('session_id', session_id);

      // Load previous pitch data for version comparison (if exists)
      let prevPitchContext = '';
      try {
        const { data: sess } = await supabase.from('user_sessions').select('user_id').eq('id', session_id).maybeSingle();
        if (sess?.user_id) {
          // Find the most recent PREVIOUS pitch (exclude current session)
          const { data: prevPitches } = await supabase.from('sophie_pitch_memory')
            .select('topic, score, scores_content, scores_delivery, strengths, weaknesses, version, created_at')
            .eq('user_id', sess.user_id)
            .neq('conversation_id', session_id)
            .order('created_at', { ascending: false })
            .limit(1);

          if (prevPitches?.length) {
            const prev = prevPitches[0];
            const pc = prev.scores_content || {};
            const pd = prev.scores_delivery || {};
            prevPitchContext = `\n\nVORHERIGER PITCH (v${prev.version || 1}) — "${prev.topic}":
Overall Score: ${prev.score || 0}/100
Content Scores: clarity=${pc.clarity||0}, problem_sharpness=${pc.problem_sharpness||0}, value_proposition=${pc.value_proposition||pc.value_prop||0}, structure=${pc.structure||0}, differentiation=${pc.differentiation||0}, credibility=${pc.credibility||0}, audience_fit=${pc.audience_fit||0}
Delivery Scores: opening=${pd.opening||0}, closing=${pd.closing||0}, voice_rhythm=${pd.voice_rhythm||0}, rhetoric_language=${pd.rhetoric_language||0}, authenticity=${pd.authenticity||0}, persuasiveness=${pd.persuasiveness||0}

WICHTIG — VERGLEICH IM SCORE-BAR:
Dies ist ein Folge-Pitch. Für JEDES Kriterium hast du den vorherigen Score oben.
Verwende das VERGLEICHS-BAR-DESIGN (siehe HTML-Vorlage unten) statt der einfachen Bars.
Jeder Score-Balken zeigt: Ghost-Bar (alter Score, halbtransparent) + neuer Balken + Delta-Badge.
Das Delta-Badge zeigt die Veränderung: grün ▲ +X.X bei Verbesserung, rot ▼ -X.X bei Verschlechterung, grau ● bei gleich.\n`;
          }
        }
      } catch (e) { console.error('[report] prev pitch load failed:', e?.message); }

      console.log(`[report] ${session_id} — prevPitchContext: ${prevPitchContext ? `FOUND (${prevPitchContext.length} chars)` : 'NONE (first pitch)'}`);

      const pitchPrompt = `Du bist ein STRENGER, EHRLICHER Pitch-Evaluator. Du bewertest einen Sales Pitch aus einem Voice-Transcript.

WICHTIG — STRENGE BEWERTUNG:
- Score 1 = schwach, unvollständig, unklar
- Score 2 = erkennbarer Ansatz, aber große Lücken
- Score 3 = solide Basis, aber Verbesserungspotenzial
- Score 4 = gut, nur Feinschliff nötig
- Score 5 = exzellent, kaum zu verbessern
- Ein kurzer, unvollständiger Pitch bekommt NIEDRIGE Scores (1-2). Sei NICHT nachsichtig.
- Wenn der Pitch nur ein Satz war oder abgebrochen wurde: ALLE Scores auf 1-2 setzen.
- Ein Score von 4+ erfordert nachweisbare Substanz im Transcript.

BEWERTUNGSKRITERIEN — 13 Kriterien in 2 Gruppen:

CONTENT (60%):
01 Clarity (12%) — Sofortverständnis: Angebot, Zielgruppe, Relevanz
02 Problem Sharpness (10%) — Problem real, klar, konkret, wichtig genug
03 Value Proposition (12%) — Nutzen klar, spezifisch, glaubwürdig
04 Structure (8%) — Aufbau, roter Faden, 3-5 Hauptpunkte
05 Differentiation (8%) — Einzigartigkeit erkennbar
06 Credibility (5%) — Substanz, Belege, keine leeren Claims
07 Audience Fit (5%) — Inhalt passt zum Publikum

DELIVERY (40%):
08 Opening (8%) — Hook, sofortige Relevanz
09 Closing (7%) — Zusammenfassung, CTA
10 Voice & Rhythm (8%) — Tempo, Pausen, Variation
11 Rhetoric & Language (7%) — Kurze Sätze, Bilder, keine Füllwörter
12 Authenticity (5%) — Eigene Stimme, echte Überzeugung
13 Persuasiveness (5%) — Handlungsimpuls, bleibt im Gedächtnis

CONFIDENCE:
- Voice-Input: alle Kriterien "high confidence"
- Text-Input (kein Audio): Voice & Rhythm + Authenticity = "low confidence", Rhetoric = "medium"

BERECHNUNG:
- Content Score = gewichteter Durchschnitt der 7 Content-Kriterien
- Delivery Score = gewichteter Durchschnitt der 6 Delivery-Kriterien
- Overall = (Content Score × 0.6) + (Delivery Score × 0.4)

${prevPitchContext}
TRANSCRIPT:
${transcript_text}

AUFGABE:
Erstelle den kompletten Sales Pitch Report als HTML. Verwende das EXAKTE Design unten.
Ersetze ALLE Platzhalter mit echten Werten aus deiner Bewertung.
Jeder Score-Balken muss die korrekte Breite haben (Score/5 × 100 = Prozent).
Farben: >= 4.0 = #22c55e (grün), 2.5-3.9 = #eab308 (gelb), < 2.5 = #ef4444 (rot).
${prevPitchContext ? `WICHTIG: Dies ist ein FOLGE-PITCH. Du MUSST das Vergleichs-Bar-Design verwenden (Ghost-Bar + Delta-Badge) für JEDES Kriterium. Ohne Vergleich ist der Report UNVOLLSTÄNDIG.` : ''}
Schreibe in der gleichen Sprache wie das Transcript.
Antworte NUR mit HTML. Kein Markdown, kein Text davor/danach.

HTML-STRUKTUR (Design EXAKT beibehalten, nur Werte + Texte ersetzen):
<div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:700px;margin:0 auto;padding:40px 0;color:#1a1a1a;line-height:1.6;">
  <div style="text-align:center;margin-bottom:36px;">
    <div style="display:inline-block;background:#111;color:#fff;font-size:10px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;padding:6px 16px;border-radius:20px;margin-bottom:12px;">Score Card</div>
    <h1 style="font-size:26px;font-weight:700;color:#111;margin:8px 0 4px;letter-spacing:-0.02em;">[PITCH THEMA]</h1>
    <div style="font-size:14px;color:#888;">${todayDate} · [pitch_type] · Confidence: [level]</div>
  </div>
  <div style="background:#f8f8f8;border-radius:16px;padding:28px;margin-bottom:28px;">
    <div style="text-align:center;margin-bottom:24px;">
      <div style="font-size:48px;font-weight:800;color:#111;letter-spacing:-0.03em;">[OVERALL]</div>
      <div style="font-size:12px;color:#888;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;">Overall Score</div>
      <!-- WENN Vergleich: zeige Delta unter Overall Score -->
      <!-- <div style="font-size:14px;font-weight:600;margin-top:4px;color:[grün/rot];">▲ +0.4 vs. v[N-1]</div> -->
    </div>
    <div style="font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#888;margin:20px 0 12px;padding-bottom:6px;border-bottom:1px solid #e5e5e5;">Content (60%)</div>
    <!-- FÜR JEDES Content-Kriterium — WENN kein Vergleich (erster Pitch): -->
    <div style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
        <span style="font-size:13px;font-weight:500;color:#333;">[Kriterium]</span>
        <span style="font-size:13px;font-weight:700;color:#111;">[X.X] / 5</span>
      </div>
      <div style="height:8px;background:#e5e5e5;border-radius:4px;overflow:hidden;">
        <div style="height:100%;width:[PROZENT]%;background:[FARBE];border-radius:4px;"></div>
      </div>
      <div style="font-size:12px;color:#888;margin-top:2px;">[1-Satz Begründung]</div>
    </div>
    <!-- WENN Vergleich vorhanden (Folge-Pitch) — verwende DIESES Design stattdessen: -->
    <!-- Ghost-Bar = alter Score halbtransparent, neuer Balken darüber, Delta-Badge rechts -->
    <div style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <span style="font-size:13px;font-weight:500;color:#333;">[Kriterium]</span>
        <span style="display:flex;align-items:center;gap:6px;">
          <span style="font-size:13px;font-weight:700;color:#111;">[NEU X.X] / 5</span>
          <!-- Delta-Badge: grün bei Verbesserung, rot bei Verschlechterung, grau bei gleich -->
          <span style="font-size:10px;font-weight:700;padding:2px 6px;border-radius:8px;background:[DELTA_BG];color:[DELTA_COLOR];">[▲+0.5 oder ▼-0.3 oder ●]</span>
        </span>
      </div>
      <div style="position:relative;height:12px;background:#e5e5e5;border-radius:4px;overflow:hidden;">
        <!-- Ghost-Bar: vorheriger Score (halbtransparent, gestreift) -->
        <div style="position:absolute;top:0;left:0;height:100%;width:[ALT_PROZENT]%;background:repeating-linear-gradient(90deg,[ALT_FARBE]33 0,transparent 0,transparent 3px,[ALT_FARBE]33 3px,[ALT_FARBE]33 6px);border-radius:4px;"></div>
        <!-- Neuer Score-Balken (solid, darüber) -->
        <div style="position:relative;height:100%;width:[NEU_PROZENT]%;background:[NEU_FARBE];border-radius:4px;"></div>
      </div>
      <div style="font-size:12px;color:#888;margin-top:2px;">[1-Satz Begründung]</div>
    </div>
    <!-- DELTA-BADGE Farben: Verbesserung (>=+0.3): background:rgba(34,197,94,.12) color:#22c55e -->
    <!-- Verschlechterung (<=-0.3): background:rgba(239,68,68,.12) color:#ef4444 -->
    <!-- Gleich: background:rgba(0,0,0,.06) color:#999 -->
    <div style="text-align:right;font-size:13px;font-weight:600;color:#555;margin:14px 0 20px;">Content Score: [X.X] / 5.0</div>

    <div style="font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#888;margin:0 0 12px;padding-bottom:6px;border-bottom:1px solid #e5e5e5;">Delivery (40%)</div>
    <!-- FÜR JEDES Delivery-Kriterium (gleiche Struktur wie Content): -->
    <!-- Bei low-confidence Kriterien: * nach dem Namen + kursiver Hinweis -->
    <div style="text-align:right;font-size:13px;font-weight:600;color:#555;margin-top:14px;">Delivery Score: [X.X] / 5.0</div>
    <div style="margin-top:8px;font-size:11px;color:#aaa;font-style:italic;">[NUR bei Text-Pitch: "* Textbasiert — Confidence: low. Für vollständige Bewertung: Voice-Modus nutzen."]</div>
  </div>

  <!-- OVERALL VERDICT: 2-4 Sätze, direkt und ehrlich -->
  <div style="background:#faf9f6;border-left:3px solid #c4a882;border-radius:8px;padding:20px;margin-bottom:28px;">
    <div style="font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#a09080;margin-bottom:8px;">Verdict</div>
    <div style="font-size:15px;color:#333;line-height:1.7;">[2-4 Sätze Gesamtbewertung — ehrlich, direkt, kein Schönreden]</div>
  </div>

  <!-- STÄRKEN (grüne Boxen) -->
  <div style="margin-bottom:28px;">
    <div style="font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#111;margin:0 0 14px;">Stärken</div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      <div style="padding:12px 16px;background:#f0fdf4;border-radius:10px;border-left:3px solid #22c55e;font-size:14px;color:#333;">[Stärke — nur wenn wirklich vorhanden]</div>
    </div>
  </div>

  <!-- SCHWÄCHEN (gelbe/rote Boxen) -->
  <div style="margin-bottom:28px;">
    <div style="font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#111;margin:0 0 14px;">Schwächen</div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      <div style="padding:12px 16px;background:#fffbeb;border-radius:10px;border-left:3px solid #eab308;font-size:14px;color:#333;">[Schwäche — konkret und spezifisch]</div>
    </div>
  </div>

  <!-- TOP 3 PRIORITÄTEN (schwarze Box) -->
  <div style="background:#111;border-radius:14px;padding:24px;margin-bottom:28px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#888;margin-bottom:8px;">Nächste Schritte</div>
    <div style="font-size:16px;color:#fff;line-height:1.7;">[Top 3 Verbesserungen für den nächsten Versuch]</div>
  </div>

  <div style="margin-top:40px;padding-top:16px;border-top:1px solid #eee;font-size:11px;color:#bbb;text-align:center;">Erstellt mit Sophie · meet-sophie.com</div>
</div>`;

      const pitchSynthProviders = [
        { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        { provider: 'openai', model: 'gpt-4o' },
      ];

      let reportHtml = null;
      for (const synth of pitchSynthProviders) {
        try {
          const adapter = getAdapter(synth.provider);
          const response = await adapter.complete({
            messages: [{ role: 'user', content: pitchPrompt }],
            model: synth.model, maxTokens: 6000, temperature: 0.2,
          });
          const text = (response.content || '').trim();
          reportHtml = text.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim();
          if (reportHtml.length > 100) {
            console.log(`[report] ${session_id} — salespitch report via ${synth.provider} (${reportHtml.length} chars)`);
            break;
          }
          reportHtml = null;
        } catch (e) {
          console.error(`[report] salespitch ${synth.provider} failed:`, e?.message);
        }
      }

      if (reportHtml) {
        await supabase.from('conversation_outputs')
          .update({ report_progress: 80, report_status_detail: 'Speichere Report...' })
          .eq('session_id', session_id);

        const titleMatch = reportHtml.match(/<(?:h1|h2)[^>]*>([^<]+)/i);
        const reportTitle = titleMatch ? titleMatch[1].trim().slice(0, 120) : 'Sales Pitch Report';
        const { error: saveErr } = await supabase.from('conversation_outputs').update({
          report_html: reportHtml,
          report_status: 'done',
          report_progress: 100,
          title: reportTitle,
          report_providers: ['salespitch-direct'],
          report_style: 'salespitch',
          report_status_detail: null,
        }).eq('session_id', session_id);
        if (saveErr) console.error(`[report] salespitch DB save failed:`, saveErr.message);

        await supabase.from('user_sessions').update({ has_output: true }).eq('id', session_id);
        console.log(`[report] Salespitch done: ${session_id} — ${reportHtml.length} chars HTML`);

        // ── Extract structured scores and save to sophie_pitch_memory ──
        try {
          const { data: sess } = await supabase.from('user_sessions').select('user_id').eq('id', session_id).maybeSingle();
          if (sess?.user_id) {
            const extractAdapter = getAdapter('openai');
            const extractResp = await extractAdapter.complete({
              messages: [{ role: 'user', content: `Extract structured pitch scores from this HTML report.

${reportHtml.slice(0, 10000)}

Return ONLY JSON:
{
  "pitch_topic": "string",
  "pitch_type": "sales|investor|keynote|internal|self|other",
  "audience_type": "string",
  "goal_type": "buy|invest|approve|trust|understand|remember|decide",
  "scores_content": {"clarity":0,"problem_sharpness":0,"value_proposition":0,"structure":0,"differentiation":0,"credibility":0,"audience_fit":0},
  "scores_delivery": {"opening":0,"closing":0,"voice_rhythm":0,"rhetoric_language":0,"authenticity":0,"persuasiveness":0},
  "overall_score": 0.0,
  "confidence_level": "low|medium|high",
  "strengths": ["..."],
  "weaknesses": ["..."]
}
Scores are 1.0-5.0. Extract exact values from the report.` }],
              model: 'gpt-4o-mini', maxTokens: 800, temperature: 0.1,
            });
            const jsonText = (extractResp.content || '').replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
            const pitchData = JSON.parse(jsonText);

            const { data: prevPitch } = await supabase.from('sophie_pitch_memory')
              .select('id, version')
              .eq('user_id', sess.user_id)
              .eq('topic', pitchData.pitch_topic || reportTitle)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle();

            const pitchRow = {
              user_id: sess.user_id,
              conversation_id: session_id,
              topic: pitchData.pitch_topic || reportTitle,
              target_audience: pitchData.audience_type || null,
              pitch_type: pitchData.pitch_type || 'other',
              goal_type: pitchData.goal_type || null,
              score: Math.round((pitchData.overall_score || 0) * 20),
              scores_content: pitchData.scores_content || null,
              scores_delivery: pitchData.scores_delivery || null,
              strengths: pitchData.strengths || [],
              weaknesses: pitchData.weaknesses || [],
              recurring_errors: [],
              critical_objections: [],
              version: prevPitch ? (prevPitch.version || 1) + 1 : 1,
              parent_pitch_id: prevPitch?.id || null,
            };

            const { error: pitchErr } = await supabase.from('sophie_pitch_memory').insert(pitchRow);
            if (pitchErr) console.error(`[report] pitch memory save failed:`, pitchErr.message);
            else console.log(`[report] Pitch memory saved: topic="${pitchRow.topic}", type=${pitchRow.pitch_type}, score=${pitchRow.score}, v${pitchRow.version}`);
          }
        } catch (pitchMemErr) {
          console.error(`[report] pitch memory extraction failed (non-critical):`, pitchMemErr?.message);
        }
      } else {
        await supabase.from('conversation_outputs').update({
          report_status: 'failed', report_progress: 100,
          report_status_detail: 'Sales Pitch Report Generation fehlgeschlagen',
        }).eq('session_id', session_id);
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

HINWEIS ZUM TRANSCRIPT-FORMAT:
- Zeilen mit "[user]: [chat] ..." sind Text-Nachrichten die der User WÄHREND des Voice-Gesprächs getippt hat (parallel zum Sprechen). Diese enthalten oft wichtige Fakten, Links oder Anweisungen — behandle sie gleichwertig.
- Zeilen mit "[assistant]: [chat note] ..." sind kurze Notizen die Sophie dem User im Chat-Panel gezeigt hat (z.B. Stichpunkte, Zusammenfassungen). Diese zeigen was Sophie als besonders wichtig hervorgehoben hat.

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

    // Replace unfilled placeholders with real data
    reportHtml = reportHtml
      .replace(/\[Datum\]/g, todayDate)
      .replace(/\[X\] Ideen gesammelt/g, '')
      .replace(/\[X\] AIs/g, `${analyses.length} AIs`);

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
