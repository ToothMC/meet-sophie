begin;

-- =========================================================
-- 1) user_sessions gezielt erweitern
--    Bestehende Inserts aus memory-update.js bleiben kompatibel
-- =========================================================

alter table public.user_sessions
  add column if not exists title text,
  add column if not exists started_at timestamptz,
  add column if not exists ended_at timestamptz,
  add column if not exists duration_seconds integer,
  add column if not exists thread_id uuid,
  add column if not exists has_transcript boolean not null default false,
  add column if not exists has_output boolean not null default false;

alter table public.user_sessions
  drop constraint if exists user_sessions_duration_seconds_check;

alter table public.user_sessions
  add constraint user_sessions_duration_seconds_check
  check (duration_seconds is null or duration_seconds >= 0);

create index if not exists user_sessions_user_id_idx
  on public.user_sessions (user_id);

create index if not exists user_sessions_session_date_idx
  on public.user_sessions (session_date desc);

-- =========================================================
-- 2) conversation_messages
--    Volltranskript turn-basiert
-- =========================================================

create table if not exists public.conversation_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.user_sessions(id) on delete cascade,
  seq integer not null,
  role text not null,
  text text not null,
  created_at timestamptz not null default now(),

  constraint conversation_messages_seq_check
    check (seq >= 0),

  constraint conversation_messages_role_check
    check (role in ('user', 'assistant', 'system', 'other'))
);

create unique index if not exists conversation_messages_session_seq_idx
  on public.conversation_messages (session_id, seq);

create index if not exists conversation_messages_session_id_idx
  on public.conversation_messages (session_id);

create index if not exists conversation_messages_created_at_idx
  on public.conversation_messages (created_at desc);

-- =========================================================
-- 3) conversation_outputs
--    Strukturierte Nachbearbeitung pro Session
-- =========================================================

create table if not exists public.conversation_outputs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.user_sessions(id) on delete cascade,
  title text,
  short_summary text,
  structured_summary jsonb,
  key_insights jsonb,
  action_plan jsonb,
  open_questions jsonb,
  model text,
  prompt_version text,
  created_at timestamptz not null default now()
);

create unique index if not exists conversation_outputs_session_id_unique_idx
  on public.conversation_outputs (session_id);

create index if not exists conversation_outputs_created_at_idx
  on public.conversation_outputs (created_at desc);

-- =========================================================
-- 4) RLS aktivieren
-- =========================================================

alter table public.conversation_messages enable row level security;
alter table public.conversation_outputs enable row level security;

-- =========================================================
-- 5) Policies conversation_messages
-- =========================================================

drop policy if exists "Users can read own conversation messages" on public.conversation_messages;
create policy "Users can read own conversation messages"
on public.conversation_messages
for select
using (
  exists (
    select 1
    from public.user_sessions s
    where s.id = conversation_messages.session_id
      and s.user_id = auth.uid()
  )
);

drop policy if exists "Users can insert own conversation messages" on public.conversation_messages;
create policy "Users can insert own conversation messages"
on public.conversation_messages
for insert
with check (
  exists (
    select 1
    from public.user_sessions s
    where s.id = conversation_messages.session_id
      and s.user_id = auth.uid()
  )
);

drop policy if exists "Users can delete own conversation messages" on public.conversation_messages;
create policy "Users can delete own conversation messages"
on public.conversation_messages
for delete
using (
  exists (
    select 1
    from public.user_sessions s
    where s.id = conversation_messages.session_id
      and s.user_id = auth.uid()
  )
);

-- =========================================================
-- 6) Policies conversation_outputs
-- =========================================================

drop policy if exists "Users can read own conversation outputs" on public.conversation_outputs;
create policy "Users can read own conversation outputs"
on public.conversation_outputs
for select
using (
  exists (
    select 1
    from public.user_sessions s
    where s.id = conversation_outputs.session_id
      and s.user_id = auth.uid()
  )
);

drop policy if exists "Users can insert own conversation outputs" on public.conversation_outputs;
create policy "Users can insert own conversation outputs"
on public.conversation_outputs
for insert
with check (
  exists (
    select 1
    from public.user_sessions s
    where s.id = conversation_outputs.session_id
      and s.user_id = auth.uid()
  )
);

drop policy if exists "Users can delete own conversation outputs" on public.conversation_outputs;
create policy "Users can delete own conversation outputs"
on public.conversation_outputs
for delete
using (
  exists (
    select 1
    from public.user_sessions s
    where s.id = conversation_outputs.session_id
      and s.user_id = auth.uid()
  )
);

commit;
