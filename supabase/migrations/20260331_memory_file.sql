-- User Memory File: free-form personal dossier, maintained by AI after each session
-- Max ~2000 lines, AI merges new facts with existing ones (upsert, not append)
ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS memory_file TEXT DEFAULT '';
