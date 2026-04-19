# Missing RPCs — Production-only, not in version control

**Status**: critical infrastructure gap. A DB reset / fresh project setup would
break billing, meeting creation, and session locking. These functions live only
in the production Supabase instance and were never captured as migrations.

## RPCs the code depends on

Each bullet lists the call site (what breaks if the function is missing) and
the required signature inferred from callers.

### `deduct_tokens(p_user_id uuid, p_amount int)`

Returns `TABLE(charged int, remaining int)`.

Called from:
- [api/finalize-session.js:46](../api/finalize-session.js) — session-end token billing
- [api/meeting.js:458,731,1525](../api/meeting.js) — meeting chat / analysis billing
- [api/user.js:86](../api/user.js) — manual billing
- indirectly from `meeting_billing_checkpoint` / `meeting_finalize_billing`
  (defined in `20260406_hybrid_meeting_billing.sql`)

Must:
- deduct from `user_usage` in waterfall order: `free_tokens` → `paid_tokens` → `topup_tokens`
- handle partial charges (return actual `charged` even if < requested)
- be transactional / row-locked so concurrent calls don't oversubscribe

### `meeting_create_with_token_gate(...)`

Arguments:
```
p_user_id uuid, p_meeting_type text, p_sophie_role text,
p_title text, p_parent_meeting_id uuid,
p_token_cost int, p_idempotency_key text
```

Returns a row with:
```
meeting_id uuid, phase text, meeting_type text, sophie_role text,
created_at timestamptz, tokens_charged int, remaining_tokens int,
was_idempotent bool
```

Called from [api/meeting.js:224](../api/meeting.js). Atomically checks tokens,
deducts, and creates the meeting. Raises `INSUFFICIENT_TOKENS` with message
format `remaining=N,required=M` on failure.

### `acquire_realtime_lock(p_user_id uuid, p_ttl_seconds int)`

Returns `TABLE(allowed bool)`.

Called from [api/session.js:238](../api/session.js). Prevents the user from
running more than one voice session at a time. TTL-based lease.

### `reserve_free_seconds(p_seconds int, p_cap int)`

Returns `TABLE(allowed bool)`.

Called from [api/session.js:328](../api/session.js). Global daily budget for
free voice minutes, independent of individual users.

**Note**: gated by SG-4 in the audit — the existence of this RPC combined with
`DAILY_FREE_SECONDS_CAP=3000` allows non-paying users to run voice sessions.
Confirm whether this is intentional before enshrining it.

## How to recover

Export from production with service-role credentials:

```bash
# using Supabase CLI (or pg_dump against the pooler)
supabase db dump \
  --db-url "postgresql://postgres:...@db.PROJECT.supabase.co:5432/postgres" \
  --schema public \
  --data-only=false \
  --keep-comments \
  | grep -A 9999 'CREATE OR REPLACE FUNCTION public.deduct_tokens\|CREATE OR REPLACE FUNCTION public.meeting_create_with_token_gate\|CREATE OR REPLACE FUNCTION public.acquire_realtime_lock\|CREATE OR REPLACE FUNCTION public.reserve_free_seconds' \
  > supabase/migrations/20260419_production_rpcs_recovered.sql
```

Or via SQL editor, for each function:

```sql
SELECT pg_get_functiondef(oid)
FROM pg_proc
WHERE proname IN (
  'deduct_tokens',
  'meeting_create_with_token_gate',
  'acquire_realtime_lock',
  'reserve_free_seconds'
);
```

Paste the output into a new migration with `CREATE OR REPLACE FUNCTION ...`
blocks. Verify that re-running the migration against production is a no-op
(definitions match byte-for-byte) before committing.

## Why this wasn't caught earlier

The migrations file `20260406_hybrid_meeting_billing.sql` calls `deduct_tokens`
but doesn't define it — the function must have been created manually in the
Supabase SQL editor and never exported. Same story for the other three.

## Follow-up

After recovery, add a CI check: grep all `supabase.rpc("...")` call sites in
`api/**/*.js` and `lib/**/*.js`, then verify each RPC exists in
`supabase/migrations/**/*.sql`. Fails the build on drift.
