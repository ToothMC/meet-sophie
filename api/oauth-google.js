// api/oauth-google.js — Google OAuth Connect + Callback
// Provider-spezifischer OAuth-Flow. Schreibt in die generische user_integrations Tabelle.
// Spec: sophie-phase0-final

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { encrypt, decrypt } from '../lib/crypto.js';

const GOOGLE_AUTH_URL   = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL  = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const REDIRECT_URI      = `${process.env.BASE_URL}/api/oauth-google`;

const SCOPES = {
  google_calendar: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/contacts.other.readonly',
  google_mail: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
};

const PROVIDER_TYPES = {
  google_calendar: 'calendar',
  google_mail: 'email',
};

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function getUserId(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const { data: { user } } = await getSupabase().auth.getUser(token);
  return user?.id || null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.BASE_URL);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;
  const supabase = getSupabase();

  // ── Connect ─────────────────────────────────────────────
  if (action === 'connect' && req.method === 'GET') {
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const provider = req.query.provider || 'google_calendar';
    if (!SCOPES[provider]) return res.status(400).json({ error: 'Unknown provider' });

    // Opportunistisches Cleanup abgelaufener States
    await supabase.from('oauth_states').delete()
      .or(`expires_at.lt.${new Date().toISOString()},used.eq.true`);

    const state = crypto.randomBytes(32).toString('hex');
    await supabase.from('oauth_states').insert({
      state, user_id: userId, provider,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });

    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set('client_id',             process.env.GOOGLE_CLIENT_ID);
    url.searchParams.set('redirect_uri',           REDIRECT_URI);
    url.searchParams.set('response_type',          'code');
    url.searchParams.set('scope',                  SCOPES[provider]);
    url.searchParams.set('access_type',            'offline');
    url.searchParams.set('prompt',                 'consent');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('state',                  state);

    return res.json({ url: url.toString() });
  }

  // ── Callback ────────────────────────────────────────────
  if (req.method === 'GET' && req.query.code) {
    const { code, state, error } = req.query;

    if (error || !state || !code) {
      return res.send(callbackHtml('error', 'oauth_failed', process.env.BASE_URL));
    }

    // State validieren: einmalig, nicht abgelaufen
    const { data: stateRow } = await supabase
      .from('oauth_states')
      .select('*')
      .eq('state', state)
      .eq('used', false)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (!stateRow) {
      return res.send(callbackHtml('error', 'invalid_state', process.env.BASE_URL));
    }

    // State sofort als used markieren (one-time use)
    await supabase.from('oauth_states').update({ used: true }).eq('state', state);

    const { user_id: userId, provider } = stateRow;

    // Token-Exchange: Authorization Code → Access + Refresh Token
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, grant_type: 'authorization_code',
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  REDIRECT_URI,
      }),
    });

    const tokens = await tokenRes.json();
    if (tokens.error) {
      return res.send(callbackHtml('error', 'token_exchange_failed', process.env.BASE_URL));
    }

    // Account-Email holen fuer Anzeige + UNIQUE-Constraint
    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const userInfo = await userInfoRes.json();

    // Upsert in user_integrations — zukunftssicher mit account_email im UNIQUE
    await supabase.from('user_integrations').upsert({
      user_id:          userId,
      provider,
      provider_type:    PROVIDER_TYPES[provider] || 'other',
      account_email:    userInfo.email || null,
      access_token:     encrypt(tokens.access_token),
      refresh_token:    tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
      token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      scopes:           tokens.scope?.split(' ') || [],
      is_active:        true,
      connected_at:     new Date().toISOString(),
      last_error:       null,
    }, { onConflict: 'user_id,provider,account_email' });

    return res.send(callbackHtml('success', provider, process.env.BASE_URL));
  }

  // ── Disconnect ──────────────────────────────────────────
  if (action === 'disconnect' && req.method === 'POST') {
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { provider, integrationId } = req.body || {};
    if (!provider && !integrationId) return res.status(400).json({ error: 'provider or integrationId required' });

    // Integration laden
    let query = supabase.from('user_integrations')
      .select('id, access_token, refresh_token')
      .eq('user_id', userId);

    if (integrationId) query = query.eq('id', integrationId);
    else query = query.eq('provider', provider);

    const { data: integration } = await query.single();

    // Google-seitig revoken
    if (integration) {
      const tokenToRevoke = integration.refresh_token
        ? decrypt(integration.refresh_token)
        : integration.access_token
          ? decrypt(integration.access_token)
          : null;

      if (tokenToRevoke) {
        try {
          await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(tokenToRevoke)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          });
        } catch (_) {
          // Netzwerkfehler beim Revoke → lokal trotzdem aufraeumen
        }
      }
    }

    // Lokal deaktivieren + Tokens loeschen
    let updateQuery = supabase.from('user_integrations')
      .update({ is_active: false, access_token: '', refresh_token: null, last_error: null })
      .eq('user_id', userId);

    if (integrationId) updateQuery = updateQuery.eq('id', integrationId);
    else updateQuery = updateQuery.eq('provider', provider);

    await updateQuery;

    return res.json({ success: true });
  }

  return res.status(400).json({ error: 'Unknown action' });
}

// Callback-HTML: postMessage an Opener, dann Fenster schliessen
function callbackHtml(type, payload, origin) {
  const safeType    = type === 'success' ? 'success' : 'error';
  const safePayload = String(payload).replace(/[^a-z0-9_-]/gi, '');

  return `<!DOCTYPE html>
<html><head><title>Sophie</title></head>
<body>
<script>
  (function() {
    var msg = { type: 'sophie-oauth-${safeType}', ${safeType === 'success' ? 'provider' : 'error'}: '${safePayload}' };
    if (window.opener) {
      window.opener.postMessage(msg, '${origin}');
      window.close();
    } else {
      var qs = msg.type === 'sophie-oauth-success'
        ? 'integration_success=' + msg.provider
        : 'integration_error=' + msg.error;
      window.location.href = '${origin}/settings?' + qs;
    }
  })();
</script>
<p>Verbinden... dieses Fenster schliesst automatisch.</p>
</body></html>`;
}
