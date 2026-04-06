-- Migration: Hybrid Meeting Mode (Whisper-Listening + Realtime On-Demand)
-- Adds meeting_segments, meeting_burst_messages, billing columns, and billing RPCs

-- 1. meeting_segments: Audit trail for Whisper transcription chunks
CREATE TABLE IF NOT EXISTS meeting_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  segment_index int NOT NULL,
  duration_seconds numeric(10,2),
  transcript text,
  whisper_cost_usd numeric(10,6) DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  UNIQUE(meeting_id, segment_index)
);
ALTER TABLE meeting_segments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_segments" ON meeting_segments
  FOR ALL USING (auth.uid() = user_id);

-- 2. meeting_burst_messages: Sophie voice burst answers persisted server-side
CREATE TABLE IF NOT EXISTS meeting_burst_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('sophie', 'user')),
  text text NOT NULL,
  source text DEFAULT 'burst',
  burst_duration_seconds numeric(10,2),
  created_at timestamptz DEFAULT now()
);
ALTER TABLE meeting_burst_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_bursts" ON meeting_burst_messages
  FOR ALL USING (auth.uid() = user_id);

-- 3. Billing columns on meetings
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS listen_cost_usd numeric(10,6) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS analysis_cost_usd numeric(10,6) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS burst_cost_usd numeric(10,6) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_cost_usd numeric(10,6) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_billed_tokens int DEFAULT 0,
  ADD COLUMN IF NOT EXISTS billing_status text DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS billing_finalized_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_billed_segment_index int DEFAULT 0,
  ADD COLUMN IF NOT EXISTS incrementally_billed_cost_usd numeric(10,6) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS incrementally_billed_tokens int DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_analyzed_segment_index int DEFAULT 0;

-- Add CHECK constraint separately (IF NOT EXISTS for ADD COLUMN doesn't cover constraints)
DO $$ BEGIN
  ALTER TABLE meetings ADD CONSTRAINT meetings_billing_status_check
    CHECK (billing_status IN ('active', 'finalized'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 4. meeting_billing_checkpoint RPC
-- Atomic billing: row-lock serialization, cumulative target tokens (no multi-rounding)
CREATE OR REPLACE FUNCTION meeting_billing_checkpoint(
  p_meeting_id uuid,
  p_user_id uuid,
  p_billing_threshold numeric DEFAULT 0.05
)
RETURNS jsonb AS $$
DECLARE
  m meetings%ROWTYPE;
  total_cost_so_far numeric;
  target_total_tokens int;
  tokens_to_bill int;
  dt_charged int;
  dt_remaining int;
BEGIN
  SELECT * INTO m FROM meetings
    WHERE id = p_meeting_id AND user_id = p_user_id
    FOR UPDATE;

  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF m.billing_status = 'finalized' THEN
    RETURN jsonb_build_object('error', 'already_finalized', 'billed_tokens', m.total_billed_tokens);
  END IF;

  total_cost_so_far := m.listen_cost_usd + m.analysis_cost_usd + m.burst_cost_usd;

  IF (total_cost_so_far - m.incrementally_billed_cost_usd) < p_billing_threshold THEN
    RETURN jsonb_build_object('action', 'below_threshold',
      'unbilled', total_cost_so_far - m.incrementally_billed_cost_usd);
  END IF;

  -- Cumulative target tokens: one CEIL on total, not per-delta
  target_total_tokens := GREATEST(1, CEIL(total_cost_so_far * 1.6 / 0.0088));
  tokens_to_bill := GREATEST(0, target_total_tokens - m.incrementally_billed_tokens);

  IF tokens_to_bill <= 0 THEN
    RETURN jsonb_build_object('action', 'already_covered');
  END IF;

  -- deduct_tokens returns TABLE — select specific columns
  SELECT charged, remaining INTO dt_charged, dt_remaining
    FROM deduct_tokens(p_user_id, tokens_to_bill);

  -- deduct_tokens is partial: charged can be < requested
  IF dt_charged IS NULL OR dt_charged = 0 THEN
    RETURN jsonb_build_object(
      'action', 'insufficient_tokens',
      'tokens_requested', tokens_to_bill,
      'remaining', COALESCE(dt_remaining, 0)
    );
  END IF;

  -- Only update checkpoint with actually charged amount
  UPDATE meetings SET
    incrementally_billed_tokens = m.incrementally_billed_tokens + dt_charged,
    incrementally_billed_cost_usd = m.incrementally_billed_cost_usd
      + (total_cost_so_far - m.incrementally_billed_cost_usd)
        * (dt_charged::numeric / tokens_to_bill::numeric)
  WHERE id = p_meeting_id;

  RETURN jsonb_build_object(
    'action', 'billed',
    'cost_usd', total_cost_so_far - m.incrementally_billed_cost_usd,
    'tokens_charged', dt_charged,
    'tokens_remaining', dt_remaining
  );
END;
$$ LANGUAGE plpgsql;

-- 5. meeting_finalize_billing RPC
-- Idempotent finalization, same cumulative token logic as checkpoint
CREATE OR REPLACE FUNCTION meeting_finalize_billing(
  p_meeting_id uuid,
  p_user_id uuid
)
RETURNS jsonb AS $$
DECLARE
  m meetings%ROWTYPE;
  total_cost numeric;
  target_total_tokens int;
  tokens_to_bill int;
  dt_charged int;
BEGIN
  SELECT * INTO m FROM meetings
    WHERE id = p_meeting_id AND user_id = p_user_id
    FOR UPDATE;

  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF m.billing_status = 'finalized' THEN
    RETURN jsonb_build_object(
      'status', 'already_finalized',
      'total_billed_tokens', m.total_billed_tokens,
      'total_cost_usd', m.total_cost_usd
    );
  END IF;

  total_cost := m.listen_cost_usd + m.analysis_cost_usd + m.burst_cost_usd;

  -- Same cumulative formula as checkpoint
  target_total_tokens := GREATEST(0, CEIL(total_cost * 1.6 / 0.0088));
  tokens_to_bill := GREATEST(0, target_total_tokens - m.incrementally_billed_tokens);

  dt_charged := 0;
  IF tokens_to_bill > 0 THEN
    -- deduct_tokens returns TABLE — select specific column
    SELECT charged INTO dt_charged FROM deduct_tokens(p_user_id, tokens_to_bill);
    dt_charged := COALESCE(dt_charged, 0);
  END IF;

  UPDATE meetings SET
    total_cost_usd = total_cost,
    total_billed_tokens = m.incrementally_billed_tokens + dt_charged,
    billing_status = 'finalized',
    billing_finalized_at = now()
  WHERE id = p_meeting_id;

  RETURN jsonb_build_object(
    'status', 'finalized',
    'total_cost_usd', total_cost,
    'total_billed_tokens', m.incrementally_billed_tokens + dt_charged,
    'final_deduct', dt_charged
  );
END;
$$ LANGUAGE plpgsql;
