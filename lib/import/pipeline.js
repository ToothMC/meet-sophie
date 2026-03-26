// lib/import/pipeline.js — 3-Zone Import Pipeline
// Zone A: Raw data (unchanged)
// Zone B: Working context (Claude Sonnet extracts insights)
// Zone C: Memory (only after explicit user approval)
import { createClient } from '@supabase/supabase-js';
import { getAdapter } from '../ai/adapters/index.js';
import { classifySensitivity } from './sensitivity.js';

function getServiceClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Process an import through the 3-zone pipeline.
 * @param {string} userId
 * @param {string} sourceId - UUID of the source_connection
 * @param {string} rawContent - Raw pasted or parsed text
 * @param {'chatgpt' | 'claude' | 'gemini' | 'file'} source
 * @returns {Promise<{ zoneA: { itemCount: number }, zoneB: number, memoryCandidates: Array }>}
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

  // ZONE B: Extract insights via Claude Sonnet
  const extraction = await extractInsights(rawContent, source);

  const zoneBItems = [];
  for (const item of extraction.items) {
    const sensitivity = classifySensitivity(item.content);
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

  // Update source connection item count
  await supabase.from('source_connections').update({
    item_count: zoneBItems.length + 1, // +1 for zone A
    last_import_at: new Date().toISOString(),
  }).eq('id', sourceId);

  // ZONE C: NOT automatic — return candidates for user approval
  const memoryCandidates = extraction.items.filter(i => i.isStableInsight);

  return {
    zoneA: { itemCount: 1 },
    zoneB: zoneBItems.length,
    memoryCandidates,
  };
}

/**
 * Approve specific items to be promoted to Zone C (memory).
 * @param {string} sourceId
 * @param {string[]} itemIds - IDs of source_items to approve
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
 * Use Claude Sonnet to extract structured insights from raw import content.
 */
async function extractInsights(rawContent, source) {
  const extractionPrompt = `Analysiere diesen Import von ${source} und extrahiere strukturierte Insights.
Gib ein JSON-Array zurück mit Objekten die jeweils haben:
- type: "preference" | "project" | "pattern" | "personal" | "communication" | "work"
- summary: einzeilige Zusammenfassung
- content: der relevante Inhalt
- insights: { key: value } Paare mit den wichtigsten Fakten
- isStableInsight: true wenn das ein stabiler Fakt ist (Name, Beruf, Ort), false wenn temporär

Antworte NUR mit dem JSON-Array, kein anderer Text.

IMPORT-INHALT:
${rawContent.slice(0, 8000)}`;

  try {
    const adapter = getAdapter('anthropic');
    const response = await adapter.complete({
      messages: [{ role: 'user', content: extractionPrompt }],
      model: 'claude-sonnet-4-6',
      maxTokens: 2048,
      temperature: 0.3,
    });

    // Parse JSON from response
    const jsonMatch = response.content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const items = JSON.parse(jsonMatch[0]);
      return { items: Array.isArray(items) ? items : [] };
    }
  } catch (err) {
    console.error('Insight extraction failed:', err?.message);
  }

  // Fallback: single item with raw content
  return {
    items: [{
      type: 'chat_summary',
      summary: `Import von ${source}`,
      content: rawContent.slice(0, 2000),
      insights: {},
      isStableInsight: false,
    }],
  };
}
