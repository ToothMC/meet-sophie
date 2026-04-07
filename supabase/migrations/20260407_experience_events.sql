-- Experience Intelligence Phase 1: analytics_events formalisieren
-- Tabelle existiert in Prod (manuell erstellt), aber ohne Migration.
-- CREATE TABLE IF NOT EXISTS macht beides sicher: neue + bestehende Umgebungen.

CREATE TABLE IF NOT EXISTS analytics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID UNIQUE DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  anonymous_id TEXT,
  session_id UUID,
  event_name TEXT NOT NULL,
  page TEXT,
  device TEXT,
  source TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Falls Tabelle schon existierte: fehlende Spalten ergaenzen
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'analytics_events' AND column_name = 'event_id') THEN
    ALTER TABLE analytics_events ADD COLUMN event_id UUID UNIQUE DEFAULT gen_random_uuid();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'analytics_events' AND column_name = 'anonymous_id') THEN
    ALTER TABLE analytics_events ADD COLUMN anonymous_id TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'analytics_events' AND column_name = 'session_id') THEN
    ALTER TABLE analytics_events ADD COLUMN session_id UUID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'analytics_events' AND column_name = 'page') THEN
    ALTER TABLE analytics_events ADD COLUMN page TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'analytics_events' AND column_name = 'device') THEN
    ALTER TABLE analytics_events ADD COLUMN device TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'analytics_events' AND column_name = 'source') THEN
    ALTER TABLE analytics_events ADD COLUMN source TEXT;
  END IF;
END $$;

-- Indexe fuer Funnel-Queries
CREATE INDEX IF NOT EXISTS idx_ae_name_created ON analytics_events(event_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ae_anon ON analytics_events(anonymous_id, created_at DESC) WHERE anonymous_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ae_session ON analytics_events(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ae_created ON analytics_events(created_at DESC);

-- RLS: Nur Server schreibt/liest. Kein Client-Zugriff.
ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS analytics_service_all ON analytics_events;
CREATE POLICY analytics_service_all ON analytics_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);
