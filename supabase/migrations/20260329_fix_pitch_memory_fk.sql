-- Fix: sophie_pitch_memory.conversation_id FK pointed to chat_sessions.id
-- but we insert user_sessions.id → every insert silently failed with FK violation
-- Drop the wrong FK constraint
ALTER TABLE sophie_pitch_memory DROP CONSTRAINT IF EXISTS sophie_pitch_memory_conversation_id_fkey;
COMMENT ON COLUMN sophie_pitch_memory.conversation_id IS 'References user_sessions.id (voice pitch sessions). FK removed because original pointed to chat_sessions.';
