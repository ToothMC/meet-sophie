// lib/import/pipeline.js — 3-Zone Import Pipeline
// Zone A: Raw data (unchanged)
// Zone B: Structured profile (Claude Sonnet extracts compact user profile)
// Zone C: Memory (only after explicit user approval)
import { createClient } from '@supabase/supabase-js';
import { getAdapter } from '../ai/adapters/index.js';
import { classifySensitivity } from './sensitivity.js';

function getServiceClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Process an import through the 3-zone pipeline.
 */
export async function processImport(userId, sourceId, rawContent, source) {
  const supabase = getServiceClient();

  // ZONE A: Store raw data (unchanged)
  await supabase.from('source_items').insert({
    source_id: sourceId,
    zone: 'A',
    content_type: 'raw_import',
    sensitivity_class: classifySensitivity(rawContent),
    raw_content: rawContent,
    user_approved: false,
  });

  // ZONE B: Extract structured profile via Claude Sonnet
  // Two-pass approach: 1) extract titles + key content, 2) build compact profile
  const profile = await extractProfile(rawContent, source);

  const zoneBItems = [];
  for (const item of profile.items) {
    const sensitivity = classifySensitivity(item.content || item.summary);
    const { data } = await supabase.from('source_items').insert({
      source_id: sourceId,
      zone: 'B',
      content_type: item.type,
      sensitivity_class: sensitivity,
      summary: item.summary,
      extracted_insights: item.insights || {},
      user_approved: false,
    }).select('id').single();
    zoneBItems.push({ id: data?.id, ...item, sensitivity });
  }

  // Update source connection
  await supabase.from('source_connections').update({
    item_count: zoneBItems.length + 1,
    last_import_at: new Date().toISOString(),
  }).eq('id', sourceId);

  // ZONE C: NOT automatic — return candidates for user approval
  const memoryCandidates = profile.items.filter(i => i.isStableInsight);

  return {
    zoneA: { itemCount: 1 },
    zoneB: zoneBItems.length,
    memoryCandidates,
  };
}

/**
 * Approve specific items to be promoted to Zone C (memory).
 */
export async function approveForMemory(sourceId, itemIds) {
  const supabase = getServiceClient();
  for (const id of itemIds) {
    await supabase.from('source_items').update({
      zone: 'C',
      user_approved: true,
    }).eq('id', id).eq('source_id', sourceId);
  }
}

/**
 * Two-pass profile extraction:
 * Pass 1: Pre-process raw content into a structured summary (local, no API)
 * Pass 2: Claude Sonnet builds a compact user profile from the summary
 */
