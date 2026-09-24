-- ═══════════════════════════════════════════════════════════════════════════
-- 0004 — Gespräche
--
-- EIN Session-Modell, nicht zwei. Meet-Sophie trägt zwei parallele Modelle
-- (chat_sessions aus der Frühzeit, user_sessions + conversation_messages als
-- kanonisches Modell) und muss in api/chat.js mit einem isCanonical-Flag
-- entscheiden, ob Nachrichten überhaupt persistiert werden. Diesen Dualismus
-- übernehmen wir nicht.
--
-- Neu gegenüber Sophie: vehicle_id und trip_id am Gespräch. Der Kontext
-- "welches Fahrzeug, welche Reise" ist bei CampKumpel kein Zusatz, sondern
-- die Voraussetzung dafür, dass die Antwort überhaupt stimmt.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ───────────────────────────────────────────────────────────────────────────
-- conversations
-- ───────────────────────────────────────────────────────────────────────────

create table public.conversations (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references auth.users(id) on delete cascade,

  -- Fahrzeug- und Reisebezug werden beim Start aufgelöst und festgeschrieben.
  -- Nicht zur Laufzeit nachschlagen: endet eine Miete, soll ein altes
  -- Gespräch weiterhin zeigen, worüber gesprochen wurde — aber der Zugriff
  -- auf das Fahrzeug ist dann trotzdem weg (siehe Policy unten).
  vehicle_id       uuid        references public.vehicles(id) on delete set null,
  trip_id          uuid        references public.trips(id) on delete set null,

  title            text,
  status           text        not null default 'open',
  modality         text        not null default 'text',
  turn_count       int         not null default 0,

  -- Für Abrechnung und Modellwahl zum Zeitpunkt des Gesprächs.
  model            text,
  plan_at_start    text,

  started_at       timestamptz not null default now(),
  last_message_at  timestamptz,
  ended_at         timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint conversations_status_check
    check (status in ('open', 'closed', 'abandoned')),

  -- 'voice' ist im MVP per Feature-Flag aus, steht aber im Constraint, damit
  -- die Aktivierung später keine Migration braucht.
  constraint conversations_modality_check
    check (modality in ('text', 'voice', 'mixed')),

  constraint conversations_turn_count_check
    check (turn_count >= 0)
);

create index conversations_user_started_idx on public.conversations (user_id, started_at desc);
create index conversations_vehicle_idx      on public.conversations (vehicle_id) where vehicle_id is not null;
create index conversations_trip_idx         on public.conversations (trip_id)    where trip_id is not null;

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

-- ───────────────────────────────────────────────────────────────────────────
-- conversation_messages
--
-- seq statt nur created_at für die Reihenfolge: zwei Nachrichten desselben
-- Zuges können innerhalb derselben Millisekunde geschrieben werden, und dann
-- ist die Sortierung nach Zeitstempel nicht mehr deterministisch.
-- ───────────────────────────────────────────────────────────────────────────

create table public.conversation_messages (
  id              uuid        primary key default gen_random_uuid(),
  conversation_id uuid        not null references public.conversations(id) on delete cascade,
  seq             int         not null,
  role            text        not null,
  text            text        not null,
  modality        text        not null default 'text',

  -- Welche Werkzeuge in diesem Zug liefen (Live-Suche, Dokumentabruf,
  -- Fahrzeugprofil). Grundlage für Nachvollziehbarkeit und Kostenanalyse.
  tools_used      text[]      not null default '{}',
  token_cost      int2,
  meta            jsonb       not null default '{}'::jsonb,

  created_at      timestamptz not null default now(),

  constraint conversation_messages_seq_check  check (seq >= 0),
  constraint conversation_messages_role_check check (role in ('user', 'assistant', 'system', 'tool')),
  constraint conversation_messages_modality_check check (modality in ('text', 'voice'))
);

create unique index conversation_messages_seq_unique
  on public.conversation_messages (conversation_id, seq);

create index conversation_messages_created_idx
  on public.conversation_messages (conversation_id, created_at);

-- ───────────────────────────────────────────────────────────────────────────
-- conversation_outputs — strukturiertes Ergebnis eines Gesprächs
-- ───────────────────────────────────────────────────────────────────────────

