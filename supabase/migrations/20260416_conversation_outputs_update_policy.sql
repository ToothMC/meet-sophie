-- =========================================================
-- Missing UPDATE RLS policy on conversation_outputs
-- =========================================================
-- The original 20260314 migration defined INSERT/SELECT/DELETE
-- policies for conversation_outputs but not UPDATE. Postgres behaviour
-- with RLS enabled + no matching UPDATE policy: the statement is NOT
-- rejected with an error — it simply affects zero rows silently.
--
-- This broke the Tier-N recap generator in memory-recap-core.js which
-- updates conversation_outputs.recap_text after the row was already
-- inserted by memory-update.js. recap_text stayed NULL despite the
-- endpoint returning ok.
--
-- Pattern identical to existing INSERT/DELETE/SELECT policies on the
-- same table: ownership via user_sessions join on session_id.
-- =========================================================

begin;

drop policy if exists "Users can update own conversation outputs" on public.conversation_outputs;

create policy "Users can update own conversation outputs"
on public.conversation_outputs
for update
using (
  exists (
    select 1
    from public.user_sessions s
    where s.id = conversation_outputs.session_id
      and s.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.user_sessions s
    where s.id = conversation_outputs.session_id
      and s.user_id = auth.uid()
  )
);

commit;
