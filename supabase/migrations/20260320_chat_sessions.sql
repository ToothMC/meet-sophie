begin;

-- =========================================================
-- 1) chat_sessions
--    Text-Chat Sessions (Phase 1)
-- =========================================================

create table if not exists public.chat_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete set null,
  status        text not null default 'open',
  mode          text not null default 'text',
  turn_count    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  last_message_at timestamptz,

  constraint chat_sessions_status_check
    check (status in ('open', 'closed')),

  constraint chat_sessions_mode_check
    check (mode in ('text', 'voice')),

  constraint chat_sessions_turn_count_check
    check (turn_count >= 0)
);

create index if not exists chat_sessions_user_id_idx
  on public.chat_sessions (user_id);

create index if not exists chat_sessions_created_at_idx
  on public.chat_sessions (created_at desc);

-- =========================================================
-- 2) onboarding_completed auf user_profile
-- =========================================================

alter table public.user_profile
  add column if not exists onboarding_completed boolean not null default false;

-- =========================================================
-- 3) RLS für chat_sessions
-- =========================================================

alter table public.chat_sessions enable row level security;

drop policy if exists "Users can read own chat sessions" on public.chat_sessions;
create policy "Users can read own chat sessions"
on public.chat_sessions for select
using (user_id = auth.uid() or user_id is null);

drop policy if exists "Anyone can insert chat sessions" on public.chat_sessions;
create policy "Anyone can insert chat sessions"
on public.chat_sessions for insert
with check (true);

drop policy if exists "Users can update own chat sessions" on public.chat_sessions;
create policy "Users can update own chat sessions"
on public.chat_sessions for update
using (user_id = auth.uid() or user_id is null);

commit;