create table public.conversation_outputs (
  conversation_id uuid        primary key references public.conversations(id) on delete cascade,
  title           text,
  short_summary   text,
  key_points      jsonb,
  action_items    jsonb,
  open_questions  jsonb,
  model           text,
  prompt_version  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger conversation_outputs_set_updated_at
  before update on public.conversation_outputs
  for each row execute function public.set_updated_at();

-- ───────────────────────────────────────────────────────────────────────────
-- insert_conversation_message
--
-- Nachricht schreiben und Zählerstände fortschreiben in einem Vorgang. In
-- Meet-Sophie existiert diese Funktion nur in der Produktionsdatenbank und
-- fehlt in den Migrationen (siehe supabase/rpc-allowlist.txt dort) — ein
-- DB-Reset bricht dort die Nachrichtenpersistenz. Hier von Anfang an im Repo.
--
-- Die Sequenznummer wird in der Funktion vergeben, nicht vom Aufrufer. Zwei
-- gleichzeitige Schreibvorgänge liefen sonst in einen Unique-Konflikt auf
-- (conversation_id, seq).
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.insert_conversation_message(
  p_conversation_id uuid,
  p_role            text,
  p_text            text,
  p_modality        text default 'text',
  p_tools_used      text[] default '{}',
  p_token_cost      int default null,
  p_meta            jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_seq int;
  v_id  uuid;
begin
  -- Zeile sperren, damit die Sequenzvergabe serialisiert ist.
  perform 1 from public.conversations where id = p_conversation_id for update;
  if not found then
    raise exception 'conversation % not found', p_conversation_id using errcode = 'no_data_found';
  end if;

  select coalesce(max(seq), -1) + 1 into v_seq
    from public.conversation_messages
   where conversation_id = p_conversation_id;

  insert into public.conversation_messages (
    conversation_id, seq, role, text, modality, tools_used, token_cost, meta
  )
  values (
    p_conversation_id, v_seq, p_role, p_text, p_modality,
    coalesce(p_tools_used, '{}'), p_token_cost, coalesce(p_meta, '{}'::jsonb)
  )
  returning id into v_id;

  update public.conversations
     set turn_count      = turn_count + case when p_role = 'user' then 1 else 0 end,
         last_message_at = now(),
         updated_at      = now()
   where id = p_conversation_id;

  return v_id;
end;
$$;

revoke execute on function public.insert_conversation_message(uuid, text, text, text, text[], int, jsonb)
  from public, anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Row Level Security
--
-- Gespräche gehören dem Nutzer — nicht dem Fahrzeughalter. Ein Vermieter
-- bekommt die Gespräche seiner Mieter nie zu sehen, auch nicht über das
-- eigene Fahrzeug. Deshalb steht in den Policies ausschließlich
-- user_id = auth.uid() und nirgends has_vehicle_access().
--
-- Beim Anlegen wird der Fahrzeugzugriff dagegen sehr wohl geprüft: man kann
-- kein Gespräch an ein Fahrzeug hängen, auf das man keinen Zugriff hat.
-- ───────────────────────────────────────────────────────────────────────────

alter table public.conversations         enable row level security;
alter table public.conversation_messages enable row level security;
alter table public.conversation_outputs  enable row level security;

create policy "conversations_select_own"
  on public.conversations for select
  using (user_id = auth.uid());

create policy "conversations_insert_own"
  on public.conversations for insert
  with check (
    user_id = auth.uid()
    and (vehicle_id is null or public.has_vehicle_access(vehicle_id, 'viewer'))
  );

create policy "conversations_update_own"
  on public.conversations for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "conversations_delete_own"
  on public.conversations for delete
  using (user_id = auth.uid());

create policy "conversation_messages_select_own"
  on public.conversation_messages for select
  using (exists (
    select 1 from public.conversations c
     where c.id = conversation_messages.conversation_id
       and c.user_id = auth.uid()
  ));

create policy "conversation_messages_delete_own"
  on public.conversation_messages for delete
  using (exists (
    select 1 from public.conversations c
     where c.id = conversation_messages.conversation_id
       and c.user_id = auth.uid()
  ));

create policy "conversation_outputs_select_own"
  on public.conversation_outputs for select
  using (exists (
    select 1 from public.conversations c
     where c.id = conversation_outputs.conversation_id
       and c.user_id = auth.uid()
  ));

-- Nachrichten schreibt ausschließlich der Server über insert_conversation_message.
-- Keine INSERT/UPDATE-Policy für conversation_messages.

commit;
