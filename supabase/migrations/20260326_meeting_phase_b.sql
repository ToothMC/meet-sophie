-- ============================================================
-- Meeting Mode Phase B — Silent Hints + Follow-up Diff
-- ============================================================

-- 1. Erweitere meeting_notes.note_type um 'silent_hint'
ALTER TABLE meeting_notes DROP CONSTRAINT IF EXISTS meeting_notes_note_type_check;
ALTER TABLE meeting_notes ADD CONSTRAINT meeting_notes_note_type_check
  CHECK (note_type IN ('note','decision','action','risk','open_point','silent_hint'));

-- 2. Füge followup_diff Spalte zu meeting_summary hinzu
ALTER TABLE meeting_summary ADD COLUMN IF NOT EXISTS followup_diff jsonb;
