-- ============================================================
-- Meeting Mode Phase C — File Uploads
-- ============================================================

-- 1. Add file_path column to meeting_context
ALTER TABLE meeting_context ADD COLUMN IF NOT EXISTS file_path text;

-- 2. Expand context_type to include 'file' and 'history_ref'
ALTER TABLE meeting_context DROP CONSTRAINT IF EXISTS meeting_context_context_type_check;
ALTER TABLE meeting_context ADD CONSTRAINT meeting_context_context_type_check
  CHECK (context_type IN ('agenda','participants','goal','text_note','file','history_ref'));

-- 3. Create storage bucket for meeting files (via Supabase Storage API)
-- Note: Bucket creation is done via Supabase dashboard or API, not SQL.
-- Bucket name: meeting-files
-- Public: false (private, accessed via signed URLs)
