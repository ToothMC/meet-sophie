-- Sophie Unfiltered — Story-Threads, Events, Boundaries, Briefings.
-- Unfiltered ist ein Substate des Talk-Modus (kein eigener sophie_mode).
-- Eigene Tabellen, weil Story-Threads soziale Spannungsbögen sind und
-- andere Compaction-/Sensitivity-Logik brauchen als das bestehende
-- sophie_*_memory-System (N/K/M/L).
--
-- Tone-Stufen: nicht persistiert — es gibt nur "raw" (ungeschönt).
--
-- Persistenz des Toggle-Zustands läuft über user_sessions.unfiltered_active,
-- damit Analytics/Memory-Scoping nachvollziehen kann, in welchen Sessions
-- Unfiltered aktiv war.

BEGIN;

-- ---------------------------------------------------------------------------
-- Story-Threads: laufende soziale Spannungsbögen
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.unf_threads (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title             text NOT NULL,
  people            text[] NOT NULL DEFAULT '{}',
  context           text,
  suspected_dynamic text,
  status            text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','paused','resolved','archived')),
  confidence        text DEFAULT 'medium'
                      CHECK (confidence IN ('low','medium','high')),
  sensitivity       text DEFAULT 'normal'
                      CHECK (sensitivity IN ('normal','sensitive')),
  story_score       smallint CHECK (story_score BETWEEN 0 AND 10),
  evidence_score    smallint CHECK (evidence_score BETWEEN 0 AND 10),
  last_update       timestamptz NOT NULL DEFAULT now(),
  retention_days    int,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_unf_threads_user_recent
  ON public.unf_threads (user_id, last_update DESC);

CREATE INDEX IF NOT EXISTS idx_unf_threads_people
  ON public.unf_threads USING gin (people);

ALTER TABLE public.unf_threads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS unf_threads_owner ON public.unf_threads;
CREATE POLICY unf_threads_owner ON public.unf_threads
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Story-Events: einzelne Vorkommnisse, gebunden an Thread
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.unf_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id         uuid NOT NULL REFERENCES public.unf_threads(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  happened_at       timestamptz NOT NULL DEFAULT now(),
  what              text NOT NULL,
  quote             text,
  user_feeling      text,
  sophie_take       text,
  next_watch_signal text,
  source            text DEFAULT 'voice'
                      CHECK (source IN ('voice','chat','receipts')),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_unf_events_thread_recent
  ON public.unf_events (thread_id, happened_at DESC);

ALTER TABLE public.unf_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS unf_events_owner ON public.unf_events;
CREATE POLICY unf_events_owner ON public.unf_events
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Boundaries: User-Präferenzen (Blocklist, Retention, Briefing-Interessen).
-- Bewusst KEIN default_tone — Unfiltered hat nur "raw".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.unf_boundaries (
  user_id                uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_people         text[] NOT NULL DEFAULT '{}',
  avoid_topics           text[] NOT NULL DEFAULT '{}',
  no_memory_people       text[] NOT NULL DEFAULT '{}',
  default_retention_days int,
  anonymize_names        boolean NOT NULL DEFAULT false,
  interests              text[] NOT NULL DEFAULT '{}',
  geo_country            text NOT NULL DEFAULT 'DE',
  updated_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.unf_boundaries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS unf_boundaries_owner ON public.unf_boundaries;
CREATE POLICY unf_boundaries_owner ON public.unf_boundaries
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Daily Briefings: pro User pro Tag gecached.
-- language ist Teil des Keys, damit DE und EN parallel gecached werden können.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.unf_briefings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  briefing_date  date NOT NULL,
  language       text NOT NULL DEFAULT 'de',
  stories        jsonb NOT NULL,
  source_count   int NOT NULL DEFAULT 0,
  generated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, briefing_date, language)
);

CREATE INDEX IF NOT EXISTS idx_unf_briefings_user_date
  ON public.unf_briefings (user_id, briefing_date DESC);

ALTER TABLE public.unf_briefings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS unf_briefings_owner ON public.unf_briefings;
CREATE POLICY unf_briefings_owner ON public.unf_briefings
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Cleanup-Funktion für Retention. Per Cron-Job aufrufen.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.unf_cleanup_expired()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.unf_threads
   WHERE retention_days IS NOT NULL
     AND last_update < now() - (retention_days || ' days')::interval;
END;
$$;

REVOKE ALL ON FUNCTION public.unf_cleanup_expired() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Session-Metadata: war Unfiltered in dieser Session aktiv?
-- IF NOT EXISTS für Re-Run-Sicherheit (user_sessions existiert seit 20260314).
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_sessions
  ADD COLUMN IF NOT EXISTS unfiltered_active boolean NOT NULL DEFAULT false;

COMMIT;
