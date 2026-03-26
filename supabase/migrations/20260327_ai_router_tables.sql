-- Migration 1: AI Router tables (provider health, request log, cost daily)

-- ai_provider_health
CREATE TABLE IF NOT EXISTS ai_provider_health (
  provider TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'unknown',  -- 'healthy' | 'degraded' | 'down'
  latency_ms INTEGER,
  last_check TIMESTAMPTZ,
  error TEXT
);

-- ai_request_log
CREATE TABLE IF NOT EXISTS ai_request_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  routing_reason TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_request_log_user_date
  ON ai_request_log (user_id, created_at DESC);

-- ai_cost_daily (aggregate)
CREATE TABLE IF NOT EXISTS ai_cost_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  date DATE NOT NULL,
  total_cost NUMERIC(10, 6) NOT NULL DEFAULT 0,
  per_provider JSONB DEFAULT '{}',
  request_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, date)
);

-- RLS
ALTER TABLE ai_request_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_cost_daily ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own logs" ON ai_request_log
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service inserts logs" ON ai_request_log
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Users see own costs" ON ai_cost_daily
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service manages costs" ON ai_cost_daily
  FOR ALL WITH CHECK (true);
