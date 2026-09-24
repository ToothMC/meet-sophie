-- ═══════════════════════════════════════════════════════════════════════════
-- 0001 — Fundament: Identität, Organisationen, gemeinsame Helper
--
-- Legt die beiden Wurzelentitäten an, an denen alles andere hängt:
--   PERSON       → public.profiles      (1:1 zu auth.users)
--   ORGANISATION → public.organizations (Vermieter, Händler, Clubs)
--
-- Konventionen für alle folgenden Migrationen:
--   * Statuswerte und Rollen als text + CHECK, nicht als ENUM. ENUM-Werte
--     lassen sich nicht entfernen und nicht umbenennen; bei einem Produkt,
--     dessen Zustandsmodell sich noch bewegt, ist das der falsche Tausch.
--   * Jede Funktion bekommt SET search_path = public, pg_temp.
--     (Meet-Sophie musste das nachträglich über alle Funktionen ziehen,
--      siehe 20260527_security_audit_lockdown.sql.)
--   * SECURITY DEFINER nur dort, wo RLS-Rekursion sonst unvermeidbar wäre,
--     und dann konsequent mit REVOKE EXECUTE FROM PUBLIC, anon, authenticated.
--   * Schreibzugriffe laufen über die Backend-API mit Service-Role-Key.
--     Client-Policies decken deshalb überwiegend SELECT ab.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create extension if not exists pgcrypto;
create extension if not exists citext;

-- ───────────────────────────────────────────────────────────────────────────
-- Gemeinsame Helper
-- ───────────────────────────────────────────────────────────────────────────

-- Hält updated_at aktuell. Wird von fast jeder Tabelle als Trigger genutzt.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- profiles — Stammdaten der Person
--
-- Bewusst schlank: hier steht, wer jemand ist, nicht wie er reist. Das
-- Reiseprofil liegt in 0005 (user_travel_profile) und ist fachlich getrennt,
-- weil es von der KI fortgeschrieben wird und diese Tabelle nicht.
-- ───────────────────────────────────────────────────────────────────────────

create table public.profiles (
  user_id            uuid        primary key references auth.users(id) on delete cascade,
  display_name       text,
  email              citext,
  preferred_language text        not null default 'de',
  preferred_address  text        not null default 'du',   -- 'du' | 'sie'
  timezone           text        not null default 'Europe/Berlin',
  onboarding_step    text        not null default 'start',
  feature_overrides  jsonb       not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint profiles_preferred_address_check
    check (preferred_address in ('du', 'sie')),

  constraint profiles_onboarding_step_check
    check (onboarding_step in ('start', 'vehicle', 'travel_profile', 'done'))
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Profil automatisch anlegen, sobald ein Auth-User entsteht.
-- In Meet-Sophie existiert das Pendant (handle_new_user) nur in der Prod-DB
-- und fehlt in den Migrationen — ein Fork oder DB-Reset würde dort die
-- Nutzeranlage brechen. Deshalb hier von Anfang an im Repo.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (user_id, email)
  values (new.id, new.email)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles for select
  using (user_id = auth.uid());

create policy "profiles_update_own"
  on public.profiles for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ───────────────────────────────────────────────────────────────────────────
-- organizations — Vermieter, Händler, Clubs
--
-- Im MVP legt niemand über die UI eine Organisation an; das passiert
-- händisch für den Vermieter-Pilot. Die Tabelle existiert trotzdem ab Tag
-- eins, weil vehicles.owner_organization_id sonst später eine Migration
-- über produktive Fahrzeugdaten bräuchte.
-- ───────────────────────────────────────────────────────────────────────────

create table public.organizations (
  id                uuid        primary key default gen_random_uuid(),
  name              text        not null,
  slug              citext      unique,
  kind              text        not null default 'rental',
  country           text,
  contact_email     citext,
  status            text        not null default 'active',
  feature_overrides jsonb       not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint organizations_kind_check
    check (kind in ('rental', 'dealer', 'club', 'fleet', 'other')),

  constraint organizations_status_check
    check (status in ('active', 'suspended', 'archived')),

  constraint organizations_name_not_blank
    check (length(btrim(name)) > 0)
);

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function public.set_updated_at();

-- ───────────────────────────────────────────────────────────────────────────
-- organization_members — wer gehört zu welcher Organisation
-- ───────────────────────────────────────────────────────────────────────────

create table public.organization_members (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  user_id         uuid        not null references auth.users(id) on delete cascade,
  role            text        not null default 'member',
  invited_by      uuid        references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint organization_members_role_check
    check (role in ('owner', 'admin', 'member')),

  constraint organization_members_unique
    unique (organization_id, user_id)
);

create index organization_members_user_idx
  on public.organization_members (user_id);

create trigger organization_members_set_updated_at
  before update on public.organization_members
  for each row execute function public.set_updated_at();

-- ───────────────────────────────────────────────────────────────────────────
-- Rollenhierarchie und Mitgliedschaftsprüfung
--
-- is_org_member ist SECURITY DEFINER, weil es aus den RLS-Policies von
-- organizations UND organization_members heraus aufgerufen wird. Ohne
-- DEFINER würde die Prüfung erneut durch die Policy laufen, die sie gerade
-- auswertet — Endlosrekursion.
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.org_role_rank(p_role text)
returns int
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_role
           when 'owner'  then 30
           when 'admin'  then 20
           when 'member' then 10
           else 0
         end;
$$;

create or replace function public.is_org_member(p_organization_id uuid, p_min_role text default 'member')
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.organization_members m
     where m.organization_id = p_organization_id
       and m.user_id = auth.uid()
       and public.org_role_rank(m.role) >= public.org_role_rank(p_min_role)
  );
$$;

revoke execute on function public.is_org_member(uuid, text) from public;
grant  execute on function public.is_org_member(uuid, text) to authenticated;

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;

create policy "organizations_select_member"
  on public.organizations for select
  using (public.is_org_member(id, 'member'));

create policy "organization_members_select_own_org"
  on public.organization_members for select
  using (user_id = auth.uid() or public.is_org_member(organization_id, 'admin'));

-- Schreibzugriff auf Organisationen und Mitgliedschaften ausschließlich
-- serverseitig (Service-Role). Keine INSERT/UPDATE/DELETE-Policies.

commit;
