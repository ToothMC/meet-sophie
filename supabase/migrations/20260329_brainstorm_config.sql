-- Add brainstorm_config to chat_sessions
-- Stores session setup (topic, goal, mode, depth, facilitation_style, etc.)
-- so that per-turn phase injection can be calculated server-side.

ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS brainstorm_config JSONB;
