-- hotfix: add DELETE policy for chat_sessions
-- The 20260323 hardening migration added SELECT/INSERT/UPDATE policies
-- but missed DELETE. This closes the gap.

create policy "Users can delete own chat sessions"
on public.chat_sessions for delete to authenticated
using (user_id = auth.uid());
