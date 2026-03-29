-- API Budget Monitoring: Alert configuration + alert history
-- Tracks per-provider budget thresholds and logs alerts when exceeded

-- Budget configuration per provider
CREATE TABLE IF NOT EXISTS api_budget_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,             -- 'openai'|'anthropic'|'google'|'mistral'|'all'
  alert_type text NOT NULL DEFAULT 'threshold', -- 'threshold'|'anomaly'|'provider_down'
  threshold_pct int DEFAULT 80,       -- warn at this % of budget
  daily_budget_usd numeric(10,2),     -- daily spend limit per provider
  monthly_budget_usd numeric(10,2),   -- monthly spend limit per provider
  enabled boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  UNIQUE(provider)
);

-- Alert history log
CREATE TABLE IF NOT EXISTS api_alert_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  alert_type text NOT NULL,           -- 'budget_daily'|'budget_monthly'|'anomaly'|'provider_down'
  severity text NOT NULL DEFAULT 'warn', -- 'info'|'warn'|'critical'
  message text NOT NULL,
  cost_at_alert numeric(10,2),
  budget_limit numeric(10,2),
  acknowledged boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alert_log_created ON api_alert_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_log_unacked ON api_alert_log(acknowledged, created_at DESC);

-- Insert default budgets for all providers
INSERT INTO api_budget_alerts (provider, daily_budget_usd, monthly_budget_usd, threshold_pct) VALUES
  ('openai',    15.00, 300.00, 80),
  ('anthropic', 10.00, 200.00, 80),
  ('google',     5.00, 100.00, 80),
  ('mistral',    3.00,  50.00, 80),
  ('all',       33.00, 650.00, 80)
ON CONFLICT (provider) DO NOTHING;

-- No RLS — admin-only tables (accessed via service role key)
