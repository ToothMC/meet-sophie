-- Production RPCs + Dependent Tables — Recovery
--
-- Captured on 2026-04-19 from the production Supabase instance
-- (project ohzfojsbmzinpxhcynpt). These functions were created manually
-- via the SQL editor before migrations were version-controlled and were
-- missing from supabase/migrations/. See supabase/MISSING_RPCS.md for
-- the export procedure and the rationale.
--
-- Running this migration against production is intended to be a no-op
-- (CREATE TABLE IF NOT EXISTS + CREATE OR REPLACE FUNCTION with
-- byte-identical definitions). Verify with the MD5 check in the runbook.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- TABLES
-- ─────────────────────────────────────────────────────────────────────
-- Schemas reconstructed from the function bodies (INSERT / UPDATE
-- statements below). If your production schema differs, prefer the
-- production definition and adapt here. The reconstruction covers:
--   - PRIMARY KEY inferred from `ON CONFLICT (user_id)` / `(day)`
--   - NOT NULL + DEFAULT now() on timestamps set unconditionally
--   - No foreign keys added (unknown whether production has them;
--     adding one retroactively could fail against existing data).

-- Used by acquire_realtime_lock to serialize concurrent voice sessions.
CREATE TABLE IF NOT EXISTS public.user_realtime_lock (
  user_id      uuid        PRIMARY KEY,
  locked_until timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_realtime_lock ENABLE ROW LEVEL SECURITY;
-- No policies — service-role only.

-- Used by reserve_free_seconds (obsolete since SG-4 fix but kept for
-- completeness; a future migration may drop it).
CREATE TABLE IF NOT EXISTS public.daily_budget (
  day                   date    PRIMARY KEY,
  free_seconds_reserved integer NOT NULL DEFAULT 0,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.daily_budget ENABLE ROW LEVEL SECURITY;


-- ─────────────────────────────────────────────────────────────────────
-- FUNCTIONS — exported 1:1 via pg_get_functiondef, do not edit here.
-- Business-logic changes go into a follow-up migration so that this
-- file stays byte-identical to production.
-- ─────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────
-- acquire_realtime_lock
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.acquire_realtime_lock(p_user_id uuid, p_ttl_seconds integer)
 RETURNS TABLE(allowed boolean, locked_until timestamp with time zone)
 LANGUAGE plpgsql
AS $function$
declare
  now_ts timestamptz := now();
  new_until timestamptz := now_ts + make_interval(secs => p_ttl_seconds);
  current_locked_until timestamptz;
begin
  insert into public.user_realtime_lock(user_id, locked_until)
  values (p_user_id, now_ts)
  on conflict (user_id) do nothing;

  select url.locked_until into current_locked_until
  from public.user_realtime_lock as url
  where url.user_id = p_user_id
  for update;

  if current_locked_until > now_ts then
    return query select false, current_locked_until;
    return;
  end if;

  update public.user_realtime_lock as url
  set locked_until = new_until,
      updated_at = now_ts
  where url.user_id = p_user_id;

  return query select true, new_until;
end;
$function$
;


-- ─────────────────────────────────────────────
-- deduct_tokens
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.deduct_tokens(p_user_id uuid, p_amount integer)
 RETURNS TABLE(charged integer, free_charged integer, paid_charged integer, topup_charged integer, remaining integer, free_tokens_total integer, free_tokens_used integer, paid_tokens_total integer, paid_tokens_used integer, topup_tokens_balance integer)
 LANGUAGE plpgsql
AS $function$
DECLARE
  r user_usage%ROWTYPE;
  to_charge INTEGER;
  from_free INTEGER;
  from_paid INTEGER;
  from_topup INTEGER;
  free_rem INTEGER;
  paid_rem INTEGER;
  topup_rem INTEGER;
BEGIN
  -- Lock the row to prevent concurrent deductions
  SELECT * INTO r FROM user_usage WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  free_rem := GREATEST(0, COALESCE(r.free_tokens_total, 50) - COALESCE(r.free_tokens_used, 0));
  paid_rem := GREATEST(0, COALESCE(r.paid_tokens_total, 0) - COALESCE(r.paid_tokens_used, 0));
  topup_rem := GREATEST(0, COALESCE(r.topup_tokens_balance, 0));

  IF free_rem + paid_rem + topup_rem <= 0 THEN
    charged := 0; free_charged := 0; paid_charged := 0; topup_charged := 0;
    remaining := 0;
    free_tokens_total := r.free_tokens_total; free_tokens_used := r.free_tokens_used;
    paid_tokens_total := r.paid_tokens_total; paid_tokens_used := r.paid_tokens_used;
    topup_tokens_balance := r.topup_tokens_balance;
    RETURN NEXT;
    RETURN;
  END IF;

  to_charge := LEAST(p_amount, free_rem + paid_rem + topup_rem);

  -- Waterfall: free → paid → topup
  from_free := LEAST(free_rem, to_charge);
  to_charge := to_charge - from_free;
  from_paid := LEAST(paid_rem, to_charge);
  to_charge := to_charge - from_paid;
  from_topup := LEAST(topup_rem, to_charge);

  UPDATE user_usage SET
    free_tokens_used = COALESCE(r.free_tokens_used, 0) + from_free,
    paid_tokens_used = COALESCE(r.paid_tokens_used, 0) + from_paid,
    topup_tokens_balance = GREATEST(0, COALESCE(r.topup_tokens_balance, 0) - from_topup),
    updated_at = NOW()
  WHERE user_id = p_user_id;

  charged := from_free + from_paid + from_topup;
  free_charged := from_free;
  paid_charged := from_paid;
  topup_charged := from_topup;
  remaining := (free_rem - from_free) + (paid_rem - from_paid) + (topup_rem - from_topup);
  free_tokens_total := r.free_tokens_total;
  free_tokens_used := COALESCE(r.free_tokens_used, 0) + from_free;
  paid_tokens_total := r.paid_tokens_total;
  paid_tokens_used := COALESCE(r.paid_tokens_used, 0) + from_paid;
  topup_tokens_balance := GREATEST(0, COALESCE(r.topup_tokens_balance, 0) - from_topup);
  RETURN NEXT;
END;
$function$
;


-- ─────────────────────────────────────────────
-- meeting_create_with_token_gate
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.meeting_create_with_token_gate(p_user_id uuid, p_meeting_type text DEFAULT 'other'::text, p_sophie_role text DEFAULT 'co-think'::text, p_title text DEFAULT NULL::text, p_parent_meeting_id uuid DEFAULT NULL::uuid, p_token_cost integer DEFAULT 1, p_idempotency_key text DEFAULT NULL::text)
 RETURNS TABLE(meeting_id uuid, phase text, meeting_type text, sophie_role text, created_at timestamp with time zone, tokens_charged integer, remaining_tokens integer, was_idempotent boolean)
 LANGUAGE plpgsql
AS $function$
DECLARE
  r user_usage%ROWTYPE;
  free_rem INTEGER;
  paid_rem INTEGER;
  topup_rem INTEGER;
  total_rem INTEGER;
  from_free INTEGER;
  from_paid INTEGER;
  from_topup INTEGER;
  to_charge INTEGER;
  new_meeting_id UUID;
  existing_meeting RECORD;
BEGIN
  -- 1. Idempotency check: if key provided, check for existing meeting
  IF p_idempotency_key IS NOT NULL AND p_idempotency_key != '' THEN
    SELECT m.id, m.phase, m.meeting_type, m.sophie_role, m.created_at
    INTO existing_meeting
    FROM meetings m
    WHERE m.user_id = p_user_id
      AND m.created_at > NOW() - INTERVAL '5 minutes'
      AND m.title IS NOT DISTINCT FROM p_title
      AND m.meeting_type = p_meeting_type
      AND m.sophie_role = p_sophie_role
      AND m.phase = 'prep'
    ORDER BY m.created_at DESC
    LIMIT 1;

    IF FOUND THEN
      meeting_id := existing_meeting.id;
      phase := existing_meeting.phase;
      meeting_type := existing_meeting.meeting_type;
      sophie_role := existing_meeting.sophie_role;
      created_at := existing_meeting.created_at;
      tokens_charged := 0;
      remaining_tokens := 0; -- will be filled below
      was_idempotent := TRUE;

      -- Get current balance for response
      SELECT GREATEST(0, COALESCE(u.free_tokens_total, 50) - COALESCE(u.free_tokens_used, 0))
           + GREATEST(0, COALESCE(u.paid_tokens_total, 0) - COALESCE(u.paid_tokens_used, 0))
           + GREATEST(0, COALESCE(u.topup_tokens_balance, 0))
      INTO remaining_tokens
      FROM user_usage u WHERE u.user_id = p_user_id;

      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  -- 2. Lock user_usage row and check balance
  SELECT * INTO r FROM user_usage WHERE user_id = p_user_id FOR UPDATE;

  IF NOT FOUND THEN
    -- New user: create usage row with defaults
    INSERT INTO user_usage (user_id, free_tokens_total, free_tokens_used, paid_tokens_total, paid_tokens_used, topup_tokens_balance)
    VALUES (p_user_id, 50, 0, 0, 0, 0)
    RETURNING * INTO r;
  END IF;

  free_rem := GREATEST(0, COALESCE(r.free_tokens_total, 50) - COALESCE(r.free_tokens_used, 0));
  paid_rem := GREATEST(0, COALESCE(r.paid_tokens_total, 0) - COALESCE(r.paid_tokens_used, 0));
  topup_rem := GREATEST(0, COALESCE(r.topup_tokens_balance, 0));
  total_rem := free_rem + paid_rem + topup_rem;

  -- 3. Insufficient tokens → raise exception (caller gets error)
  IF total_rem < p_token_cost THEN
    RAISE EXCEPTION 'INSUFFICIENT_TOKENS:remaining=%,required=%', total_rem, p_token_cost;
  END IF;

  -- 4. Deduct tokens (waterfall: free → paid → topup)
  to_charge := p_token_cost;
  from_free := LEAST(free_rem, to_charge);
  to_charge := to_charge - from_free;
  from_paid := LEAST(paid_rem, to_charge);
  to_charge := to_charge - from_paid;
  from_topup := LEAST(topup_rem, to_charge);

  UPDATE user_usage SET
    free_tokens_used = COALESCE(r.free_tokens_used, 0) + from_free,
    paid_tokens_used = COALESCE(r.paid_tokens_used, 0) + from_paid,
    topup_tokens_balance = GREATEST(0, COALESCE(r.topup_tokens_balance, 0) - from_topup),
    updated_at = NOW()
  WHERE user_id = p_user_id;

  -- 5. Create meeting
  INSERT INTO meetings (user_id, title, meeting_type, phase, sophie_role, parent_meeting_id)
  VALUES (p_user_id, p_title, p_meeting_type, 'prep', p_sophie_role, p_parent_meeting_id)
  RETURNING id INTO new_meeting_id;

  -- 6. Return result
  meeting_id := new_meeting_id;
  phase := 'prep';
  meeting_type := p_meeting_type;
  sophie_role := p_sophie_role;
  created_at := NOW();
  tokens_charged := from_free + from_paid + from_topup;
  remaining_tokens := total_rem - tokens_charged;
  was_idempotent := FALSE;

  RETURN NEXT;
END;
$function$
;


-- ─────────────────────────────────────────────
-- reserve_free_seconds
-- ─────────────────────────────────────────────
-- No longer called from the codebase (replaced by explicit
-- isPayingUser check in api/session.js as part of SG-4 fix).
-- Kept here for historical completeness; safe to drop later.
CREATE OR REPLACE FUNCTION public.reserve_free_seconds(p_seconds integer, p_cap integer)
 RETURNS TABLE(allowed boolean, reserved_total integer)
 LANGUAGE plpgsql
AS $function$
declare
  d date := (now() at time zone 'utc')::date;
  current_val int;
  new_val int;
begin
  insert into public.daily_budget(day, free_seconds_reserved)
  values (d, 0)
  on conflict (day) do nothing;

  select free_seconds_reserved into current_val
  from public.daily_budget
  where day = d
  for update;

  new_val := current_val + p_seconds;

  if new_val > p_cap then
    return query select false, current_val;
    return;
  end if;

  update public.daily_budget
  set free_seconds_reserved = new_val,
      updated_at = now()
  where day = d;

  return query select true, new_val;
end;
$function$
;

COMMIT;
