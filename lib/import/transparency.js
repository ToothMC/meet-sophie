// lib/import/transparency.js — Track which source contributed to Sophie's knowledge
import { createClient } from '@supabase/supabase-js';

function getServiceClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Get attribution info: which sources contributed to the user's profile.
 * @param {string} userId
 * @returns {Promise<Array<{ sourceId: string, sourceName: string, sourceType: string, itemCount: number, zones: string[] }>>}
 */
export async function getSourceAttribution(userId) {
  const supabase = getServiceClient();

  const { data: sources } = await supabase
    .from('source_connections')
    .select('id, source_name, source_type, item_count, status')
    .eq('user_id', userId)
    .neq('status', 'deleted')
    .order('created_at', { ascending: false });

  if (!sources?.length) return [];

  const result = [];
  for (const s of sources) {
    const { data: items } = await supabase
      .from('source_items')
      .select('zone')
      .eq('source_id', s.id);

    const zones = [...new Set((items || []).map(i => i.zone))];
    result.push({
      sourceId: s.id,
      sourceName: s.source_name,
      sourceType: s.source_type,
      itemCount: s.item_count || 0,
      status: s.status,
      zones,
    });
  }

  return result;
}

/**
 * Build a transparency note for Sophie's responses.
 * Returns a short string indicating the source(s) of knowledge used.
 * @param {string} userId
 * @returns {Promise<string>}
 */
export async function buildTransparencyNote(userId) {
  const attributions = await getSourceAttribution(userId);
  if (attributions.length === 0) return '';

  const activeNames = attributions
    .filter(a => a.status === 'active')
    .map(a => a.sourceName);

  if (activeNames.length === 0) return '';
  return `[Kontext aus: ${activeNames.join(', ')}]`;
}
