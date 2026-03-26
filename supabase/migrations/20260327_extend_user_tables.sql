-- Migration 3: Extend user_profile + user_relationship for import system

-- user_profile: add import tracking columns
ALTER TABLE user_profile
  ADD COLUMN IF NOT EXISTS imported_from TEXT,
  ADD COLUMN IF NOT EXISTS import_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS import_verified BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_id UUID;

-- user_relationship: add communication style + thinking pattern
ALTER TABLE user_relationship
  ADD COLUMN IF NOT EXISTS communication_style JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS thinking_pattern JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS source_id UUID;

-- Note: FK constraints to source_connections are intentionally omitted here
-- to avoid issues if source is deleted — the columns store historical reference IDs.
