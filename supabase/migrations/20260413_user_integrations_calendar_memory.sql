-- ─────────────────────────────────────────────────────────
-- Patch 1 v5: user_integrations + sophie_calendar_memory
-- Provider-agnostische Integrations-Tabelle + Kalender-Workspace
-- Spec: sophie-phase0-patch1-v5
-- ─────────────────────────────────────────────────────────


-- ─────────────────────────────────────────────────────────
-- 1. INTEGRATIONS-TABELLE
-- Provider-agnostisch: Google ist der erste, Outlook/Apple
-- koennen spaeter ohne Schema-Aenderung rein.
-- ─────────────────────────────────────────────────────────

CREATE TABLE user_integrations (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Provider-agnostisch
  provider         TEXT        NOT NULL,                    -- 'google_calendar', 'outlook_calendar', ...
  provider_type    TEXT        NOT NULL DEFAULT 'calendar', -- 'calendar', 'email', 'smart_home', ...
  account_email    TEXT,                                    -- Anzeigename des verbundenen Accounts

  -- OAuth-Tokens (nur server-seitig lesbar via Service Role)
  access_token     TEXT,
  refresh_token    TEXT,
  token_expires_at TIMESTAMPTZ,
  scopes           TEXT[],                                  -- Gewaehrte OAuth-Scopes

  -- Status
  is_active        BOOLEAN     NOT NULL DEFAULT true,
  connected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at     TIMESTAMPTZ,
  last_error       TEXT,                                    -- Letzter Fehler (z.B. Token-Refresh failed)

  -- Metadaten fuer Provider-spezifische Konfiguration
  -- z.B. { "calendar_id": "primary", "sync_enabled": true }
  metadata         JSONB       DEFAULT '{}',

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Ein User + ein Provider + ein Account = eine Zeile
  UNIQUE(user_id, provider, account_email)
);


-- ─────────────────────────────────────────────────────────
-- 2. INDIZES
-- ─────────────────────────────────────────────────────────

CREATE INDEX idx_integrations_user_active
  ON user_integrations(user_id, is_active)
  WHERE is_active = true;

CREATE INDEX idx_integrations_provider_type
  ON user_integrations(provider_type);

CREATE INDEX idx_integrations_token_expiry
  ON user_integrations(token_expires_at)
  WHERE is_active = true;


-- ─────────────────────────────────────────────────────────
-- 3. RLS — Client darf NICHTS. Kein SELECT, kein INSERT.
-- Service Role (Vercel Functions) bypassed RLS sowieso.
-- ─────────────────────────────────────────────────────────

ALTER TABLE user_integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "integrations_server_only" ON user_integrations
  FOR ALL USING (false) WITH CHECK (false);

-- Doppelte Absicherung: auch auf Grant-Ebene gesperrt.
-- Supabase gibt standardmaessig SELECT auf public-Schema frei.
REVOKE ALL ON user_integrations FROM authenticated;
REVOKE ALL ON user_integrations FROM anon;


-- ─────────────────────────────────────────────────────────
-- 4. KALENDER-MEMORY WORKSPACE (Layer D)
-- Strukturierte JSONB-Felder statt Freitext —
-- vorbereitet fuer spaeteres pgvector / Semantic Search.
-- ─────────────────────────────────────────────────────────

CREATE TABLE sophie_calendar_memory (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id               UUID        REFERENCES user_sessions(id),

  -- Strukturierte Metadaten
  upcoming_events          JSONB,      -- Naechste relevante Events mit Teilnehmern, Thema
  recurring_patterns       JSONB,      -- "Montags immer Standup", "Freitags keine Meetings"
  scheduling_preferences   JSONB,      -- "Morgens produktiv", "Nachmittags Meetings"
  context_links            JSONB,      -- Verknuepfungen zu anderen Modi

  -- Cross-Mode Referenz
  linked_meeting_id        UUID        REFERENCES meetings(id),

  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at               TIMESTAMPTZ,

  -- Ein Workspace pro User, wird aktualisiert (nicht appended)
  UNIQUE(user_id)
);

ALTER TABLE sophie_calendar_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "calendar_memory_server_only" ON sophie_calendar_memory
  FOR ALL USING (false) WITH CHECK (false);

REVOKE ALL ON sophie_calendar_memory FROM authenticated;
REVOKE ALL ON sophie_calendar_memory FROM anon;


-- ─────────────────────────────────────────────────────────
-- 5. UPDATED_AT TRIGGER
-- ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON user_integrations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON sophie_calendar_memory
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
