// lib/import/source-ledger.js — CRUD for Source Connections (Transparency UI)
import { createClient } from '@supabase/supabase-js';

function getServiceClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Create a new source connection.
 * @param {{ userId: string, sourceType: string, sourceName: string, importMethod: 'chat_paste' | 'file_upload' }} opts
 * @returns {Promise<string>} sourceId
 */
export async function createSource({ userId, sourceType, sourceName, importMethod }) {
  const supabase = getServiceClient();
  const { data, error } = await supabase.from('source_connections').insert({
    user_id: userId,
    source_type: sourceType,
    source_name: sourceName,
    import_method: importMethod,
    status: 'active',
  }).select('id').single();

  if (error) throw new Error(`Failed to create source: ${error.message}`);
  return data.id;
}

/**
 * List all sources for a user.
 * @param {string} userId
 */
export async function listSources(userId) {
  const { data } = await getServiceClient()
    .from('source_connections')
    .select('*')
    .eq('user_id', userId)
    .neq('status', 'deleted')
    .order('created_at', { ascending: false });
  return data || [];
}

/**
 * Get a single source with its items.
 * @param {string} sourceId
 */
export async function getSource(sourceId) {
  const supabase = getServiceClient();
  const { data: source } = await supabase.from('source_connections').select('*').eq('id', sourceId).single();
  const { data: items } = await supabase.from('source_items').select('*').eq('source_id', sourceId).order('created_at');
  return { source, items: items || [] };
}

/**
 * Decouple a source — keep insights but mark as decoupled.
 * @param {string} sourceId
 * @param {string} userId
 */
export async function decoupleSource(sourceId, userId) {
  const supabase = getServiceClient();

  await supabase.from('source_connections').update({ status: 'decoupled' }).eq('id', sourceId);

  // Log deletion
  await supabase.from('source_deletion_log').insert({
    source_id: sourceId,
    user_id: userId,
    deletion_type: 'decouple',
    zones_cleared: ['A'],
  });

  // Delete raw data (Zone A) but keep insights (Zone B/C)
  await supabase.from('source_items').delete().eq('source_id', sourceId).eq('zone', 'A');
}

/**
 * Delete raw data only (Zone A).
 * @param {string} sourceId
 * @param {string} userId
 */
export async function deleteRawData(sourceId, userId) {
  const supabase = getServiceClient();

  await supabase.from('source_deletion_log').insert({
    source_id: sourceId,
    user_id: userId,
    deletion_type: 'raw_data',
    zones_cleared: ['A'],
  });

  await supabase.from('source_items').delete().eq('source_id', sourceId).eq('zone', 'A');
}

/**
 * Delete everything — full removal of source and all data.
 * @param {string} sourceId
 * @param {string} userId
 */
export async function deleteAll(sourceId, userId) {
  const supabase = getServiceClient();

  await supabase.from('source_deletion_log').insert({
    source_id: sourceId,
    user_id: userId,
    deletion_type: 'all',
    zones_cleared: ['A', 'B', 'C'],
  });

  // Delete items first (FK constraint), then connection
  await supabase.from('source_permissions').delete().eq('source_id', sourceId);
  await supabase.from('source_items').delete().eq('source_id', sourceId);
  await supabase.from('source_connections').update({ status: 'deleted' }).eq('id', sourceId);
}
