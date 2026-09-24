-- ═══════════════════════════════════════════════════════════════════════════
-- 0007 — Analytics und Feedback
--
-- Der MVP hat eine einzige Frage zu beantworten: merken 20–30 echte Nutzer,
-- dass CampKumpel ihr Fahrzeug kennt? Diese Tabellen sind das Messinstrument
-- dafür. Ohne sie ist der Pilot eine Meinungsumfrage.
--
-- Meet-Sophie schreibt Ereignisse nach analytics_events mit freiem
-- event_name und jsonb-meta. Das Muster übernehme ich, ergänze aber
-- vehicle_id und organization_id als eigene Spalten — die entscheidende
-- Auswertung ist "wie verhält sich ein Nutzer MIT vollständigem
-- Fahrzeugprofil gegenüber einem ohne", und die lässt sich aus einem
-- jsonb-Feld nicht vernünftig aggregieren.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ───────────────────────────────────────────────────────────────────────────
-- analytics_events
-- ───────────────────────────────────────────────────────────────────────────

create table public.analytics_events (
  id              bigint      generated always as identity primary key,
  event_name      text        not null,
  user_id         uuid        references auth.users(id) on delete set null,
  vehicle_id      uuid        references public.vehicles(id) on delete set null,
  trip_id         uuid        references public.trips(id) on delete set null,
  organization_id uuid        references public.organizations(id) on delete set null,
  conversation_id uuid        references public.conversations(id) on delete set null,
  meta            jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),

  constraint analytics_events_name_not_blank
    check (length(btrim(event_name)) > 0)
);

create index analytics_events_name_time_idx on public.analytics_events (event_name, created_at desc);
create index analytics_events_user_idx      on public.analytics_events (user_id, created_at desc) where user_id is not null;
create index analytics_events_vehicle_idx   on public.analytics_events (vehicle_id) where vehicle_id is not null;

comment on table public.analytics_events is
  'Ereignisstrom. Erwartete Namen im MVP: vehicle_created, vehicle_profile_field_set, '
  'vehicle_profile_completed, document_uploaded, document_parsed, document_cited, '
  'conversation_started, message_sent, tool_used, memory_written, '
  'personalization_hit (Antwort nutzte Fahrzeug- oder Reisedaten), feedback_given. '
  'Die Liste ist bewusst kein CHECK-Constraint — ein verlorenes Ereignis wäre '
  'schlimmer als ein unerwarteter Name.';

-- ───────────────────────────────────────────────────────────────────────────
-- message_feedback
--
-- Bewertung einzelner Antworten. Die Verknüpfung zur Nachricht ist der Punkt:
-- "war diese Antwort gut" ist auswertbar, "war die App gut" nicht.
--
-- used_vehicle_data und used_travel_data werden beim Schreiben der Nachricht
-- gesetzt, nicht beim Feedback. Damit lässt sich die Kernhypothese direkt
-- messen: fällt die Bewertung besser aus, wenn die Antwort auf
-- Fahrzeugwissen beruhte?
-- ───────────────────────────────────────────────────────────────────────────

create table public.message_feedback (
  id                uuid        primary key default gen_random_uuid(),
  message_id        uuid        not null references public.conversation_messages(id) on delete cascade,
  user_id           uuid        not null references auth.users(id) on delete cascade,

  rating            int2        not null,
  reason            text,
  comment           text,

  used_vehicle_data boolean,
  used_travel_data  boolean,
  used_documents    boolean,
  used_live_search  boolean,

  created_at        timestamptz not null default now(),

  constraint message_feedback_rating_check
    check (rating in (-1, 1)),

  constraint message_feedback_reason_check
    check (reason is null or reason in (
      'wrong_vehicle_data',   -- kannte mein Fahrzeug falsch
      'generic',              -- hätte jede KI so gesagt
      'outdated',
      'not_helpful',
      'tone',
      'too_long',
      'other'
    )),

  constraint message_feedback_comment_size
    check (comment is null or length(comment) <= 2000),

  -- Eine Bewertung pro Nutzer und Nachricht; Umentscheiden per Update.
  constraint message_feedback_unique
    unique (message_id, user_id)
);

create index message_feedback_rating_idx on public.message_feedback (rating, created_at desc);

-- ───────────────────────────────────────────────────────────────────────────
-- Row Level Security
--
-- Ereignisse schreibt der Server. Feedback schreibt der Nutzer selbst — es
-- ist der einzige Schreibpfad im ganzen Schema, der direkt vom Client kommen
-- darf, weil die Hürde sonst zu hoch wird und wir dann keine Daten haben.
-- ───────────────────────────────────────────────────────────────────────────

alter table public.analytics_events enable row level security;
alter table public.message_feedback enable row level security;

-- Keine Policy für analytics_events: nur Service-Role schreibt und liest.
-- Auswertungen laufen über die Admin-API, nicht über den Client.

create policy "message_feedback_select_own"
  on public.message_feedback for select
  using (user_id = auth.uid());

create policy "message_feedback_insert_own"
  on public.message_feedback for insert
  with check (
    user_id = auth.uid()
    and exists (
      select 1
        from public.conversation_messages m
        join public.conversations c on c.id = m.conversation_id
       where m.id = message_feedback.message_id
         and c.user_id = auth.uid()
    )
  );

create policy "message_feedback_update_own"
  on public.message_feedback for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

commit;
