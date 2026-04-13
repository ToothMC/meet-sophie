-- ─────────────────────────────────────────────────────────
-- Phase 0: Calendar Integration Layer (zukunftssicher)
-- user_integrations + oauth_states + sophie_calendar +
-- sophie_calendar_memory
-- Spec: sophie-phase0-final + patch1-v5 Vision-Alignment
-- ─────────────────────────────────────────────────────────


-- ─────────────────────────────────────────────────────────
-- 1. INTEGRATIONS-TABELLE
-- Provider-agnostisch: Google ist der erste, Outlook/Apple
-- koennen spaeter ohne Schema-Aenderung rein.
-- ─────────────────────────────────────────────────────────

CREATE TABLE user_integrations (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Provider-agnostisch
  provider          TEXT        NOT NULL,                    -- 'google_calendar', 'outlook_calendar', ...
  provider_type     TEXT        NOT NULL DEFAULT 'calendar', -- 'calendar', 'email', 'smart_home', ...
  account_email     TEXT,                                    -- Anzeigename des verbundenen Accounts

  -- OAuth-Tokens (AES-256-GCM verschluesselt, nur server-seitig lesbar)
  access_token      TEXT        NOT NULL DEFAULT '',
  refresh_token     TEXT,
  token_expires_at  TIMESTAMPTZ,
  scopes            TEXT[]      NOT NULL DEFAULT '{}',

  -- Status
  is_active         BOOLEAN     NOT NULL DEFAULT true,
  connected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at      TIMESTAMPTZ,
  last_refreshed_at TIMESTAMPTZ,
  last_error        TEXT,

  -- Metadaten fuer Provider-spezifische Konfiguration
  metadata          JSONB       NOT NULL DEFAULT '{}',

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Ein User + ein Provider + ein Account = eine Zeile
  UNIQUE(user_id, provider, account_email)
);

-- Indizes
CREATE INDEX idx_integrations_user_active
  ON user_integrations(user_id, is_active)
  WHERE is_active = true;

CREATE INDEX idx_integrations_provider_type
  ON user_integrations(provider_type);

CREATE INDEX idx_integrations_token_expiry
  ON user_integrations(token_expires_at)
  WHERE is_active = true;

-- RLS: kein Client-Zugriff. AS RESTRICTIVE = nicht uebersteuerbar.
ALTER TABLE user_integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "integrations_server_only" ON user_integrations
  AS RESTRICTIVE
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON user_integrations FROM authenticated;
REVOKE ALL ON user_integrations FROM anon;


-- ─────────────────────────────────────────────────────────
-- 2. OAUTH STATE MANAGEMENT
-- CSRF-Schutz: kryptographisch zufaelliger State-Parameter.
-- Einmalige Verwendung, 10 Min TTL, pg_cron Cleanup.
-- ─────────────────────────────────────────────────────────

CREATE TABLE oauth_states (
  state      TEXT        PRIMARY KEY,
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider   TEXT        NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes',
  used       BOOLEAN     NOT NULL DEFAULT false
);

ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY "oauth_states_server_only" ON oauth_states
  AS RESTRICTIVE
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON oauth_states FROM authenticated;
REVOKE ALL ON oauth_states FROM anon;

-- pg_cron Cleanup: taeglich 03:00 UTC
SELECT cron.schedule(
  'cleanup-oauth-states',
  '0 3 * * *',
  $$ DELETE FROM public.oauth_states WHERE expires_at < NOW() OR used = true; $$
);


-- ─────────────────────────────────────────────────────────
-- 3. SOPHIE CALENDAR
-- Sophies eigener Kalender: Reminder, Followups, Suggestions.
-- Schema-only in Phase 0. Schreiblogik + iCal-Feed in Phase 1.
-- ─────────────────────────────────────────────────────────

CREATE TABLE sophie_calendar (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title             TEXT        NOT NULL,
  description       TEXT,
  start_at          TIMESTAMPTZ NOT NULL,
  end_at            TIMESTAMPTZ,
  entry_type        TEXT        NOT NULL DEFAULT 'reminder',
  -- Werte: 'reminder', 'followup', 'suggestion', 'note'
  source_session_id TEXT,
  is_confirmed      BOOLEAN     NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sophie_calendar ENABLE ROW LEVEL SECURITY;

-- User darf eigene Eintraege lesen und loeschen
CREATE POLICY "sophie_cal_select" ON sophie_calendar
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "sophie_cal_delete" ON sophie_calendar
  FOR DELETE USING (auth.uid() = user_id);

-- INSERT + UPDATE nur via Service Role
CREATE POLICY "sophie_cal_insert" ON sophie_calendar
  AS RESTRICTIVE FOR INSERT WITH CHECK (false);
CREATE POLICY "sophie_cal_update" ON sophie_calendar
  AS RESTRICTIVE FOR UPDATE USING (false) WITH CHECK (false);

CREATE INDEX idx_sc_user_time ON sophie_calendar(user_id, start_at);


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
  upcoming_events          JSONB,
  recurring_patterns       JSONB,
  scheduling_preferences   JSONB,
  context_links            JSONB,

  -- Cross-Mode Referenz
  linked_meeting_id        UUID        REFERENCES meetings(id),

  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at               TIMESTAMPTZ,

  UNIQUE(user_id)
);

ALTER TABLE sophie_calendar_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "calendar_memory_server_only" ON sophie_calendar_memory
  AS RESTRICTIVE
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

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
  BEFORE UPDATE ON sophie_calendar
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON sophie_calendar_memory
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ─────────────────────────────────────────────────────────
-- 6. ENUM ERWEITERUNG
-- ─────────────────────────────────────────────────────────

ALTER TYPE sophie_mode ADD VALUE IF NOT EXISTS 'calendar';
