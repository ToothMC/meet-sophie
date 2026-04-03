-- Add session_mode and language to chat_sessions
-- Required for server-side prompt rebuild on every turn (security hardening).
-- Previously the system_prompt was sent to the client and echoed back on each
-- message — now the server rebuilds it using these stored session parameters.

ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS session_mode TEXT,
  ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en';
