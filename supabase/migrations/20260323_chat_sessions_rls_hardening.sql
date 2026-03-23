begin;

-- =========================================================
-- Harden RLS policies for chat_sessions
--
-- All CRUD on chat_sessions goes through api/chat.js which
-- uses the service-role key (bypasses RLS). These policies
-- only affect direct client-side Supabase calls.
--
-- Changes:
--   SELECT  – authenticated users see only their own sessions
--   INSERT  – authenticated users can only insert for themselves
--   UPDATE  – authenticated users can only update their own sessions
--   Anonymous / null sessions are managed server-side only.
-- =========================================================

-- SELECT: only own sessions (no more "or user_id is null")
drop policy if exists "Users can read own chat sessions" on public.chat_sessions;
create policy "Users can read own chat sessions"
on public.chat_sessions for select
using (user_id = auth.uid());

-- INSERT: only for yourself (no more "with check (true)")
drop policy if exists "Anyone can insert chat sessions" on public.chat_sessions;
create policy "Authenticated users can insert own chat sessions"
on public.chat_sessions for insert
with check (user_id = auth.uid());

-- UPDATE: only own sessions (no more "or user_id is null")
drop policy if exists "Users can update own chat sessions" on public.chat_sessions;
create policy "Users can update own chat sessions"
on public.chat_sessions for update
using (user_id = auth.uid());

commit;
