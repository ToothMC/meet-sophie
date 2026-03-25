-- ─────────────────────────────────────────────────────────
-- Sophie Memory System — Schema + RLS
-- Spec: sophie-memory-code-spec01
-- ─────────────────────────────────────────────────────────


-- ─────────────────────────────────────────────────────────
-- ENUMS
-- ─────────────────────────────────────────────────────────

CREATE TYPE sophie_mode AS ENUM (
  'assistant', 'friend', 'partner',
  'meeting', 'brainstorm', 'sales_pitch'
);

CREATE TYPE memory_depth AS ENUM ('light', 'medium', 'deep', 'scoped');
CREATE TYPE security_level AS ENUM ('confidential', 'enterprise');


-- ─────────────────────────────────────────────────────────
-- B: KURZZEITGEDAECHTNIS
-- TTL gesteuert ueber expires_at. Cleanup via pg_cron oder Edge Function.
-- ─────────────────────────────────────────────────────────

CREATE TABLE sophie_short_term_memory (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id    uuid        NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  mode               sophie_mode NOT NULL,
  summary            text        NOT NULL,
  open_topics        text[]      NOT NULL DEFAULT '{}',
  pending_decisions  text[]      NOT NULL DEFAULT '{}',
  next_steps         text[]      NOT NULL DEFAULT '{}',
  importance_score   float4      NOT NULL DEFAULT 0.5,
  expires_at         timestamptz NOT NULL DEFAULT now() + interval '30 days',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON sophie_short_term_memory (user_id, mode);
CREATE INDEX ON sophie_short_term_memory (expires_at);


-- ─────────────────────────────────────────────────────────
-- C: LANGZEITGEDAECHTNIS
-- Eine Zeile pro User. Wird periodisch verdichtet (nicht appended).
-- ─────────────────────────────────────────────────────────

CREATE TABLE sophie_long_term_memory (
  id                       uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid         UNIQUE NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  depth                    memory_depth NOT NULL DEFAULT 'light',
  communication_style      text,
  work_preferences         jsonb,
  recurring_topics         text[]       NOT NULL DEFAULT '{}',
  long_term_goals          text[]       NOT NULL DEFAULT '{}',

  -- Ab memory_depth = 'medium'
  personal_patterns        text[],
  emotional_tones          text[],
  typical_conflicts        text[],

  -- Nur memory_depth = 'deep'
  significant_developments text[],
  relationship_milestones  text[],

  last_condensed_at        timestamptz,
  created_at               timestamptz  NOT NULL DEFAULT now(),
  updated_at               timestamptz  NOT NULL DEFAULT now()
);


-- ─────────────────────────────────────────────────────────
-- D: ARBEITSRAUM MEETING
-- ─────────────────────────────────────────────────────────

CREATE TABLE sophie_meeting_memory (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id uuid        REFERENCES chat_sessions(id),
  title           text        NOT NULL,
  participants    text[]      NOT NULL DEFAULT '{}',
  decisions       text[]      NOT NULL DEFAULT '{}',
  open_points     text[]      NOT NULL DEFAULT '{}',
  follow_ups      jsonb       NOT NULL DEFAULT '[]',
  risks           text[]      NOT NULL DEFAULT '{}',
  conflicts       text[]      NOT NULL DEFAULT '{}',
  status          text        NOT NULL DEFAULT 'open',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON sophie_meeting_memory (user_id, created_at DESC);
CREATE INDEX ON sophie_meeting_memory (user_id, status);


-- ─────────────────────────────────────────────────────────
-- D: ARBEITSRAUM BRAINSTORMING
-- ─────────────────────────────────────────────────────────

CREATE TABLE sophie_brainstorm_memory (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id   uuid        REFERENCES chat_sessions(id),
  topic             text        NOT NULL,
  ideas             jsonb       NOT NULL DEFAULT '[]',
  clusters          text[]      NOT NULL DEFAULT '{}',
  prioritized_ideas text[]      NOT NULL DEFAULT '{}',
  discarded_ideas   text[]      NOT NULL DEFAULT '{}',
  linked_meeting_id uuid        REFERENCES sophie_meeting_memory(id),
  linked_pitch_id   uuid,       -- fk nach pitch table, see below
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON sophie_brainstorm_memory (user_id, created_at DESC);


-- ─────────────────────────────────────────────────────────
-- D: ARBEITSRAUM SALES PITCH
-- ─────────────────────────────────────────────────────────

CREATE TABLE sophie_pitch_memory (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id      uuid        REFERENCES chat_sessions(id),
  topic                text        NOT NULL,
  target_audience      text,
  score                int2        CHECK (score BETWEEN 0 AND 100),
  strengths            text[]      NOT NULL DEFAULT '{}',
  weaknesses           text[]      NOT NULL DEFAULT '{}',
  recurring_errors     text[]      NOT NULL DEFAULT '{}',
  critical_objections  text[]      NOT NULL DEFAULT '{}',
  version              int2        NOT NULL DEFAULT 1,
  parent_pitch_id      uuid        REFERENCES sophie_pitch_memory(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON sophie_pitch_memory (user_id, topic, created_at DESC);

-- FK zurueck von brainstorm auf pitch
ALTER TABLE sophie_brainstorm_memory
  ADD CONSTRAINT fk_linked_pitch
  FOREIGN KEY (linked_pitch_id) REFERENCES sophie_pitch_memory(id);


-- ─────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- Alle Memory-Tabellen: User sieht nur eigene Daten.
-- ─────────────────────────────────────────────────────────

ALTER TABLE sophie_short_term_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_owns_short_term_memory"
  ON sophie_short_term_memory
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

ALTER TABLE sophie_long_term_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_owns_long_term_memory"
  ON sophie_long_term_memory
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

ALTER TABLE sophie_meeting_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_owns_meeting_memory"
  ON sophie_meeting_memory
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

ALTER TABLE sophie_brainstorm_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_owns_brainstorm_memory"
  ON sophie_brainstorm_memory
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

ALTER TABLE sophie_pitch_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_owns_pitch_memory"
  ON sophie_pitch_memory
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
