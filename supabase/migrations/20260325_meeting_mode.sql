-- ============================================================
-- Meeting Mode Schema — Phase A
-- Tables: meetings, meeting_context, meeting_notes, meeting_summary
-- ============================================================

-- meetings: Haupt-Tabelle für Meeting-Sessions
CREATE TABLE IF NOT EXISTS meetings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title           text,
  meeting_type    text NOT NULL DEFAULT 'other'
                    CHECK (meeting_type IN ('team','client','strategy','other')),
  phase           text NOT NULL DEFAULT 'prep'
                    CHECK (phase IN ('prep','live','post','closed')),
  sophie_role     text NOT NULL DEFAULT 'co-think'
                    CHECK (sophie_role IN ('prepare','co-think','document')),
  parent_meeting_id uuid REFERENCES meetings(id) ON DELETE SET NULL,
  started_at      timestamptz,
  ended_at        timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- meeting_context: Uploads, Agenda, Teilnehmer, Ziele
CREATE TABLE IF NOT EXISTS meeting_context (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id      uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  context_type    text NOT NULL
                    CHECK (context_type IN ('agenda','participants','goal','text_note')),
  content         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- meeting_notes: Live-Mitschrift, Decisions, Actions, Risks
CREATE TABLE IF NOT EXISTS meeting_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id      uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  note_type       text NOT NULL
                    CHECK (note_type IN ('note','decision','action','risk','open_point')),
  content         text NOT NULL,
  is_confirmed    boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- meeting_summary: POST-Phase structured output
CREATE TABLE IF NOT EXISTS meeting_summary (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id      uuid NOT NULL UNIQUE REFERENCES meetings(id) ON DELETE CASCADE,
  short_summary   text,
  decisions       jsonb NOT NULL DEFAULT '[]'::jsonb,
  action_items    jsonb NOT NULL DEFAULT '[]'::jsonb,
  open_points     jsonb NOT NULL DEFAULT '[]'::jsonb,
  risks           jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_meetings_user_id ON meetings(user_id);
CREATE INDEX idx_meetings_phase ON meetings(phase);
CREATE INDEX idx_meeting_context_meeting_id ON meeting_context(meeting_id);
CREATE INDEX idx_meeting_notes_meeting_id ON meeting_notes(meeting_id);

-- ============================================================
-- RLS Policies
-- ============================================================
ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_summary ENABLE ROW LEVEL SECURITY;

-- meetings: user sees/manages own meetings
CREATE POLICY meetings_select ON meetings FOR SELECT
  TO authenticated USING (auth.uid() = user_id);
CREATE POLICY meetings_insert ON meetings FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY meetings_update ON meetings FOR UPDATE
  TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- meeting_context: access via meeting ownership
CREATE POLICY meeting_context_select ON meeting_context FOR SELECT
  TO authenticated USING (
    EXISTS (SELECT 1 FROM meetings WHERE meetings.id = meeting_context.meeting_id AND meetings.user_id = auth.uid())
  );
CREATE POLICY meeting_context_insert ON meeting_context FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM meetings WHERE meetings.id = meeting_context.meeting_id AND meetings.user_id = auth.uid())
  );

-- meeting_notes: access via meeting ownership
CREATE POLICY meeting_notes_select ON meeting_notes FOR SELECT
  TO authenticated USING (
    EXISTS (SELECT 1 FROM meetings WHERE meetings.id = meeting_notes.meeting_id AND meetings.user_id = auth.uid())
  );
CREATE POLICY meeting_notes_insert ON meeting_notes FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM meetings WHERE meetings.id = meeting_notes.meeting_id AND meetings.user_id = auth.uid())
  );

-- meeting_summary: access via meeting ownership
CREATE POLICY meeting_summary_select ON meeting_summary FOR SELECT
  TO authenticated USING (
    EXISTS (SELECT 1 FROM meetings WHERE meetings.id = meeting_summary.meeting_id AND meetings.user_id = auth.uid())
  );
CREATE POLICY meeting_summary_insert ON meeting_summary FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM meetings WHERE meetings.id = meeting_summary.meeting_id AND meetings.user_id = auth.uid())
  );
CREATE POLICY meeting_summary_update ON meeting_summary FOR UPDATE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM meetings WHERE meetings.id = meeting_summary.meeting_id AND meetings.user_id = auth.uid())
  );
