-- ============================================================
-- Meeting Context Metadata
-- Adds metadata JSONB column to meeting_context for document
-- report cards (filename, preview, char_count, analysis cache).
-- ============================================================

ALTER TABLE meeting_context ADD COLUMN IF NOT EXISTS metadata jsonb;
