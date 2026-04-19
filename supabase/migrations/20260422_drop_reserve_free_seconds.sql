-- Drop dead free-voice-budget infrastructure (follow-up to SG-4).
--
-- reserve_free_seconds was the gateway that let non-subscribers start
-- voice sessions until the global DAILY_FREE_SECONDS_CAP was reached
-- — the "free voice backdoor" called out as SG-4 in the audit. The
-- JS-side fix in api/session.js (commit 3e0f5b9) replaced that check
-- with an explicit isPayingUser gate, so the RPC is no longer called
-- from any code path.
--
-- daily_budget was the backing table for that RPC. No other call
-- site references it (verified by grep across api/ and lib/).
--
-- Dropping both here prevents accidental re-wiring: a future developer
-- who rediscovers reserve_free_seconds and re-enables it would
-- silently reopen the backdoor. Removing the function makes that
-- mistake impossible without re-creating it intentionally.

BEGIN;

-- Function first (depends on the table).
DROP FUNCTION IF EXISTS public.reserve_free_seconds(integer, integer);

-- Then the now-unreferenced table.
DROP TABLE IF EXISTS public.daily_budget;

COMMIT;
