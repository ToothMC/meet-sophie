// lib/google-token.js — Token-Refresh fuer Google OAuth
// Gibt immer einen gueltigen Access-Token zurueck oder null.
// Deaktiviert die Integration automatisch wenn Refresh fehlschlaegt.

import { createClient } from '@supabase/supabase-js';
import { encrypt, decrypt } from './crypto.js';

export async function getValidToken(userId, provider = 'google_calendar') {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: integration } = await supabase
    .from('user_integrations')
    .select('access_token, refresh_token, token_expires_at')
    .eq('user_id', userId)
    .eq('provider', provider)
    .eq('is_active', true)
    .single();

  if (!integration) return null;

  // Token noch gueltig? (5 Min Puffer)
  const isValid = new Date(integration.token_expires_at) > new Date(Date.now() + 5 * 60 * 1000);
  if (isValid) return decrypt(integration.access_token);

  // Refresh noetig
  if (!integration.refresh_token) {
    await supabase.from('user_integrations')
      .update({ is_active: false, last_error: 'No refresh token available' })
      .eq('user_id', userId).eq('provider', provider);
    return null;
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: decrypt(integration.refresh_token),
      grant_type:    'refresh_token',
    }),
  });

  const newTokens = await res.json();

  if (newTokens.error) {
    await supabase.from('user_integrations')
      .update({ is_active: false, last_error: `Refresh failed: ${newTokens.error}` })
      .eq('user_id', userId).eq('provider', provider);
    return null;
  }

  await supabase.from('user_integrations').update({
    access_token:      encrypt(newTokens.access_token),
    token_expires_at:  new Date(Date.now() + newTokens.expires_in * 1000).toISOString(),
    last_refreshed_at: new Date().toISOString(),
    last_used_at:      new Date().toISOString(),
    last_error:        null,
  }).eq('user_id', userId).eq('provider', provider);

  return newTokens.access_token;
}