async function extractProfile(rawContent, source) {
  // --- Check: Is this already a structured summary (e.g. ChatGPT text paste)? ---
  // If it's short enough (<15000 chars) and doesn't have conversation markers,
  // skip pre-processing and send directly to Claude Sonnet
  const hasConversationMarkers = rawContent.includes('[human]:') || rawContent.includes('[assistant]:') || (rawContent.match(/^# /gm) || []).length > 3;
  const isCompactEnough = rawContent.length < 15000;

  if (!hasConversationMarkers && isCompactEnough) {
    console.log(`[pipeline] Direct extraction: ${rawContent.length} chars, no conversation markers`);
    return extractDirectProfile(rawContent, source);
  }

  // --- Pass 1: Local pre-processing (for conversation-format exports) ---
  const lines = rawContent.split('\n');

  // Extract conversation titles
  const titles = lines
    .filter(l => l.startsWith('# ') && l !== '# Untitled')
    .map(l => l.replace('# ', '').trim())
    .filter(t => t.length > 3);

  // Extract user messages (skip trivial ones)
  const userMessages = lines
    .filter(l => l.startsWith('[human]: '))
    .map(l => l.replace('[human]: ', '').trim())
    .filter(msg => msg.length > 20 && !msg.match(/^(ja|nein|ok|danke|hi|hallo|gut|bitte|weiter|genau|stimmt|alles klar)/i));

  // Extract assistant key responses (longer answers with substance)
  const assistantMessages = lines
    .filter(l => l.startsWith('[assistant]: '))
    .map(l => l.replace('[assistant]: ', '').trim())
    .filter(msg => msg.length > 100);

  // Build a pre-processed summary for Claude (max ~12000 chars)
  const preSummary = [];

  preSummary.push(`QUELLE: ${source} Export mit ${titles.length} Gesprächen`);

  if (titles.length > 0) {
    preSummary.push('\nGESPRÄCHSTHEMEN:\n' + titles.slice(0, 50).map(t => '- ' + t).join('\n'));
  }

  // Sample user messages from beginning, middle, end
  if (userMessages.length > 0) {
    const sampled = sampleFromArray(userMessages, 15);
    preSummary.push('\nWICHTIGE USER-ANFRAGEN (Auswahl):\n' + sampled.map(m => '- ' + m.slice(0, 200)).join('\n'));
  }

  // Sample key assistant responses
  if (assistantMessages.length > 0) {
    const sampled = sampleFromArray(assistantMessages, 8);
    preSummary.push('\nWICHTIGE KI-ANTWORTEN (Auswahl):\n' + sampled.map(m => '- ' + m.slice(0, 300)).join('\n'));
  }

  const preProcessed = preSummary.join('\n');

  // --- Pass 2: Claude Sonnet builds structured profile ---
  const profilePrompt = `Analysiere diese Zusammenfassung von ${titles.length} Gesprächen eines Users mit einer KI.
Erstelle ein kompaktes, strukturiertes USER-PROFIL. Extrahiere NUR echte, nützliche Informationen.

IGNORIERE: Konfigurationsdetails, Code-Snippets, technische Anleitungen, Übersetzungsanfragen.
FOKUSSIERE AUF: Wer ist diese Person? Was macht sie? Woran arbeitet sie? Wie kommuniziert sie?

Antworte als JSON-Array mit Objekten:
[
  { "type": "personal", "summary": "einzeilig", "insights": { "key": "value" }, "isStableInsight": true },
  { "type": "project", "summary": "einzeilig", "insights": { "name": "...", "status": "...", "tech": "..." }, "isStableInsight": true },
  { "type": "communication", "summary": "einzeilig", "insights": { "style": "...", "language": "..." }, "isStableInsight": true },
  { "type": "pattern", "summary": "einzeilig", "insights": { "approach": "..." }, "isStableInsight": false },
  ...
]

Typen: personal, project, work, communication, preference, pattern
isStableInsight = true für Fakten (Name, Beruf, Projekte), false für Muster/Tendenzen

Antworte NUR mit dem JSON-Array.

GESPRÄCH-ZUSAMMENFASSUNG:
${preProcessed.slice(0, 12000)}`;

  try {
    const adapter = getAdapter('anthropic');
    const response = await adapter.complete({
      messages: [{ role: 'user', content: profilePrompt }],
      model: 'claude-sonnet-4-6',
      maxTokens: 2048,
      temperature: 0.2,
    });

    const jsonMatch = response.content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const items = JSON.parse(jsonMatch[0]);
      if (Array.isArray(items) && items.length > 0) {
        // Add content field for compatibility
        const enriched = items.map(item => ({
          ...item,
          content: item.summary || JSON.stringify(item.insights),
        }));
        console.log(`[pipeline] Profile extraction: ${enriched.length} items from ${titles.length} conversations`);
        return { items: enriched };
      }
    }
  } catch (err) {
    console.error('[pipeline] Profile extraction failed:', err?.message);
  }

  // Fallback: at least save the conversation titles as insights
  const fallbackItems = [];
  if (titles.length > 0) {
    fallbackItems.push({
      type: 'work',
      summary: `${titles.length} Gespräche zu Themen: ${titles.slice(0, 10).join(', ')}`,
      content: titles.join('\n'),
      insights: { topics: titles.slice(0, 20), conversation_count: titles.length },
      isStableInsight: true,
    });
  }
  if (userMessages.length > 0) {
    fallbackItems.push({
      type: 'communication',
      summary: `Kommunikationsstil: ${userMessages.length} Anfragen analysiert`,
      content: sampleFromArray(userMessages, 5).join('\n'),
      insights: { message_count: userMessages.length, sample: sampleFromArray(userMessages, 5) },
      isStableInsight: false,
    });
  }

  return { items: fallbackItems.length > 0 ? fallbackItems : [{
    type: 'chat_summary',
    summary: `Import von ${source} (${Math.round(rawContent.length / 1024)}KB)`,
    content: '',
    insights: {},
    isStableInsight: false,
  }] };
}

/**
 * Sample items evenly from an array (beginning, middle, end).
 */
function sampleFromArray(arr, count) {
  if (arr.length <= count) return arr;
  const result = [];
  const step = arr.length / count;
  for (let i = 0; i < count; i++) {
    result.push(arr[Math.floor(i * step)]);
  }
  return result;
}

/**
 * Direct profile extraction — for already-structured text (e.g. ChatGPT memory export).
 * No pre-processing needed, send directly to Claude Sonnet.
 */
async function extractDirectProfile(rawContent, source) {
  const profilePrompt = `Der folgende Text ist ein Export von ${source} — eine Zusammenfassung dessen was die KI über einen User weiß.
Erstelle daraus ein strukturiertes USER-PROFIL als JSON-Array.

Extrahiere ALLE relevanten Informationen — Person, Beruf, Projekte, Kommunikationsstil, Interessen, Präferenzen, Muster.

Format:
[
  { "type": "personal", "summary": "einzeilig", "insights": { "key": "value" }, "isStableInsight": true },
  { "type": "project", "summary": "einzeilig", "insights": { "name": "...", "status": "...", "tech": "..." }, "isStableInsight": true },
  ...
]

Typen: personal, project, work, communication, preference, pattern
isStableInsight = true für Fakten (Name, Beruf, Projekte), false für Muster/Tendenzen

Antworte NUR mit dem JSON-Array.

USER-DATEN:
${rawContent.slice(0, 12000)}`;

  try {
    const adapter = getAdapter('anthropic');
    const response = await adapter.complete({
      messages: [{ role: 'user', content: profilePrompt }],
      model: 'claude-sonnet-4-6',
      maxTokens: 2048,
      temperature: 0.2,
    });

    console.log(`[pipeline] Direct extraction response: ${response.content.length} chars`);

    // Try multiple JSON extraction strategies
    let items = null;

    // Strategy 1: Match JSON array
    const jsonMatch = response.content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try { items = JSON.parse(jsonMatch[0]); } catch (e) {
        console.warn('[pipeline] JSON parse failed (strategy 1):', e?.message?.slice(0, 100));
      }
    }

    // Strategy 2: Try parsing the entire response as JSON
    if (!items) {
      try { items = JSON.parse(response.content.trim()); } catch {}
    }

    // Strategy 3: Extract from markdown code block
    if (!items) {
      const codeBlock = response.content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlock) {
        try { items = JSON.parse(codeBlock[1].trim()); } catch {}
      }
    }

    if (Array.isArray(items) && items.length > 0) {
      const enriched = items.map(item => ({
        ...item,
        content: item.summary || JSON.stringify(item.insights),
      }));
      console.log(`[pipeline] Direct profile extraction: ${enriched.length} items from ${source}`);
      return { items: enriched };
    }

    console.warn('[pipeline] No valid JSON found in response. First 300 chars:', response.content.slice(0, 300));
  } catch (err) {
    console.error('[pipeline] Direct extraction failed:', err?.message);
  }

  // Fallback
  return { items: [{
    type: 'chat_summary',
    summary: `Import von ${source} (${Math.round(rawContent.length / 1024)}KB)`,
    content: rawContent.slice(0, 2000),
    insights: {},
    isStableInsight: false,
  }] };
}
