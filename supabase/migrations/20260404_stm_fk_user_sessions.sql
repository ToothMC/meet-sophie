-- STM conversation_id: switch FK from chat_sessions to user_sessions
-- Enables Voice sessions (which only create user_sessions rows) to write STM.
-- Table has 0 rows — no data migration needed.

ALTER TABLE sophie_short_term_memory
  DROP CONSTRAINT sophie_short_term_memory_conversation_id_fkey;

ALTER TABLE sophie_short_term_memory
  ADD CONSTRAINT sophie_short_term_memory_conversation_id_fkey
  FOREIGN KEY (conversation_id) REFERENCES user_sessions(id) ON DELETE CASCADE;

COMMENT ON COLUMN sophie_short_term_memory.conversation_id IS 'References user_sessions.id (both voice and text). Previously referenced chat_sessions.id.';
