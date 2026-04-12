// api/ai/generate-report.js — Smart Report Generator
// Uses system templates as defaults, user templates override.
import { createClient } from '@supabase/supabase-js';
import { getAdapter } from '../../lib/ai/adapters/index.js';
import { DEFAULT_TEMPLATES, getDefaultTemplates } from '../../lib/report-templates.js';
import { trackCost } from '../../lib/ai/cost-tracker.js';

function trackAdapterCost(response, userId, routingReason) {
  if (!response?.usage || !userId) return;
  trackCost({
    userId,
    provider: response.provider || 'unknown',
    model: response.model || 'unknown',
    inputTokens: response.usage.inputTokens || 0,
    outputTokens: response.usage.outputTokens || 0,
    costUsd: response.usage.costUsd || 0,
    latencyMs: response.latencyMs || 0,
    routingReason,
  }).catch(err => console.error("Report cost tracking error:", err?.message));
}

export const config = { maxDuration: 120 };

const REPORT_PROVIDERS = [
  { provider: 'openai', model: 'gpt-4o-mini' },
  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { provider: 'google', model: 'gemini-2.5-flash' },
  { provider: 'mistral', model: 'mistral-small-latest' },
];

const ECO_REPORT_PROVIDERS = [
  { provider: 'google', model: 'gemini-2.5-flash-lite' },
  { provider: 'openai', model: 'gpt-4o-mini' },
];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const { session_id, transcript_text, session_mode } = body;
  if (!session_id || !transcript_text) return res.status(400).json({ error: 'Missing session_id or transcript_text' });

  // Determine report language: user profile (truth) > explicit param (UI lang) > fallback "en"
  // body.language comes from localStorage (UI language) and can differ from the user's
  // actual content-language preference stored in user_profile.preferred_language.
  // NOTE: preferred_language in DB is only written by memory-update.js during Talk sessions.
  // Users who only use Meeting mode may have null → hasExplicitPref = false → auto-detect from transcript.
  let reportLang = null;
  let hasExplicitPref = false; // true only when user_profile.preferred_language is non-null
  try {
    const { data: sess } = await supabase.from('user_sessions').select('user_id').eq('id', session_id).maybeSingle();
    if (sess?.user_id) {
      const { data: prof } = await supabase.from('user_profile').select('preferred_language').eq('user_id', sess.user_id).maybeSingle();
      reportLang = prof?.preferred_language || null;
      hasExplicitPref = !!prof?.preferred_language;
    }
  } catch (_) {}
  if (!reportLang) reportLang = body.language || null;
  // Supported prompt languages: de, en, fr — anything else → use English prompt + explicit language instruction
  const unsupportedLang = reportLang && !['en', 'de', 'fr'].includes(reportLang) ? reportLang : null;
  if (!reportLang || (!['en', 'de', 'fr'].includes(reportLang))) reportLang = 'en';
  const isEN = reportLang === 'en';
  const isFR = reportLang === 'fr';
  // Meeting auto-detect: if no explicit DB preference, detect language from transcript content.
  // This handles users who speak German/French in meetings but never did a Talk session that
  // would have written their preferred_language to the DB.
  const meetingAutoLang = session_mode === 'meeting' && !hasExplicitPref;
  console.log(`[report] ${session_id} — language: ${meetingAutoLang ? 'auto-detect (no explicit pref)' : reportLang}${unsupportedLang ? ` (requested: ${unsupportedLang}, using EN prompt + lang override)` : ''}`);

  // Resolve user_id for cost tracking + eco mode
  let reportUserId = null;
  let isEco = false;
  try {
    const { data: sess } = await supabase.from('user_sessions').select('user_id').eq('id', session_id).maybeSingle();
    reportUserId = sess?.user_id || null;
    if (reportUserId) {
      const { data: prof } = await supabase.from('user_profile').select('eco_mode').eq('user_id', reportUserId).maybeSingle();
      isEco = !!prof?.eco_mode;
    }
  } catch (_) {}

  // Ensure conversation_output row exists (memory-update might still be running)
  const { data: existingOutput } = await supabase
    .from('conversation_outputs')
    .select('id')
    .eq('session_id', session_id)
    .maybeSingle();

  if (!existingOutput) {
    console.log(`[report] ${session_id} — no output row yet, creating fallback`);
    await supabase.from('conversation_outputs').insert({
      session_id,
      title: 'Generating...',
      short_summary: '',
      report_status: 'generating',
      report_progress: 5,
    });
  } else {
    await supabase.from('conversation_outputs')
      .update({ report_status: 'generating', report_progress: 5 })
      .eq('session_id', session_id);
  }

  try {
    const modeHint = session_mode ? (isEN ? `Session mode: "${session_mode}".` : isFR ? `Mode de session : "${session_mode}".` : `Session-Modus: "${session_mode}".`) : '';
    const dateLocale = isEN ? 'en-US' : isFR ? 'fr-FR' : 'de-DE';
    const todayDate = new Date().toLocaleDateString(dateLocale, { day: '2-digit', month: '2-digit', year: 'numeric' });
    const todayISO = new Date().toISOString().split('T')[0]; // YYYY-MM-DD — language-neutral
    const dateInstruction = meetingAutoLang
      ? `Today's date is ${todayISO}. Convert ALL relative time references ("next week", "morgen", "nächste Woche", "demain" etc.) to concrete dates, formatted in the date style appropriate for the detected language.`
      : isEN
      ? `Today's date is ${todayDate}. Convert ALL relative time references (e.g. "next week", "tomorrow", "in 2 days") to concrete dates.`
      : isFR
      ? `La date d'aujourd'hui est le ${todayDate}. Convertir TOUTES les références temporelles relatives en dates concrètes.`
      : `Das heutige Datum ist ${todayDate}. Wandle ALLE relativen Zeitangaben (z.B. "nächste Woche", "morgen", "in 2 Tagen", "nächsten Dienstag") in konkrete Daten im Format TT.MM.JJJJ um.`;

    // ══════════════════════════════════════════════════════════════════
    // MEETING DIRECT PATH — Skip 4-AI pipeline, single AI + transcript
    // Meetings have clear transcripts. Multi-AI consensus adds errors.
    // ══════════════════════════════════════════════════════════════════
    if (session_mode === 'meeting') {
      console.log(`[report] ${session_id} — MEETING DIRECT PATH (single AI)`);

      const statusMeetingReport = isEN ? 'Creating meeting protocol...' : isFR ? 'Création du protocole...' : 'Erstelle Meeting-Protokoll...';
      await supabase.from('conversation_outputs')
        .update({ report_progress: 30, report_status_detail: statusMeetingReport })
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
        const { getDefaultTemplates: gdt } = await import('../../lib/report-templates.js');
        // For auto-detect: use 'de' as structural template (most common for this product);
        // AI will adapt section labels to the detected transcript language.
        const DT = gdt(meetingAutoLang ? 'de' : (reportLang || 'de'));
        meetingTemplate = DT?.meeting || DT?.default || null;
      }

      // ── Language-aware meeting report prompt ──────────────────────────────
      const langInstruction = meetingAutoLang
        ? 'LANGUAGE: Detect the language from the transcript content and write the ENTIRE report in that SAME language. All headings, labels, and body text must be in the detected language. Do NOT translate any content.'
        : unsupportedLang
        ? `Write the ENTIRE report in the SAME language as the transcript (detected: ${unsupportedLang}). All headings, labels, and content must be in that language.`
        : isEN ? 'Write the ENTIRE report in English.'
        : isFR ? 'Rédige le rapport ENTIER en français.'
        : 'Schreibe das gesamte Protokoll auf Deutsch.';
      const meetingPrompt = (isEN || isFR) ? `${isEN ? 'You are creating a meeting protocol from a voice transcript.' : 'Tu crées un compte rendu de réunion à partir d\'une transcription vocale.'}
${langInstruction}
${dateInstruction}

${isEN ? 'TRANSCRIPT FORMAT NOTES' : 'NOTES SUR LE FORMAT DU TRANSCRIPT'}:
- "[user]: [chat] ..." = ${isEN ? 'Text messages typed by the user DURING the meeting. Often contain important facts, links or corrections — treat equally.' : 'Messages texte tapés par l\'utilisateur PENDANT la réunion. Contiennent souvent des faits importants, liens ou corrections — traiter également.'}
- "[assistant]: [chat note] ..." = ${isEN ? 'Notes Sophie displayed in the chat panel.' : 'Notes que Sophie a affichées dans le panneau de chat.'}

${meetingTemplate ? `TEMPLATE (${isEN ? 'keep design, replace text content only' : 'garder le design, remplacer uniquement le contenu textuel'}):
${meetingTemplate.slice(0, 8000)}

` : ''}TRANSCRIPT:
${transcript_text}

${isEN ? 'RULES' : 'RÈGLES'}:
1. ${isEN ? 'Protocol/Created by: ALWAYS "Sophie"' : 'Protocole/Créé par : TOUJOURS "Sophie"'}
2. ${isEN ? 'ONLY use information that is LITERALLY in the transcript' : 'Utiliser UNIQUEMENT les informations qui sont LITTÉRALEMENT dans le transcript'}
   ${isEN ? 'EXCEPTION — Correct common speech recognition errors: "Lead Check" → "Lean Check", "Meet Sofie" → "MeetSophie"' : 'EXCEPTION — Corriger les erreurs courantes de reconnaissance vocale : "Lead Check" → "Lean Check", "Meet Sofie" → "MeetSophie"'}
3. ${isEN ? 'CLEARLY DISTINGUISH' : 'DISTINGUER CLAIREMENT'}:
   - ${isEN ? 'Metadata of THIS meeting (date, location, time) — only if explicitly stated about THIS meeting' : 'Métadonnées de CETTE réunion (date, lieu, heure) — uniquement si explicitement mentionnées pour CETTE réunion'}
   - ${isEN ? 'Info about FUTURE appointments → belongs in Action Items or "Next Meeting" section, NOT in header' : 'Infos sur les rendez-vous FUTURS → appartiennent aux Actions ou section "Prochaine réunion", PAS dans l\'en-tête'}
4. ${isEN ? 'If info is not in the transcript → REMOVE section entirely (not "[Name]" or "—")' : 'Si une info n\'est pas dans le transcript → SUPPRIMER la section entièrement (pas "[Nom]" ou "—")'}
5. ${isEN ? 'Participants: ONLY those named in [PARTICIPANTS] or transcript. Unknown → remove section' : 'Participants : UNIQUEMENT ceux nommés dans [PARTICIPANTS] ou le transcript. Inconnus → supprimer la section'}
6. ${isEN ? 'Time: ONLY if stated for THIS meeting. Otherwise remove.' : 'Heure : UNIQUEMENT si mentionnée pour CETTE réunion. Sinon supprimer.'}
7. ${isEN ? 'Location: ONLY if stated for THIS meeting. Otherwise remove.' : 'Lieu : UNIQUEMENT si mentionné pour CETTE réunion. Sinon supprimer.'}
8. ${isEN ? 'NEVER invent: no names, times, locations, roles, deadlines' : 'NE JAMAIS inventer : pas de noms, heures, lieux, rôles, échéances'}
9. ${isEN ? 'Empty sections (no decisions, no action items) → REMOVE COMPLETELY' : 'Sections vides (pas de décisions, pas d\'actions) → SUPPRIMER COMPLÈTEMENT'}
9b. ${isEN ? 'AGENDA: If [AGENDA] is in the transcript, include it as a numbered section near the top of the protocol, BEFORE the discussion content.' : 'ORDRE DU JOUR : Si [AGENDA] est dans le transcript, l\'inclure comme section numérotée près du début du protocole, AVANT le contenu de discussion.'}
9c. ${isEN ? 'GOAL/OBJECTIVE: If [GOAL] is in the transcript, include it as a short section after the header (e.g. "Meeting objective: ...").' : 'OBJECTIF : Si [GOAL] est dans le transcript, l\'inclure comme section courte après l\'en-tête (ex : "Objectif de la réunion : ...").'}
9d. ${isEN ? 'NEXT MEETING: If a next meeting date/time is mentioned, include it as a clearly labeled section (e.g. "Next meeting: Tuesday, 14.04.2026, 10:00 AM").' : 'PROCHAINE RÉUNION : Si une prochaine réunion est mentionnée, l\'inclure comme section clairement étiquetée (ex : "Prochaine réunion : mardi 14/04/2026, 10h00").'}
10. ${isEN ? 'LEAN CHECK — ALWAYS generate as last content section, wrapped in <div data-section="lean-check">' : 'LEAN CHECK — TOUJOURS générer comme dernière section de contenu, dans <div data-section="lean-check">'}:
    ${isEN ? 'Analyze the conversation and create a Lean analysis with these categories' : 'Analyser la conversation et créer une analyse Lean avec ces catégories'}:
    - ${isEN ? 'FACTS: What was stated as proven/validated fact?' : 'FAITS : Qu\'est-ce qui a été affirmé comme fait prouvé/validé ?'}
    - ${isEN ? 'ASSUMPTIONS: What was treated as fact but is actually an untested assumption?' : 'HYPOTHÈSES NON VÉRIFIÉES : Qu\'est-ce qui a été traité comme un fait mais est en réalité une hypothèse non testée ?'}
    - ${isEN ? 'HYPOTHESES: What "if-then" hypotheses were proposed?' : 'HYPOTHÈSES : Quelles hypothèses "si-alors" ont été proposées ?'}
    - ${isEN ? 'TESTS: What tests/experiments were decided to verify hypotheses?' : 'TESTS : Quels tests/expériences ont été décidés pour vérifier les hypothèses ?'}
    - ${isEN ? 'SIGNAL: What criteria were defined to continue / stop / pivot?' : 'SIGNAL : Quels critères ont été définis pour continuer / arrêter / pivoter ?'}
    - ${isEN ? 'Only include categories that have actual content. Omit empty ones.' : 'N\'inclure que les catégories ayant du contenu réel. Omettre les vides.'}
    - ${isEN ? 'If the meeting has no relevant Lean aspects (e.g. pure status update): omit Lean Check entirely.' : 'Si la réunion n\'a pas d\'aspects Lean pertinents (ex : simple mise à jour) : omettre le Lean Check entièrement.'}
    - ${isEN ? 'Design: subtle box with border-left 3px solid #c4a882, background #faf9f6, professional.' : 'Design : boîte subtile avec border-left 3px solid #c4a882, background #faf9f6, professionnel.'}
    - ${isEN ? 'No emojis in the Lean analysis.' : 'Pas d\'émojis dans l\'analyse Lean.'}
11. ${isEN ? 'FULL TRANSCRIPT — ALWAYS as the very last section, wrapped in <div data-section="full-transcript">' : 'TRANSCRIPT COMPLET — TOUJOURS comme toute dernière section, dans <div data-section="full-transcript">'}:
    - ${isEN ? 'Verbatim transcript from input, formatted as flowing text.' : 'Transcript verbatim de l\'entrée, formaté comme texte continu.'}
    - CSS: display:none ${isEN ? 'as default (frontend shows on demand).' : 'par défaut (le frontend l\'affiche à la demande).'}
12. ${isEN ? 'The HTML MUST contain a <style> block with @media print CSS for A4 PDF export' : 'Le HTML DOIT contenir un bloc <style> avec @media print CSS pour export PDF A4'}:
    - @page { size: A4; margin: 20mm 18mm; }
    - ${isEN ? 'Sections' : 'Sections'}: page-break-inside: avoid
    - -webkit-print-color-adjust: exact; print-color-adjust: exact

${isEN ? 'VISUAL DESIGN (produce a beautiful, professional document)' : 'DESIGN VISUEL (produire un document beau et professionnel)'}:
- Font: system-ui, -apple-system, sans-serif
- ${isEN ? 'Colors' : 'Couleurs'}: #2a2420 (${isEN ? 'text' : 'texte'}), #c4a882 (${isEN ? 'accent lines, heading decoration' : 'lignes d\'accent, décoration titres'}), #a09080 (${isEN ? 'section labels' : 'étiquettes sections'})
- ${isEN ? 'Background' : 'Fond'}: #fff. ${isEN ? 'Sections with fine border (#ede8e2) or subtle background (#faf9f6)' : 'Sections avec bordure fine (#ede8e2) ou fond subtil (#faf9f6)'}
- Header: ${isEN ? 'title' : 'titre'} 20px font-weight:300, border-bottom 1px solid #c4a882, ${isEN ? 'date right-aligned' : 'date alignée à droite'}
- ${isEN ? 'Section labels' : 'Étiquettes sections'}: uppercase, 9px, letter-spacing:0.2em, color:#a09080, margin-bottom:12px
- ${isEN ? 'Body text' : 'Corps texte'}: 13px, line-height:1.6, color:#333
- ${isEN ? 'Separator lines' : 'Lignes séparatrices'}: 1px solid #ede8e2 ${isEN ? 'between sections' : 'entre sections'}
- Action items: ${isEN ? 'each item with subtle bottom border' : 'chaque élément avec bordure basse subtile'}, font-size:13px
- ${isEN ? 'Overall: elegant, generous whitespace, like a premium consultancy document. NOT plain text.' : 'Global : élégant, espaces généreux, comme un document de conseil premium. PAS du texte brut.'}
- ${isEN ? 'No emojis. Every section must have styled HTML with inline CSS.' : 'Pas d\'émojis. Chaque section doit avoir du HTML stylé avec CSS inline.'}
- ${isEN ? 'Outer wrapper' : 'Wrapper externe'}: class="meeting-protocol", max-width:780px ${isEN ? 'on desktop (A4-like)' : 'sur desktop (style A4)'}, padding:48px 60px, margin:0 auto, word-break:break-word, box-shadow:0 1px 8px rgba(0,0,0,.06)
- ${isEN ? 'On mobile (<640px): padding shrinks, max-width:100%, no box-shadow' : 'Sur mobile (<640px) : padding réduit, max-width:100%, pas de box-shadow'}

${isEN ? 'CONTENT FORMATTING (follow EXACTLY — violations are unacceptable)' : 'FORMATAGE DU CONTENU (suivre EXACTEMENT — les violations sont inacceptables)'}:
- ${isEN ? 'PARTICIPANTS: Comma-separated on ONE line. NEVER vertical list.' : 'PARTICIPANTS : Séparés par virgule sur UNE ligne. JAMAIS de liste verticale.'}
- ${isEN ? 'AGENDA POINTS (discussion per topic): The FIRST agenda point may have a short text summary (2-3 sentences max).' : 'POINTS DE L\'ORDRE DU JOUR (discussion par sujet) : Le PREMIER point peut avoir un résumé textuel court (2-3 phrases max).'}
  ${isEN ? 'ALL OTHER agenda points MUST be structured as numbered sub-points (1. 2. 3.), NOT as flowing text paragraphs.' : 'TOUS LES AUTRES points DOIVENT être structurés en sous-points numérotés (1. 2. 3.), PAS en paragraphes de texte.'}
  ${isEN ? 'If someone raised a concern, made a suggestion, or stated a fact → it becomes a numbered point, not prose.' : 'Si quelqu\'un a soulevé une préoccupation, fait une suggestion ou énoncé un fait → cela devient un point numéroté, pas de la prose.'}
- ${isEN ? 'GOAL: One paragraph after header.' : 'OBJECTIF : Un paragraphe après l\'en-tête.'}
- ${isEN ? 'DECISIONS: Numbered (1. 2. 3.), each one concise sentence.' : 'DÉCISIONS : Numérotées (1. 2. 3.), chacune une phrase concise.'}
- ${isEN ? 'ACTION ITEMS: NEVER use <table>. Use a simple <div> list. Each item as ONE line' : 'ACTIONS : JAMAIS utiliser <table>. Utiliser une simple liste <div>. Chaque élément sur UNE ligne'}:
  "${isEN ? '<div style=\'padding:6px 0;border-bottom:1px solid #ede8e2;font-size:13px\'>David — Review error paths, by 11.04.2026</div>' : '<div style=\'padding:6px 0;border-bottom:1px solid #ede8e2;font-size:13px\'>David — Vérifier les cas d\'erreur, avant le 11/04/2026</div>'}"
  Format: "[${isEN ? 'Owner' : 'Responsable'}] — [${isEN ? 'Task' : 'Tâche'}], ${isEN ? 'by' : 'avant le'} [Date]"
- ${isEN ? 'OPEN POINTS: Numbered (1. 2. 3.), each one short line. NEVER text blocks.' : 'POINTS OUVERTS : Numérotés (1. 2. 3.), chacun une ligne courte. JAMAIS de blocs de texte.'}
- ${isEN ? 'NEXT MEETING: One line: "When: [Date, Time] | Where: [Location] | Who invites: [Name]"' : 'PROCHAINE RÉUNION : Une ligne : "Quand : [Date, Heure] | Où : [Lieu] | Qui invite : [Nom]"'}
- ${isEN ? 'ABSOLUTELY FORBIDDEN: <table>, <tr>, <td>, <th> tags anywhere in the report. Use <div> lists instead.' : 'ABSOLUMENT INTERDIT : balises <table>, <tr>, <td>, <th> partout dans le rapport. Utiliser des listes <div> à la place.'}
- ${isEN ? 'NEVER write flowing text paragraphs for discussion points. ALWAYS numbered lists.' : 'JAMAIS écrire de paragraphes de texte pour les points de discussion. TOUJOURS des listes numérotées.'}

RESPONSIVE:
- <style> ${isEN ? 'block MUST include' : 'bloc DOIT contenir'}:
  * { box-sizing:border-box; }
  .meeting-protocol { max-width:780px; margin:0 auto; padding:48px 60px; }
  @media(max-width:640px){ .meeting-protocol{max-width:100%!important;padding:14px!important;box-shadow:none!important;} }
  @media print {
    @page{size:A4;margin:18mm 16mm;}
    .meeting-protocol{max-width:100%!important;padding:12px 0!important;box-shadow:none!important;}
    .meeting-protocol>div{margin-bottom:16px!important;page-break-inside:avoid;}
    h1{font-size:18px!important;}
  }

${meetingTemplate ? (isEN ? 'Reply ONLY with the filled HTML. Keep the exact design.' : 'Répondre UNIQUEMENT avec le HTML rempli. Garder le design exact.') : (isEN ? 'Reply ONLY with clean HTML (inline CSS). No Markdown, no code fences.' : 'Répondre UNIQUEMENT avec du HTML propre (CSS inline). Pas de Markdown, pas de blocs de code.')}`

      : `Du erstellst ein Meeting-Protokoll aus einem Voice-Transcript.
${langInstruction}
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
9b. TAGESORDNUNG: Wenn [AGENDA] im Transcript steht, als nummerierte Sektion nahe am Anfang des Protokolls einfügen, VOR dem Gesprächsinhalt.
9c. ZIEL: Wenn [GOAL] im Transcript steht, als kurze Sektion nach dem Header einfügen (z.B. "Ziel des Meetings: ...").
9d. NÄCHSTER TERMIN: Wenn ein Folgetermin mit Datum/Uhrzeit genannt wird, als eigene Sektion einfügen (z.B. "Nächstes Meeting: Dienstag, 14.04.2026, 10:00 Uhr").
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

VISUELLES DESIGN (professionelles, elegantes Dokument):
- Font: system-ui, -apple-system, sans-serif
- Farben: #2a2420 (Text), #c4a882 (Akzentlinien, Überschriften-Deko), #a09080 (Sektionslabels)
- Hintergrund: #fff. Sektionen mit feinem Border (#ede8e2) oder dezenter Hintergrund (#faf9f6)
- Header: Titel 20px font-weight:300, border-bottom 1px solid #c4a882, Datum rechts
- Sektionslabels: uppercase, 9px, letter-spacing:0.2em, color:#a09080, margin-bottom:12px
- Body: 13px, line-height:1.6, color:#333
- Trennlinien: 1px solid #ede8e2 zwischen Sektionen
- Aufgaben: jede mit dezenter Unterlinie, font-size:13px
- Gesamteindruck: elegant, viel Weißraum, wie Premium-Beratung. KEIN reiner Text.
- Keine Emojis. Jede Sektion muss gestyltes HTML mit inline CSS haben.
- Äußerer Wrapper: class="meeting-protocol", max-width:780px (DIN A4), padding:48px 60px, margin:0 auto, box-shadow:0 1px 8px rgba(0,0,0,.06)
- Auf Mobil (<640px): padding kleiner, max-width:100%, kein box-shadow

INHALTS-FORMATIERUNG (EXAKT befolgen — Verstöße sind inakzeptabel):
- TEILNEHMER: Kommagetrennt in EINER Zeile. NIEMALS vertikale Liste.
- TAGESORDNUNGSPUNKTE (Diskussion pro Thema): Der ERSTE Punkt darf eine kurze Textzusammenfassung haben (max 2-3 Sätze).
  ALLE WEITEREN Punkte MÜSSEN als nummerierte Unterpunkte (1. 2. 3.) strukturiert sein, NICHT als Fließtext.
  Wenn jemand etwas gesagt, vorgeschlagen oder festgestellt hat → wird es ein nummerierter Punkt, kein Prosa-Absatz.
  SCHLECHT: "Anna betonte aus Produktsicht, dass Sophie offene Fragen kennen muss. David erklärte, dass die Logik serverseitig laufen soll."
  GUT: "1. Sophie muss offene Fragen und nächste Schritte kennen (Anna)\n2. Resümee-Logik serverseitig über System-Prompt (David)\n3. Start muss natürlich bleiben (Julia)"
- ZIEL: Ein Absatz nach Header.
- BESCHLÜSSE: Nummeriert (1. 2. 3.), jeder ein knapper Satz.
- AUFGABEN: NIEMALS <table> verwenden. Einfache <div>-Liste. Jede Aufgabe als EINE Zeile:
  "<div style='padding:6px 0;border-bottom:1px solid #ede8e2;font-size:13px'>David — Fehlerpfade prüfen, bis 11.04.2026</div>"
  Format: "[Wer] — [Was], bis [Wann]"
- OFFENE PUNKTE: Nummeriert (1. 2. 3.), jeder eine kurze Zeile. NIEMALS Textblöcke.
- NÄCHSTES MEETING: Eine Zeile: "Wann: [Datum, Uhrzeit] | Wo: [Ort] | Wer lädt ein: [Name]"
- ABSOLUT VERBOTEN: <table>, <tr>, <td>, <th> Tags irgendwo im Report. Stattdessen <div>-Listen verwenden.
- NIEMALS Fließtext-Absätze für Diskussionspunkte. IMMER nummerierte Listen.

RESPONSIVE:
- <style>-Block MUSS enthalten:
  * { box-sizing:border-box; }
  .meeting-protocol { max-width:780px; margin:0 auto; padding:48px 60px; }
  @media(max-width:640px){ .meeting-protocol{max-width:100%!important;padding:14px!important;box-shadow:none!important;} }
  @media print {
    @page{size:A4;margin:18mm 16mm;}
    .meeting-protocol{max-width:100%!important;padding:12px 0!important;box-shadow:none!important;}
    .meeting-protocol>div{margin-bottom:16px!important;page-break-inside:avoid;}
    h1{font-size:18px!important;}
  }

${meetingTemplate ? 'Antworte NUR mit dem ausgefüllten HTML. Behalte das exakte Design bei.' : 'Antworte NUR mit sauberem HTML (inline CSS). Kein Markdown, kein Codezaun.'}`;

      // Use strong model — Claude first, GPT-4o fallback (eco: gemini + gpt-4o-mini)
      const meetingSynthProviders = isEco ? [
        { provider: 'google', model: 'gemini-2.5-flash' },
        { provider: 'openai', model: 'gpt-4o-mini' },
      ] : [
        { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        { provider: 'openai', model: 'gpt-4o' },
      ];

      // Validate that report HTML is structurally complete (not truncated)
      function isValidReportHtml(html) {
        if (!html || html.length < 300) return false;
        // Must contain at least one closing </div> tag
        if (!html.includes('</div>')) return false;
        // Count opening vs closing div tags — truncated HTML will have more opens than closes
        const opens = (html.match(/<div[\s>]/gi) || []).length;
        const closes = (html.match(/<\/div>/gi) || []).length;
        // Allow small mismatch (some inline divs) but not massive truncation
        if (opens > 0 && closes === 0) return false;
        if (opens - closes > 3) return false;
        return true;
      }

      let reportHtml = null;
      for (const synth of meetingSynthProviders) {
        try {
          const adapter = getAdapter(synth.provider);
          const response = await adapter.complete({
            messages: [{ role: 'user', content: meetingPrompt }],
            model: synth.model, maxTokens: 6000, temperature: 0.15,
          });
          trackAdapterCost(response, reportUserId, 'report-meeting');
          const text = (response.content || '').trim();
          reportHtml = text.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim();
          if (isValidReportHtml(reportHtml)) {
            console.log(`[report] ${session_id} — meeting report via ${synth.provider} (${reportHtml.length} chars)`);
            break;
          }
          console.warn(`[report] ${session_id} — ${synth.provider} returned invalid/truncated HTML (${reportHtml.length} chars, opens=${(reportHtml.match(/<div[\s>]/gi)||[]).length}, closes=${(reportHtml.match(/<\/div>/gi)||[]).length}), trying next provider`);
          reportHtml = null;
        } catch (e) {
          console.error(`[report] meeting ${synth.provider} failed:`, e?.message);
        }
      }

      if (reportHtml) {
        await supabase.from('conversation_outputs')
          .update({ report_progress: 80, report_status_detail: isEN ? 'Extracting decisions & action items...' : isFR ? 'Extraction des décisions...' : 'Extrahiere Beschlüsse & Action Items...' })
          .eq('session_id', session_id);

        reportHtml = reportHtml.replace(/\[Datum\]/g, todayDate);
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
            messages: [{ role: 'user', content: `${isEN ? 'Extract structured data from this meeting protocol as JSON.' : isFR ? 'Extrais les données structurées de ce compte rendu de réunion en JSON.' : 'Extrahiere aus diesem Meeting-Protokoll die strukturierten Daten als JSON.'}
${dateInstruction}

HTML-REPORT:
${reportHtml.slice(0, 10000)}

${isEN ? 'Reply ONLY with JSON in exactly this format' : isFR ? 'Réponds UNIQUEMENT avec du JSON dans exactement ce format' : 'Antworte NUR mit JSON in exakt diesem Format'}:
{
  "short_summary": "${isEN ? '1-2 sentence summary' : isFR ? 'Résumé en 1-2 phrases' : '1-2 Sätze Zusammenfassung'}",
  "decisions": [{"text": "...", "owner": "..."}],
  "action_items": [{"text": "...", "owner": "...", "due": "...", "status": "open"}],
  "open_points": [{"text": "..."}],
  "next_meeting": "${isEN ? 'Next meeting as mentioned in transcript, e.g. \'Tuesday, 15.04.2026, 10:00 AM\' — or null if not mentioned' : isFR ? 'Prochaine réunion telle que mentionnée dans le transcript, ex : \'mardi 15/04/2026, 10h00\' — ou null si non mentionnée' : 'Nächster Termin wie im Transkript genannt, z.B. \'Dienstag, 15.04.2026, 10:00 Uhr\' — oder null wenn nicht genannt'}",
  "lean_check": {
    "facts": ["${isEN ? 'What was stated as validated fact' : isFR ? 'Ce qui a été affirmé comme fait validé' : 'Was als validierte Tatsache genannt wurde'}"],
    "assumptions": ["${isEN ? 'What was treated as fact but is unverified' : isFR ? 'Ce qui a été traité comme un fait mais est non vérifié' : 'Was als Fakt behandelt wurde aber ungeprüft ist'}"],
    "hypotheses": ["${isEN ? 'If-then hypotheses that were proposed' : isFR ? 'Hypothèses si-alors qui ont été proposées' : 'Wenn-Dann Hypothesen die aufgestellt wurden'}"],
    "tests": ["${isEN ? 'Decided tests/experiments' : isFR ? 'Tests/expériences décidés' : 'Beschlossene Tests/Experimente'}"],
    "signals": ["${isEN ? 'Criteria for continue/stop/pivot' : isFR ? 'Critères pour continuer/arrêter/pivoter' : 'Kriterien für weitermachen/stoppen/anpassen'}"]
  }
}

${isEN ? 'RULES' : isFR ? 'RÈGLES' : 'REGELN'}:
- ${isEN ? 'ONLY what is in the report — never invent' : isFR ? 'UNIQUEMENT ce qui est dans le rapport — ne jamais inventer' : 'NUR was im Report steht — nichts erfinden'}
- "owner" ${isEN ? 'only if assigned by name, otherwise ""' : isFR ? 'uniquement si assigné par nom, sinon ""' : 'nur wenn namentlich zugeordnet, sonst ""'}
- "due" ${isEN ? 'only if date/deadline mentioned, otherwise ""' : isFR ? 'uniquement si date/échéance mentionnée, sinon ""' : 'nur wenn Datum/Frist genannt, sonst ""'}
- ${isEN ? 'If a category is empty: empty array []' : isFR ? 'Si une catégorie est vide : tableau vide []' : 'Wenn eine Kategorie leer ist: leeres Array []'}
- status ${isEN ? 'is always "open" (updated later)' : isFR ? 'est toujours "open" (mis à jour plus tard)' : 'ist immer "open" (wird später aktualisiert)'}
- next_meeting: ${isEN ? 'Date, time and location if mentioned in transcript. Convert relative references ("next Tuesday") to absolute dates if possible. null if no meeting mentioned.' : isFR ? 'Date, heure et lieu si mentionnés dans le transcript. Convertir les références relatives ("mardi prochain") en dates absolues si possible. null si aucune réunion mentionnée.' : 'Datum, Uhrzeit und ggf. Ort wenn im Transkript genannt. Relative Angaben ("nächsten Dienstag") in absolute Daten umrechnen wenn möglich. null wenn kein Termin genannt.'}
- lean_check: ${isEN ? 'only categories with content. If the meeting has no Lean aspects, omit lean_check' : isFR ? 'uniquement les catégories avec du contenu. Si la réunion n\'a pas d\'aspects Lean, omettre lean_check' : 'nur Kategorien mit Inhalt. Wenn das Meeting keine Lean-Aspekte hat, lean_check weglassen'}` }],
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
            if (structured.next_meeting) upsertData.next_meeting = structured.next_meeting;

            const { error: sumErr } = await supabase.from('meeting_summary').upsert(upsertData, { onConflict: 'meeting_id' });
            if (sumErr) console.error(`[report] structured data save failed:`, sumErr.message);
            else console.log(`[report] Structured data saved: ${(structured.decisions||[]).length} decisions, ${(structured.action_items||[]).length} actions, ${(structured.open_points||[]).length} open, lean=${!!structured.lean_check}`);

            // Set AI-generated title ONLY if user never provided one
            // User-title is canonical — AI title goes in conversation_outputs.title only
            const { data: mtg } = await supabase.from('meetings').select('title').eq('id', meetingRow.id).maybeSingle();
            if (mtg && !mtg.title && structured.short_summary) {
              // No user title → use AI summary as fallback
              await supabase.from('meetings').update({ title: structured.short_summary.slice(0, 60) }).eq('id', meetingRow.id);
              console.log(`[report] Meeting title set (was empty): "${structured.short_summary.slice(0, 60)}"`);
            }
          }
        } catch (extractErr) {
          console.error(`[report] structured extraction failed (non-critical):`, extractErr?.message);
          // Non-critical — report is already saved, structured data is a bonus
        }
      } else {
        const { error: failErr } = await supabase.from('conversation_outputs').update({
          report_status: 'failed', report_progress: 100,
          report_status_detail: isEN ? 'Meeting report generation failed' : isFR ? 'Génération du rapport échouée' : 'Meeting-Report Generation fehlgeschlagen',
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
        .update({ report_progress: 30, report_status_detail: isEN ? 'Evaluating pitch...' : isFR ? 'Évaluation du pitch...' : 'Bewerte Pitch...' })
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
            const prevLabel = isEN ? 'PREVIOUS PITCH' : isFR ? 'PITCH PRÉCÉDENT' : 'VORHERIGER PITCH';
            const prevCompare = isEN
              ? `IMPORTANT — COMPARISON IN SCORE BAR:\nThis is a follow-up pitch. For EVERY criterion you have the previous score above.\nUse the COMPARISON BAR DESIGN (see HTML template below) instead of simple bars.\nEach score bar shows: Ghost-Bar (old score, semi-transparent) + new bar + Delta-Badge.\nThe Delta-Badge shows the change: green ▲ +X.X for improvement, red ▼ -X.X for decline, gray ● for same.`
              : isFR
              ? `IMPORTANT — COMPARAISON DANS LA BARRE DE SCORE :\nCeci est un pitch de suivi. Pour CHAQUE critère tu as le score précédent ci-dessus.\nUtilise le DESIGN DE BARRE COMPARATIVE (voir template HTML ci-dessous) au lieu des barres simples.\nChaque barre de score montre : Ghost-Bar (ancien score, semi-transparent) + nouvelle barre + Delta-Badge.\nLe Delta-Badge montre le changement : vert ▲ +X.X pour amélioration, rouge ▼ -X.X pour déclin, gris ● pour identique.`
              : `WICHTIG — VERGLEICH IM SCORE-BAR:\nDies ist ein Folge-Pitch. Für JEDES Kriterium hast du den vorherigen Score oben.\nVerwende das VERGLEICHS-BAR-DESIGN (siehe HTML-Vorlage unten) statt der einfachen Bars.\nJeder Score-Balken zeigt: Ghost-Bar (alter Score, halbtransparent) + neuer Balken + Delta-Badge.\nDas Delta-Badge zeigt die Veränderung: grün ▲ +X.X bei Verbesserung, rot ▼ -X.X bei Verschlechterung, grau ● bei gleich.`;
            prevPitchContext = `\n\n${prevLabel} (v${prev.version || 1}) — "${prev.topic}":
Overall Score: ${prev.score || 0}/100
Content Scores: clarity=${pc.clarity||0}, problem_sharpness=${pc.problem_sharpness||0}, value_proposition=${pc.value_proposition||pc.value_prop||0}, structure=${pc.structure||0}, differentiation=${pc.differentiation||0}, credibility=${pc.credibility||0}, audience_fit=${pc.audience_fit||0}
Delivery Scores: opening=${pd.opening||0}, closing=${pd.closing||0}, voice_rhythm=${pd.voice_rhythm||0}, rhetoric_language=${pd.rhetoric_language||0}, authenticity=${pd.authenticity||0}, persuasiveness=${pd.persuasiveness||0}

${prevCompare}\n`;
          }
        }
      } catch (e) { console.error('[report] prev pitch load failed:', e?.message); }

      console.log(`[report] ${session_id} — prevPitchContext: ${prevPitchContext ? `FOUND (${prevPitchContext.length} chars)` : 'NONE (first pitch)'}`);

      const pitchPrompt = isEN ? `You are a STRICT, HONEST pitch evaluator. You are evaluating a sales pitch from a voice transcript.

IMPORTANT — STRICT SCORING:
- Score 1 = weak, incomplete, unclear
- Score 2 = recognizable approach, but major gaps
- Score 3 = solid foundation, but room for improvement
- Score 4 = good, only fine-tuning needed
- Score 5 = excellent, hard to improve
- A short, incomplete pitch gets LOW scores (1-2). Do NOT be lenient.
- If the pitch was just one sentence or was aborted: set ALL scores to 1-2.
- A score of 4+ requires demonstrable substance in the transcript.

EVALUATION CRITERIA — 13 criteria in 2 groups:

CONTENT (60%):
01 Clarity (12%) — Instant understanding: offer, target audience, relevance
02 Problem Sharpness (10%) — Problem is real, clear, specific, important enough
03 Value Proposition (12%) — Benefit clear, specific, credible
04 Structure (8%) — Structure, narrative thread, 3-5 main points
05 Differentiation (8%) — Uniqueness recognizable
06 Credibility (5%) — Substance, evidence, no empty claims
07 Audience Fit (5%) — Content fits the audience

DELIVERY (40%):
08 Opening (8%) — Hook, immediate relevance
09 Closing (7%) — Summary, CTA
10 Voice & Rhythm (8%) — Pace, pauses, variation
11 Rhetoric & Language (7%) — Short sentences, imagery, no filler words
12 Authenticity (5%) — Own voice, genuine conviction
13 Persuasiveness (5%) — Call to action, memorable

CONFIDENCE:
- Voice input: all criteria "high confidence"
- Text input (no audio): Voice & Rhythm + Authenticity = "low confidence", Rhetoric = "medium"

CALCULATION:
- Content Score = weighted average of 7 Content criteria
- Delivery Score = weighted average of 6 Delivery criteria
- Overall = (Content Score × 0.6) + (Delivery Score × 0.4)

${prevPitchContext}
TRANSCRIPT:
${transcript_text}

TASK:
Create the complete Sales Pitch Report as HTML. Use the EXACT design below.
Replace ALL placeholders with real values from your evaluation.
Each score bar must have the correct width (Score/5 × 100 = percent).
Colors: >= 4.0 = #22c55e (green), 2.5-3.9 = #eab308 (yellow), < 2.5 = #ef4444 (red).
${prevPitchContext ? `IMPORTANT: This is a FOLLOW-UP PITCH. You MUST use the comparison bar design (Ghost-Bar + Delta-Badge) for EVERY criterion. Without comparison the report is INCOMPLETE.` : ''}
Write in the same language as the transcript.
Reply ONLY with HTML. No Markdown, no text before/after.`

      : isFR ? `Tu es un évaluateur de pitch STRICT et HONNÊTE. Tu évalues un sales pitch à partir d'une transcription vocale.

IMPORTANT — NOTATION STRICTE :
- Score 1 = faible, incomplet, flou
- Score 2 = approche reconnaissable, mais grosses lacunes
- Score 3 = base solide, mais marge d'amélioration
- Score 4 = bien, juste des ajustements fins
- Score 5 = excellent, difficile à améliorer
- Un pitch court et incomplet reçoit des scores BAS (1-2). Ne sois PAS indulgent.
- Si le pitch n'était qu'une phrase ou a été interrompu : mettre TOUS les scores à 1-2.
- Un score de 4+ exige une substance démontrable dans le transcript.

CRITÈRES D'ÉVALUATION — 13 critères en 2 groupes :

CONTENT (60%) :
01 Clarity (12%) — Compréhension immédiate : offre, cible, pertinence
02 Problem Sharpness (10%) — Problème réel, clair, concret, suffisamment important
03 Value Proposition (12%) — Bénéfice clair, spécifique, crédible
04 Structure (8%) — Construction, fil conducteur, 3-5 points principaux
05 Differentiation (8%) — Unicité reconnaissable
06 Credibility (5%) — Substance, preuves, pas d'affirmations vides
07 Audience Fit (5%) — Contenu adapté à l'audience

DELIVERY (40%) :
08 Opening (8%) — Accroche, pertinence immédiate
09 Closing (7%) — Résumé, CTA
10 Voice & Rhythm (8%) — Rythme, pauses, variation
11 Rhetoric & Language (7%) — Phrases courtes, images, pas de mots de remplissage
12 Authenticity (5%) — Voix propre, conviction sincère
13 Persuasiveness (5%) — Impulsion d'action, mémorable

CONFIDENCE :
- Entrée vocale : tous les critères "high confidence"
- Entrée texte (pas d'audio) : Voice & Rhythm + Authenticity = "low confidence", Rhetoric = "medium"

CALCUL :
- Content Score = moyenne pondérée des 7 critères Content
- Delivery Score = moyenne pondérée des 6 critères Delivery
- Overall = (Content Score × 0.6) + (Delivery Score × 0.4)

${prevPitchContext}
TRANSCRIPT :
${transcript_text}

TÂCHE :
Crée le rapport complet Sales Pitch en HTML. Utilise le design EXACT ci-dessous.
Remplace TOUS les marqueurs par les vraies valeurs de ton évaluation.
Chaque barre de score doit avoir la bonne largeur (Score/5 × 100 = pourcentage).
Couleurs : >= 4.0 = #22c55e (vert), 2.5-3.9 = #eab308 (jaune), < 2.5 = #ef4444 (rouge).
${prevPitchContext ? `IMPORTANT : Ceci est un PITCH DE SUIVI. Tu DOIS utiliser le design de barre comparative (Ghost-Bar + Delta-Badge) pour CHAQUE critère. Sans comparaison, le rapport est INCOMPLET.` : ''}
Écris dans la même langue que le transcript.
Réponds UNIQUEMENT avec du HTML. Pas de Markdown, pas de texte avant/après.`

      : `Du bist ein STRENGER, EHRLICHER Pitch-Evaluator. Du bewertest einen Sales Pitch aus einem Voice-Transcript.

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

${isEN ? 'HTML STRUCTURE (keep design EXACTLY, only replace values + texts)' : isFR ? 'STRUCTURE HTML (garder le design EXACTEMENT, remplacer uniquement valeurs + textes)' : 'HTML-STRUKTUR (Design EXAKT beibehalten, nur Werte + Texte ersetzen)'}:
<div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:700px;margin:0 auto;padding:40px 0;color:#1a1a1a;line-height:1.6;">
  <div style="text-align:center;margin-bottom:36px;">
    <div style="display:inline-block;background:#111;color:#fff;font-size:10px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;padding:6px 16px;border-radius:20px;margin-bottom:12px;">Score Card</div>
    <h1 style="font-size:26px;font-weight:700;color:#111;margin:8px 0 4px;letter-spacing:-0.02em;">[${isEN ? 'PITCH TOPIC' : isFR ? 'SUJET DU PITCH' : 'PITCH THEMA'}]</h1>
    <div style="font-size:14px;color:#888;">${todayDate} · [pitch_type] · Confidence: [level]</div>
  </div>
  <div style="background:#f8f8f8;border-radius:16px;padding:28px;margin-bottom:28px;">
    <div style="text-align:center;margin-bottom:24px;">
      <div style="font-size:48px;font-weight:800;color:#111;letter-spacing:-0.03em;">[OVERALL]</div>
      <div style="font-size:12px;color:#888;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;">Overall Score</div>
      <!-- ${isEN ? 'IF comparison: show delta below Overall Score' : isFR ? 'SI comparaison : afficher delta sous Overall Score' : 'WENN Vergleich: zeige Delta unter Overall Score'} -->
      <!-- <div style="font-size:14px;font-weight:600;margin-top:4px;color:[${isEN ? 'green/red' : isFR ? 'vert/rouge' : 'grün/rot'}];">▲ +0.4 vs. v[N-1]</div> -->
    </div>
    <div style="font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#888;margin:20px 0 12px;padding-bottom:6px;border-bottom:1px solid #e5e5e5;">Content (60%)</div>
    <!-- ${isEN ? 'FOR EACH Content criterion — IF no comparison (first pitch)' : isFR ? 'POUR CHAQUE critère Content — SI pas de comparaison (premier pitch)' : 'FÜR JEDES Content-Kriterium — WENN kein Vergleich (erster Pitch)'}: -->
    <div style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
        <span style="font-size:13px;font-weight:500;color:#333;">[${isEN ? 'Criterion' : isFR ? 'Critère' : 'Kriterium'}]</span>
        <span style="font-size:13px;font-weight:700;color:#111;">[X.X] / 5</span>
      </div>
      <div style="height:8px;background:#e5e5e5;border-radius:4px;overflow:hidden;">
        <div style="height:100%;width:[${isEN ? 'PERCENT' : isFR ? 'POURCENT' : 'PROZENT'}]%;background:[${isEN ? 'COLOR' : isFR ? 'COULEUR' : 'FARBE'}];border-radius:4px;"></div>
      </div>
      <div style="font-size:12px;color:#888;margin-top:2px;">[${isEN ? '1-sentence rationale' : isFR ? 'justification en 1 phrase' : '1-Satz Begründung'}]</div>
    </div>
    <!-- ${isEN ? 'IF comparison exists (follow-up pitch) — use THIS design instead' : isFR ? 'SI comparaison existante (pitch de suivi) — utiliser CE design à la place' : 'WENN Vergleich vorhanden (Folge-Pitch) — verwende DIESES Design stattdessen'}: -->
    <!-- Ghost-Bar = ${isEN ? 'old score semi-transparent, new bar on top, Delta-Badge right' : isFR ? 'ancien score semi-transparent, nouvelle barre par-dessus, Delta-Badge à droite' : 'alter Score halbtransparent, neuer Balken darüber, Delta-Badge rechts'} -->
    <div style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <span style="font-size:13px;font-weight:500;color:#333;">[${isEN ? 'Criterion' : isFR ? 'Critère' : 'Kriterium'}]</span>
        <span style="display:flex;align-items:center;gap:6px;">
          <span style="font-size:13px;font-weight:700;color:#111;">[${isEN ? 'NEW' : isFR ? 'NOUVEAU' : 'NEU'} X.X] / 5</span>
          <!-- Delta-Badge: ${isEN ? 'green for improvement, red for decline, gray for same' : isFR ? 'vert pour amélioration, rouge pour déclin, gris pour identique' : 'grün bei Verbesserung, rot bei Verschlechterung, grau bei gleich'} -->
          <span style="font-size:10px;font-weight:700;padding:2px 6px;border-radius:8px;background:[DELTA_BG];color:[DELTA_COLOR];">[▲+0.5 ${isEN ? 'or' : isFR ? 'ou' : 'oder'} ▼-0.3 ${isEN ? 'or' : isFR ? 'ou' : 'oder'} ●]</span>
        </span>
      </div>
      <div style="position:relative;height:12px;background:#e5e5e5;border-radius:4px;overflow:hidden;">
        <!-- Ghost-Bar: ${isEN ? 'previous score (semi-transparent, striped)' : isFR ? 'score précédent (semi-transparent, rayé)' : 'vorheriger Score (halbtransparent, gestreift)'} -->
        <div style="position:absolute;top:0;left:0;height:100%;width:[${isEN ? 'OLD_PERCENT' : isFR ? 'ANCIEN_POURCENT' : 'ALT_PROZENT'}]%;background:repeating-linear-gradient(90deg,[${isEN ? 'OLD_COLOR' : isFR ? 'ANCIENNE_COULEUR' : 'ALT_FARBE'}]33 0,transparent 0,transparent 3px,[${isEN ? 'OLD_COLOR' : isFR ? 'ANCIENNE_COULEUR' : 'ALT_FARBE'}]33 3px,[${isEN ? 'OLD_COLOR' : isFR ? 'ANCIENNE_COULEUR' : 'ALT_FARBE'}]33 6px);border-radius:4px;"></div>
        <!-- ${isEN ? 'New score bar (solid, on top)' : isFR ? 'Nouvelle barre de score (solide, par-dessus)' : 'Neuer Score-Balken (solid, darüber)'} -->
        <div style="position:relative;height:100%;width:[${isEN ? 'NEW_PERCENT' : isFR ? 'NOUVEAU_POURCENT' : 'NEU_PROZENT'}]%;background:[${isEN ? 'NEW_COLOR' : isFR ? 'NOUVELLE_COULEUR' : 'NEU_FARBE'}];border-radius:4px;"></div>
      </div>
      <div style="font-size:12px;color:#888;margin-top:2px;">[${isEN ? '1-sentence rationale' : isFR ? 'justification en 1 phrase' : '1-Satz Begründung'}]</div>
    </div>
    <!-- DELTA-BADGE ${isEN ? 'Colors: Improvement' : isFR ? 'Couleurs : Amélioration' : 'Farben: Verbesserung'} (>=+0.3): background:rgba(34,197,94,.12) color:#22c55e -->
    <!-- ${isEN ? 'Decline' : isFR ? 'Déclin' : 'Verschlechterung'} (<=-0.3): background:rgba(239,68,68,.12) color:#ef4444 -->
    <!-- ${isEN ? 'Same' : isFR ? 'Identique' : 'Gleich'}: background:rgba(0,0,0,.06) color:#999 -->
    <div style="text-align:right;font-size:13px;font-weight:600;color:#555;margin:14px 0 20px;">Content Score: [X.X] / 5.0</div>

    <div style="font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#888;margin:0 0 12px;padding-bottom:6px;border-bottom:1px solid #e5e5e5;">Delivery (40%)</div>
    <!-- ${isEN ? 'FOR EACH Delivery criterion (same structure as Content)' : isFR ? 'POUR CHAQUE critère Delivery (même structure que Content)' : 'FÜR JEDES Delivery-Kriterium (gleiche Struktur wie Content)'}: -->
    <!-- ${isEN ? 'For low-confidence criteria: * after name + italic note' : isFR ? 'Pour les critères low-confidence : * après le nom + note en italique' : 'Bei low-confidence Kriterien: * nach dem Namen + kursiver Hinweis'} -->
    <div style="text-align:right;font-size:13px;font-weight:600;color:#555;margin-top:14px;">Delivery Score: [X.X] / 5.0</div>
    <div style="margin-top:8px;font-size:11px;color:#aaa;font-style:italic;">[${isEN ? 'Only for text pitches: "* Text-based — Confidence: low. For full evaluation, use voice mode."' : isFR ? 'Uniquement pour les pitchs texte : "* Basé sur le texte — Confidence : low. Pour une évaluation complète, utilisez le mode vocal."' : 'NUR bei Text-Pitch: "* Textbasiert — Confidence: low. Für vollständige Bewertung: Voice-Modus nutzen."'}]</div>
  </div>

  <!-- OVERALL VERDICT -->
  <div style="background:#faf9f6;border-left:3px solid #c4a882;border-radius:8px;padding:20px;margin-bottom:28px;">
    <div style="font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#a09080;margin-bottom:8px;">Verdict</div>
    <div style="font-size:15px;color:#333;line-height:1.7;">[${isEN ? '2-4 sentences overall assessment — honest, direct, no sugarcoating' : isFR ? '2-4 phrases d\'évaluation globale — honnête, direct, sans enjoliver' : '2-4 Sätze Gesamtbewertung — ehrlich, direkt, kein Schönreden'}]</div>
  </div>

  <!-- ${isEN ? 'STRENGTHS (green boxes)' : isFR ? 'POINTS FORTS (boîtes vertes)' : 'STÄRKEN (grüne Boxen)'} -->
  <div style="margin-bottom:28px;">
    <div style="font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#111;margin:0 0 14px;">${isEN ? 'Strengths' : isFR ? 'Points forts' : 'Stärken'}</div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      <div style="padding:12px 16px;background:#f0fdf4;border-radius:10px;border-left:3px solid #22c55e;font-size:14px;color:#333;">[${isEN ? 'Strength — only if genuinely present' : isFR ? 'Point fort — seulement si réellement présent' : 'Stärke — nur wenn wirklich vorhanden'}]</div>
    </div>
  </div>

  <!-- ${isEN ? 'WEAKNESSES (yellow/red boxes)' : isFR ? 'FAIBLESSES (boîtes jaunes/rouges)' : 'SCHWÄCHEN (gelbe/rote Boxen)'} -->
  <div style="margin-bottom:28px;">
    <div style="font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#111;margin:0 0 14px;">${isEN ? 'Weaknesses' : isFR ? 'Points faibles' : 'Schwächen'}</div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      <div style="padding:12px 16px;background:#fffbeb;border-radius:10px;border-left:3px solid #eab308;font-size:14px;color:#333;">[${isEN ? 'Weakness — specific and concrete' : isFR ? 'Point faible — spécifique et concret' : 'Schwäche — konkret und spezifisch'}]</div>
    </div>
  </div>

  <!-- ${isEN ? 'TOP 3 PRIORITIES (black box)' : isFR ? 'TOP 3 PRIORITÉS (boîte noire)' : 'TOP 3 PRIORITÄTEN (schwarze Box)'} -->
  <div style="background:#111;border-radius:14px;padding:24px;margin-bottom:28px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#888;margin-bottom:8px;">${isEN ? 'Next Steps' : isFR ? 'Prochaines étapes' : 'Nächste Schritte'}</div>
    <div style="font-size:16px;color:#fff;line-height:1.7;">[${isEN ? 'Top 3 improvements for the next attempt' : isFR ? 'Top 3 améliorations pour le prochain essai' : 'Top 3 Verbesserungen für den nächsten Versuch'}]</div>
  </div>

  <div style="margin-top:40px;padding-top:16px;border-top:1px solid #eee;font-size:11px;color:#bbb;text-align:center;">${isEN ? 'Created with Sophie · meet-sophie.com' : isFR ? 'Créé avec Sophie · meet-sophie.com' : 'Erstellt mit Sophie · meet-sophie.com'}</div>
</div>`;

      const pitchSynthProviders = isEco ? [
        { provider: 'google', model: 'gemini-2.5-flash' },
        { provider: 'openai', model: 'gpt-4o-mini' },
      ] : [
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
          trackAdapterCost(response, reportUserId, 'report-salespitch');
          const text = (response.content || '').trim();
          reportHtml = text.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim();
          if (isValidReportHtml(reportHtml)) {
            console.log(`[report] ${session_id} — salespitch report via ${synth.provider} (${reportHtml.length} chars)`);
            break;
          }
          console.warn(`[report] ${session_id} — salespitch ${synth.provider} returned invalid/truncated HTML (${reportHtml.length} chars), trying next`);
          reportHtml = null;
        } catch (e) {
          console.error(`[report] salespitch ${synth.provider} failed:`, e?.message);
        }
      }

      if (reportHtml) {
        await supabase.from('conversation_outputs')
          .update({ report_progress: 80, report_status_detail: isEN ? 'Saving report...' : isFR ? 'Sauvegarde du rapport...' : 'Speichere Report...' })
          .eq('session_id', session_id);

        reportHtml = reportHtml.replace(/\[Datum\]/g, todayDate);
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

            // Write pitch-specific data back to conversation_outputs for resume context
            try {
              await supabase.from('conversation_outputs').update({
                structured_summary: {
                  summary: reportTitle,
                  audience_type: pitchData.audience_type || "",
                  overall_score: pitchData.overall_score ? Math.round(pitchData.overall_score * 20) : 0,
                  scores_content: pitchData.scores_content || {},
                  strongest_elements: pitchData.strengths || [],
                  main_weaknesses: pitchData.weaknesses || [],
                  recommended_next_attempt: "", // not extracted in this step
                  confidence_level: pitchData.confidence_level || "low",
                },
                key_insights: (pitchData.strengths || []).map(s => typeof s === 'string' ? s : s.text || String(s)),
                open_questions: (pitchData.weaknesses || []).map(w => typeof w === 'string' ? w : w.text || String(w)),
              }).eq('session_id', session_id);
              console.log(`[report] Pitch resume data saved to conversation_outputs`);
            } catch (resumeErr) {
              console.error(`[report] pitch resume data save failed (non-critical):`, resumeErr?.message);
            }
          }
        } catch (pitchMemErr) {
          console.error(`[report] pitch memory extraction failed (non-critical):`, pitchMemErr?.message);
        }
      } else {
        await supabase.from('conversation_outputs').update({
          report_status: 'failed', report_progress: 100,
          report_status_detail: isEN ? 'Sales pitch report generation failed' : isFR ? 'Génération du rapport pitch échouée' : 'Sales Pitch Report Generation fehlgeschlagen',
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
      const localizedDefaults = getDefaultTemplates(reportLang || 'de');
      savedTemplate = localizedDefaults[mode] || localizedDefaults['default'] || null;
      if (savedTemplate) templateSource = 'system';
    }

    const hasTemplate = !!savedTemplate;
    console.log(`[report] ${session_id} — template=${templateSource}, mode=${mode}, len=${savedTemplate?.length || 0}`);

    // Step 1: All 4 AIs analyze the transcript (content only, no design classification if template exists)
    const structuredAnalysisInstructions = isEN ? `Analyze this conversation STRUCTURALLY. ${dateInstruction}
${modeHint}

TRANSCRIPT FORMAT NOTES:
- Lines with "[user]: [chat] ..." are text messages typed by the user DURING the voice conversation. These often contain important facts, links or instructions — treat equally.
- Lines with "[assistant]: [chat note] ..." are short notes Sophie displayed in the chat panel (e.g. bullet points, summaries). These show what Sophie highlighted as particularly important.

Respond in the language of the transcript using EXACTLY these sections:

TITLE: [1 sentence — what was it about]
PARTICIPANTS: [Only names EXPLICITLY mentioned in the conversation. If no names: "Not mentioned"]
TOPICS DISCUSSED:
- [Topic 1]: [What was said about it]
- [Topic 2]: [What was said about it]
DECISIONS:
- [Only if explicitly decided, with exact wording]
ACTION ITEMS:
- [Task] → [Responsible, only if named] → [Deadline, only if named]
NEXT MEETING: [Date, time, location — ONLY if explicitly mentioned. Otherwise: "Not agreed"]
OPEN POINTS:
- [Topics that remained open]

CRITICAL RULES:
- Write ONLY what was LITERALLY said. NEVER invent.
- Clearly distinguish: info about THIS meeting vs. info about FUTURE meetings/appointments
- "Next meeting on Wednesday 3pm" is NOT the time of this meeting — it's a future appointment
- If something was not said, write "Not mentioned" — NEVER invent
- No interpretation, no assumptions, no conclusions`

    : isFR ? `Analyse cette conversation de manière STRUCTURÉE. ${dateInstruction}
${modeHint}

NOTES SUR LE FORMAT DU TRANSCRIPT :
- Les lignes avec "[user]: [chat] ..." sont des messages texte tapés par l'utilisateur PENDANT la conversation vocale. Ils contiennent souvent des faits importants, liens ou instructions — traiter également.
- Les lignes avec "[assistant]: [chat note] ..." sont de courtes notes que Sophie a affichées dans le panneau de chat (ex : points clés, résumés). Elles montrent ce que Sophie a jugé particulièrement important.

Réponds dans la langue du transcript avec EXACTEMENT ces sections :

TITRE : [1 phrase — de quoi il s'agissait]
PARTICIPANTS : [Uniquement les noms EXPLICITEMENT mentionnés dans la conversation. Si aucun nom : "Non mentionné"]
SUJETS DISCUTÉS :
- [Sujet 1] : [Ce qui a été dit à ce propos]
- [Sujet 2] : [Ce qui a été dit à ce propos]
DÉCISIONS :
- [Uniquement si explicitement décidé, avec le libellé exact]
ACTIONS :
- [Tâche] → [Responsable, uniquement si nommé] → [Échéance, uniquement si nommée]
PROCHAINE RÉUNION : [Date, heure, lieu — UNIQUEMENT si explicitement mentionné. Sinon : "Non convenu"]
POINTS OUVERTS :
- [Sujets restés en suspens]

RÈGLES CRITIQUES :
- Écrire UNIQUEMENT ce qui a été LITTÉRALEMENT dit. NE JAMAIS inventer.
- Distinguer clairement : infos sur CETTE réunion vs. infos sur des réunions/rendez-vous FUTURS
- "Prochaine réunion mercredi 15h" n'est PAS l'heure de cette réunion — c'est un rendez-vous futur
- Si quelque chose n'a pas été dit, écrire "Non mentionné" — NE JAMAIS inventer
- Pas d'interprétation, pas de suppositions, pas de conclusions`

    : `Analysiere dieses Gespräch STRUKTURIERT. ${dateInstruction}
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

${isEN ? 'ADDITIONALLY: Start your response with EXACTLY ONE of these lines' : isFR ? 'EN PLUS : Commence ta réponse par EXACTEMENT UNE de ces lignes' : 'ZUSÄTZLICH: Beginne deine Antwort mit GENAU EINER dieser Zeilen'}:
[TYPE:DESIGN] — ${isEN ? 'if the conversation is mainly about how a document/report/template should look' : isFR ? 'si la conversation porte principalement sur l\'apparence d\'un document/rapport/template' : 'wenn das Gespräch hauptsächlich darum geht, wie ein Dokument/Report/Template aussehen soll'}
[TYPE:CONTENT] — ${isEN ? 'if it is a normal conversation (meeting, brainstorm, consulting, etc.)' : isFR ? 'si c\'est une conversation normale (réunion, brainstorm, conseil, etc.)' : 'wenn es ein normales Gespräch ist (Meeting, Brainstorm, Beratung, etc.)'}
${isEN ? 'Then your structured analysis follows.' : isFR ? 'Ensuite suit ton analyse structurée.' : 'Danach folgt deine strukturierte Analyse.'}`;

    // Run all 4 analyses in parallel for speed
    await supabase.from('conversation_outputs')
      .update({ report_progress: 10, report_status_detail: hasTemplate
        ? (isEN ? 'Analyzing content...' : isFR ? 'Analyse du contenu...' : 'Analysiere Inhalt...')
        : (isEN ? 'Analyzing with 4 AIs in parallel...' : isFR ? 'Analyse avec 4 IAs en parallèle...' : 'Analysiere mit 4 KIs parallel...') })
      .eq('session_id', session_id);

    const providers = isEco ? ECO_REPORT_PROVIDERS : REPORT_PROVIDERS;
    const analysisResults = await Promise.allSettled(
      providers.map(async ({ provider, model }) => {
        const adapter = getAdapter(provider);
        const response = await adapter.complete({
          messages: [
            { role: 'system', content: analysisPrompt },
            { role: 'user', content: `Transcript:\n${transcript_text}` },
          ],
          model, maxTokens: 2048, temperature: 0.2,
        });
        trackAdapterCost(response, reportUserId, 'report-analysis');
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
        .update({ report_status: 'failed', report_progress: 100, report_status_detail: isEN ? 'No AI providers available' : isFR ? 'Aucun fournisseur AI disponible' : 'Keine AI-Provider verfügbar' })
        .eq('session_id', session_id);
      return res.status(500).json({ error: 'No providers available' });
    }

    // Step 3: Generate the final HTML report
    await supabase.from('conversation_outputs')
      .update({
        report_progress: 70,
        report_status_detail: hasTemplate
          ? (isEN ? `Filling template with ${analyses.length} analyses...` : isFR ? `Remplissage du template avec ${analyses.length} analyses...` : `Fülle Template mit ${analyses.length} Analysen...`)
          : isEN ? `Creating report from ${analyses.length} analyses...` : isFR ? `Création du rapport à partir de ${analyses.length} analyses...` : `Erstelle Report aus ${analyses.length} Analysen...`,
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

      htmlPrompt = isEN ? `You are filling an existing report template with new content.

The user saved this HTML layout as THEIR template. The design is SACRED — do NOT change it.

TASK:
1. Keep the EXACT HTML structure, ALL CSS styles, colors, fonts and design elements
2. Replace ONLY the text content (placeholders, example texts) with real facts from the analyses
3. Adjust the number of sections/rows to match actual content (more or fewer rows as needed)
4. New sections: in the EXACT SAME style as existing sections in the template
5. Language: same as the analyses
6. "Protocol" / "Created by" is ALWAYS "Sophie" (the AI assistant that recorded the meeting)

CRITICAL — MAPPING:
- The analyses have a clear structure (TITLE, PARTICIPANTS, DECISIONS, NEXT MEETING, etc.)
- "NEXT MEETING" info (date, time, location) is NOT the metadata of THIS meeting!
  → It belongs in Action Items or a separate "Next Meeting" section
- "Time" in template header: ONLY use if the analyses mention a time for THIS meeting
- "Location" in template header: ONLY use if the analyses mention a location for THIS meeting

CRITICAL — DO NOT HALLUCINATE:
- If information is NOT in the analyses, REMOVE the section completely from the HTML
- NO invented names, times, locations, roles or deadlines
- If no participants are named: REMOVE "Participants" section
- If no time for THIS meeting is mentioned: REMOVE "Time" field
- If no decisions were made: REMOVE "Decisions" section
- If no action items exist: REMOVE "Action Items" section
- NEVER leave placeholders like [Name], [Role], [00:00], — or "Not specified" in output
- Better to omit a section than fill it with invented data

FORBIDDEN:
- Changing the design
- Changing colors
- Changing fonts
- Changing layout structure
- Adding own design elements
- Inventing content not in the transcript

Reply ONLY with the HTML. No Markdown, no text before/after.

THE USER'S TEMPLATE:
${templateHtml}

THE ${analyses.length} ANALYSES (CONTENT ONLY):

${analysesBlock}`

      : isFR ? `Tu remplis un template de rapport existant avec du nouveau contenu.

L'utilisateur a enregistré ce layout HTML comme SON template. Le design est SACRÉ — ne le modifie PAS.

TÂCHE :
1. Garder la structure HTML EXACTE, TOUS les styles CSS, couleurs, polices et éléments de design
2. Remplacer UNIQUEMENT le contenu textuel (marqueurs, textes d'exemple) par les faits réels des analyses
3. Adapter le nombre de sections/lignes au contenu réel (plus ou moins de lignes selon les besoins)
4. Nouvelles sections : dans le MÊME style EXACT que les sections existantes du template
5. Langue : la même que les analyses
6. "Protocole" / "Créé par" est TOUJOURS "Sophie" (l'assistante IA qui a enregistré la réunion)

CRITIQUE — ATTRIBUTION :
- Les analyses ont une structure claire (TITRE, PARTICIPANTS, DÉCISIONS, PROCHAINE RÉUNION, etc.)
- Les infos "PROCHAINE RÉUNION" (date, heure, lieu) ne sont PAS les métadonnées de CETTE réunion !
  → Elles appartiennent aux Actions ou une section "Prochaine réunion" séparée
- "Heure" dans l'en-tête du template : UNIQUEMENT si les analyses mentionnent une heure pour CETTE réunion
- "Lieu" dans l'en-tête du template : UNIQUEMENT si les analyses mentionnent un lieu pour CETTE réunion

CRITIQUE — NE PAS HALLUCINER :
- Si une information N'EST PAS dans les analyses, SUPPRIMER la section complètement du HTML
- PAS de noms, heures, lieux, rôles ou échéances inventés
- Si aucun participant n'est nommé : SUPPRIMER la section "Participants"
- Si aucune heure n'est mentionnée pour CETTE réunion : SUPPRIMER le champ "Heure"
- Si aucune décision n'a été prise : SUPPRIMER la section "Décisions"
- Si aucune action n'existe : SUPPRIMER la section "Actions"
- JAMAIS laisser des marqueurs comme [Nom], [Rôle], [00:00], — ou "Non spécifié" dans le résultat
- Mieux vaut omettre une section que la remplir avec des données inventées

INTERDIT :
- Modifier le design
- Modifier les couleurs
- Modifier les polices
- Modifier la structure du layout
- Ajouter ses propres éléments de design
- Inventer du contenu absent du transcript

Répondre UNIQUEMENT avec le HTML. Pas de Markdown, pas de texte avant/après.

LE TEMPLATE DE L'UTILISATEUR :
${templateHtml}

LES ${analyses.length} ANALYSES (CONTENU UNIQUEMENT) :

${analysesBlock}`

      : `Du füllst ein bestehendes Report-Template mit neuem Inhalt.

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
        htmlPrompt = isEN ? `You are an HTML template designer.

The user described in a conversation how a document/report should look.
${analyses.length} AIs analyzed the design requirements independently.

YOUR TASK:
Create a FINISHED EXAMPLE DOCUMENT as HTML that looks EXACTLY as the user described it.
- Use realistic placeholder content (example meeting, example protocol, etc.) to demonstrate the layout
- The result should be a ready-to-use template, NOT a report about the requirements
- Implement EVERY mentioned design requirement 1:1: colors, fonts, structure, format

EXAMPLE:
User says "black-and-white, meeting protocol, A4, professional"
→ You create a complete meeting protocol in black-and-white with example agenda, example decisions, example action items. It looks like a real document, not like a summary of a conversation.

FORBIDDEN:
- No meta-information ("the user wants...", "Requirements:", "Confirmed by X AIs")
- No report ABOUT the conversation
- No analysis labels, no AI badges

TECHNICAL:
- Pure HTML (only <body> content, no <html>/<head>)
- Inline CSS
- Font: system font stack
- Responsive: max-width 100%, no fixed pixel widths
- Language: same as the analyses

Reply ONLY with the HTML.

THE DESIGN REQUIREMENTS FROM ${analyses.length} ANALYSES:

${analysesBlock}`

        : isFR ? `Tu es un designer de templates HTML.

L'utilisateur a décrit dans une conversation à quoi un document/rapport devrait ressembler.
${analyses.length} IAs ont analysé les exigences de design indépendamment.

TA TÂCHE :
Crée un DOCUMENT EXEMPLE FINI en HTML qui ressemble EXACTEMENT à ce que l'utilisateur a décrit.
- Utilise du contenu de remplissage réaliste (exemple de réunion, exemple de protocole, etc.) pour démontrer le layout
- Le résultat doit être un template prêt à l'emploi, PAS un rapport sur les exigences
- Implémente CHAQUE exigence de design mentionnée 1:1 : couleurs, polices, structure, format

INTERDIT :
- Pas de méta-informations ("l'utilisateur souhaite...", "Exigences :", "Confirmé par X IAs")
- Pas de rapport SUR la conversation
- Pas d'étiquettes d'analyse, pas de badges IA

TECHNIQUE :
- HTML pur (uniquement contenu <body>, pas de <html>/<head>)
- CSS inline
- Police : system font stack
- Responsive : max-width 100%, pas de largeurs fixes en pixels
- Langue : la même que les analyses

Réponds UNIQUEMENT avec le HTML.

LES EXIGENCES DE DESIGN DES ${analyses.length} ANALYSES :

${analysesBlock}`

        : `Du bist ein HTML-Template-Designer.

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
        htmlPrompt = isEN ? `You are a report designer.
${analyses.length} AIs analyzed the same conversation independently.
${dateInstruction}

Create a REPORT as pure HTML (only <body> content, no <html>/<head>).

You have complete creative freedom with design. No predefined colors, no predefined structure. Design to match the content.

RULES:
- ONLY use facts confirmed by at least 2 AIs
- The CONTENT determines EVERYTHING — form, colors, layout, structure
- Use modern CSS (inline styles)
- Font: system font stack
- Responsive: max-width 100%, no fixed pixel widths
- Write in the same language as the analyses
- Do NOT bring any own branding. Start neutral.
- "Protocol" / "Created by" is ALWAYS "Sophie"

CRITICAL — DO NOT HALLUCINATE:
- If information is NOT in the analyses, LEAVE IT OUT
- NO invented names, times, locations, roles or deadlines
- NO placeholders like [Name], [Role], —, "Not specified"
- Only include sections that have real content
- Better a shorter report than one with invented data

FORMAT IDEAS (just inspiration):
- Meeting → Protocol with decisions + action items
- Brainstorm → Idea clusters
- Short conversation → Compact summary
- Decision → Pro/Contra side by side

Reply ONLY with the HTML. No Markdown, no text before/after.

THE ${analyses.length} ANALYSES:

${analysesBlock}`

        : isFR ? `Tu es un designer de rapports.
${analyses.length} IAs ont analysé la même conversation indépendamment.
${dateInstruction}

Crée un RAPPORT en HTML pur (uniquement contenu <body>, pas de <html>/<head>).

Tu as une liberté créative totale pour le design. Pas de couleurs prédéfinies, pas de structure prédéfinie. Conçois selon le contenu.

RÈGLES :
- Utiliser UNIQUEMENT les faits confirmés par au moins 2 IAs
- Le CONTENU détermine TOUT — forme, couleurs, layout, structure
- Utiliser du CSS moderne (styles inline)
- Police : system font stack
- Responsive : max-width 100%, pas de largeurs fixes en pixels
- Écrire dans la même langue que les analyses
- NE PAS apporter de branding propre. Commencer neutre.
- "Protocole" / "Créé par" est TOUJOURS "Sophie"

CRITIQUE — NE PAS HALLUCINER :
- Si une information N'EST PAS dans les analyses, L'OMETTRE
- PAS de noms, heures, lieux, rôles ou échéances inventés
- PAS de marqueurs comme [Nom], [Rôle], —, "Non spécifié"
- N'inclure que les sections ayant du contenu réel
- Mieux vaut un rapport plus court qu'un avec des données inventées

IDÉES DE FORMAT (juste inspiration) :
- Réunion → Protocole avec décisions + actions
- Brainstorm → Groupes d'idées
- Conversation courte → Résumé compact
- Décision → Pour/Contre côte à côte

Répondre UNIQUEMENT avec le HTML. Pas de Markdown, pas de texte avant/après.

LES ${analyses.length} ANALYSES :

${analysesBlock}`

        : `Du bist ein Report-Designer.
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

      // Creative task needs strong model first (eco: cheaper models)
      synthProviders = isEco ? [
        { provider: 'google', model: 'gemini-2.5-flash' },
        { provider: 'openai', model: 'gpt-4o-mini' },
      ] : [
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
        trackAdapterCost(response, reportUserId, 'report-synthesis');
        const text = (response.content || '').trim();
        // Strip markdown code fences if present
        reportHtml = text.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim();
        if (isValidReportHtml(reportHtml)) break;
        console.warn(`[report] ${session_id} — ${synth.provider} returned invalid/truncated HTML (${(reportHtml||'').length} chars), trying next`);
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
