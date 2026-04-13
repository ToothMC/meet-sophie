// api/integrations.js — Provider-uebergreifende Integrations-API
// Gibt NIEMALS Token-Felder zurueck. Service Role only.
// Spec: sophie-phase0-patch1-v5

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Missing Supabase env vars' });
  }

  // Auth — identisch zu allen anderen Endpoints
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  const action = req.query?.action || '';

  // ── GET: Status — alle aktiven Integrationen des Users ──
  // Normalisierte Antwort: Client sieht keine Scopes/Token-Details.
  // "Sophie sitzt davor."
  if (action === 'status' && req.method === 'GET') {
    const { data, error } = await supabase
      .from('user_integrations')
      .select([
        'id',
        'provider',
        'provider_type',
        'account_email',
        'is_active',
        'connected_at',
        'last_used_at',
        'last_error',
        // NIEMALS: access_token, refresh_token, scopes
      ].join(', '))
      .eq('user_id', user.id)
      .eq('is_active', true);

    if (error) return res.status(500).json({ error: 'Failed to fetch integrations' });

    return res.status(200).json({
      integrations: (data || []).map(row => ({
        id:          row.id,
        provider:    row.provider,
        type:        row.provider_type,
        label:       row.account_email || row.provider,
        connected:   true,
        connectedAt: row.connected_at,
        lastUsed:    row.last_used_at,
        hasError:    !!row.last_error,
      })),
    });
  }

  // ── POST: Disconnect — Integration deaktivieren ──
  // Soft-Delete: is_active = false, Tokens loeschen.
  if (action === 'disconnect' && req.method === 'POST') {
    const { integrationId } = req.body || {};
    if (!integrationId) return res.status(400).json({ error: 'Missing integrationId' });

    // Sicherstellen, dass die Integration dem User gehoert
    const { data: existing } = await supabase
      .from('user_integrations')
      .select('id')
      .eq('id', integrationId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (!existing) return res.status(404).json({ error: 'Integration not found' });

    const { error } = await supabase
      .from('user_integrations')
      .update({
        is_active:     false,
        access_token:  null,
        refresh_token: null,
        last_error:    null,
      })
      .eq('id', integrationId)
      .eq('user_id', user.id);

    if (error) return res.status(500).json({ error: 'Failed to disconnect' });

    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: `Unknown action: ${action}` });
}
