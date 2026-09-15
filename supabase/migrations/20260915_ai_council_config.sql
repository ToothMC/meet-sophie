-- Council runtime config: kill switch + advisor sets, editable from /admin.
-- Admin-only table (service role via api/admin.js) — no RLS, same as api_budget_alerts.
-- The code fails closed: if this row is missing or unreadable, the council stays off.

CREATE TABLE IF NOT EXISTS ai_council_config (
  id           text PRIMARY KEY DEFAULT 'global',
  enabled      boolean NOT NULL DEFAULT true,
  advisors     jsonb NOT NULL,   -- [{provider, model}] subset of ADVISORS in lib/ai/council-config.js
  eco_advisors jsonb NOT NULL,   -- [{provider, model}] subset of ECO_ADVISORS
  updated_at   timestamptz DEFAULT now(),
  updated_by   uuid,
  CONSTRAINT ai_council_config_singleton CHECK (id = 'global')
);

INSERT INTO ai_council_config (id, enabled, advisors, eco_advisors) VALUES (
  'global',
  true,
  '[{"provider":"openai","model":"gpt-4o-mini"},
    {"provider":"anthropic","model":"claude-sonnet-4-6"},
    {"provider":"google","model":"gemini-2.5-flash"},
    {"provider":"mistral","model":"mistral-small-latest"}]'::jsonb,
  '[{"provider":"google","model":"gemini-2.5-flash-lite"},
    {"provider":"openai","model":"gpt-4o-mini"},
    {"provider":"mistral","model":"mistral-small-latest"}]'::jsonb
) ON CONFLICT (id) DO NOTHING;

-- Council runs are logged into analytics_events (event_name = 'council_run').
CREATE INDEX IF NOT EXISTS idx_analytics_events_council
  ON analytics_events (created_at DESC)
  WHERE event_name = 'council_run';
