// lib/google-token.js — Token-Refresh fuer Google OAuth
// Gibt immer einen gueltigen Access-Token zurueck oder null.
// Deaktiviert die Integration automatisch wenn Refresh fehlschlaegt.

import { createClient } from '@supabase/supabase-js';
import { encrypt, decrypt } from './crypto.js';

export async function getValidToken(userId, provider = 'google') {
  let supabase;
  try {
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  } catch (e) {
    console.error(`[token] Supabase client creation failed:`, e?.message);
    return null;
  }

  try {
    const { data: integration, error: fetchErr } = await supabase
      .from('user_integrations')
      .select('access_token, refresh_token, token_expires_at')
      .eq('user_id', userId)
      .eq('provider', provider)
      .eq('is_active', true)
      .single();

    if (fetchErr || !integration) {
      console.warn(`[token] No active integration for ${provider}:`, fetchErr?.message);
      return null;
    }

    // Token noch gueltig? (5 Min Puffer)
    const expiresAt = new Date(integration.token_expires_at);
    const isValid = expiresAt > new Date(Date.now() + 5 * 60 * 1000);

    if (isValid) {
      try {
        return decrypt(integration.access_token);
      } catch (e) {
        console.error(`[token] ${provider} decrypt access_token failed:`, e?.message);
        await writeError(supabase, userId, provider, `Decrypt access_token failed: ${e?.message}`);
        return null;
      }
    }

    console.log(`[token] ${provider} expired at ${expiresAt.toISOString()}, refreshing...`);

    // Refresh noetig
    if (!integration.refresh_token) {
      console.warn(`[token] ${provider} no refresh token`);
      await writeError(supabase, userId, provider, 'No refresh token available');
      return null;
    }

    let decryptedRefreshToken;
    try {
      decryptedRefreshToken = decrypt(integration.refresh_token);
    } catch (e) {
      console.error(`[token] ${provider} decrypt refresh_token failed:`, e?.message);
      await writeError(supabase, userId, provider, `Decrypt refresh_token failed: ${e?.message}`);
      return null;
    }

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: decryptedRefreshToken,
        grant_type:    'refresh_token',
      }),
      signal: AbortSignal.timeout(5000),
    });

    const newTokens = await res.json();

    if (newTokens.error) {
      const errMsg = `Refresh failed: ${newTokens.error} — ${newTokens.error_description || ''}`;
      console.error(`[token] ${provider}:`, errMsg);
      await supabase.from('user_integrations')
        .update({ is_active: false, last_error: errMsg })
        .eq('user_id', userId).eq('provider', provider);
      return null;
    }

    const { error: updateErr } = await supabase.from('user_integrations').update({
      access_token:      encrypt(newTokens.access_token),
      token_expires_at:  new Date(Date.now() + newTokens.expires_in * 1000).toISOString(),
      last_refreshed_at: new Date().toISOString(),
      last_used_at:      new Date().toISOString(),
      last_error:        null,
    }).eq('user_id', userId).eq('provider', provider);

    if (updateErr) {
      console.error(`[token] ${provider} DB update failed:`, updateErr.message);
    }

    console.log(`[token] ${provider} refreshed successfully`);
    return newTokens.access_token;
  } catch (e) {
    console.error(`[token] ${provider} unexpected error:`, e?.message);
    // Best-effort: versuche den Fehler in die DB zu schreiben
    await writeError(supabase, userId, provider, `Unexpected: ${e?.message}`);
    return null;
  }
}

async function writeError(supabase, userId, provider, message) {
  try {
    await supabase.from('user_integrations')
      .update({ last_error: message })
      .eq('user_id', userId).eq('provider', provider);
  } catch (_) {
    // DB write selbst fehlgeschlagen — nichts mehr was wir tun koennen
  }
}
