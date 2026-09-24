-- ═══════════════════════════════════════════════════════════════════════════
-- 0003 — Reisen und Vermietungen
--
-- TRIP ist die dritte Kernentität: eine Reise mit einem Fahrzeug, zu der es
-- Kontext gibt (Route, Wetterlage, was unterwegs passiert ist). Sie gehört
-- dem Nutzer, nicht dem Fahrzeug — der Mieter nimmt seine Reise mit, wenn er
-- das Fahrzeug zurückgibt.
--
-- RENTAL ist die B2B2C-Klammer: eine Organisation vermietet ein Fahrzeug für
-- einen Zeitraum an eine Person. Der Lebenszyklus der Vermietung steuert den
-- vehicle_access — automatisch, über die RPCs am Ende dieser Datei.
--
-- Im MVP existiert für Vermietungen keine UI. Die Tabellen und RPCs sind
-- trotzdem da, weil der Pilot sonst zu einem Schemaumbau unter Last würde.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ───────────────────────────────────────────────────────────────────────────
-- rentals
-- ───────────────────────────────────────────────────────────────────────────

create table public.rentals (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  vehicle_id      uuid        not null references public.vehicles(id) on delete cascade,

  -- Der Mieter hat sich zum Buchungszeitpunkt oft noch nicht registriert.
  -- Deshalb ist renter_user_id nullable und renter_email die Brücke:
  -- bei der Registrierung wird über die E-Mail verknüpft.
  renter_user_id  uuid        references auth.users(id) on delete set null,
  renter_email    citext,

  booking_ref     text,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  status          text        not null default 'booked',
  handover_at     timestamptz,
  return_at       timestamptz,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint rentals_status_check
    check (status in ('booked', 'active', 'completed', 'cancelled', 'no_show')),

  constraint rentals_period_check
    check (ends_at > starts_at),

  constraint rentals_renter_identifiable
    check (renter_user_id is not null or renter_email is not null),

  constraint rentals_booking_ref_unique
    unique (organization_id, booking_ref)
);

create index rentals_vehicle_period_idx on public.rentals (vehicle_id, starts_at, ends_at);
create index rentals_renter_idx         on public.rentals (renter_user_id) where renter_user_id is not null;
create index rentals_renter_email_idx   on public.rentals (renter_email)   where renter_email is not null;
create index rentals_org_status_idx     on public.rentals (organization_id, status);

create trigger rentals_set_updated_at
  before update on public.rentals
  for each row execute function public.set_updated_at();

-- Die in 0002 offen gelassene Referenz nachziehen. on delete set null, nicht
-- cascade: wird eine Vermietung storniert, soll die Zugriffshistorie erhalten
-- bleiben — sie ist der Nachweis, wer wann Zugriff hatte.
alter table public.vehicle_access
  add constraint vehicle_access_rental_fk
  foreign key (rental_id) references public.rentals(id) on delete set null;

-- ───────────────────────────────────────────────────────────────────────────
-- trips
-- ───────────────────────────────────────────────────────────────────────────

create table public.trips (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references auth.users(id) on delete cascade,
  vehicle_id   uuid        references public.vehicles(id) on delete set null,
  rental_id    uuid        references public.rentals(id) on delete set null,

  title        text,
  status       text        not null default 'planned',
  started_at   timestamptz,
  ended_at     timestamptz,

  origin       text,
  destination  text,
  waypoints    jsonb       not null default '[]'::jsonb,
  countries    text[]      not null default '{}',

  -- Reisezusammensetzung: beeinflusst fast jede Empfehlung (Stellplatzwahl,
  -- Etappenlänge, Hundestrände, Spielplätze).
  adults       int2,
  children     int2,
  pets         int2,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint trips_status_check
    check (status in ('planned', 'active', 'completed', 'archived')),

  constraint trips_period_check
    check (started_at is null or ended_at is null or ended_at >= started_at),

  constraint trips_party_check
    check (
      (adults   is null or adults   between 0 and 20)
      and (children is null or children between 0 and 20)
      and (pets     is null or pets     between 0 and 20)
    )
);

create index trips_user_status_idx on public.trips (user_id, status);
create index trips_vehicle_idx     on public.trips (vehicle_id) where vehicle_id is not null;

-- Höchstens eine aktive Reise pro Nutzer. Der Reisekontext im Prompt ist
-- eindeutig oder er ist wertlos.
create unique index trips_one_active_per_user
  on public.trips (user_id)
  where status = 'active';

create trigger trips_set_updated_at
  before update on public.trips
  for each row execute function public.set_updated_at();

-- ───────────────────────────────────────────────────────────────────────────
-- Vermietungs-Lebenszyklus
--
-- Zwei RPCs, die den Fahrzeugzugriff an den Vermietungsstatus koppeln. Sie
-- sind SECURITY DEFINER, weil sie in vehicle_access schreiben, wofür es
-- absichtlich keine Client-Policy gibt. Aufruf ausschließlich aus der
-- Backend-API mit Service-Role.
--
-- Der Entzug ist die wichtigere der beiden Funktionen. Er darf nicht davon
-- abhängen, dass jemand einen Endpunkt aufruft — deshalb zusätzlich
-- valid_until auf dem Access-Eintrag: läuft die Zeit ab, greift
-- has_vehicle_access nicht mehr, auch wenn kein Rückgabe-Event kam.
-- Zwei unabhängige Sperren für dieselbe Sache.
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.rental_grant_access(p_rental_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rental  public.rentals%rowtype;
  v_access  uuid;
begin
  select * into v_rental from public.rentals where id = p_rental_id;
  if not found then
    raise exception 'rental % not found', p_rental_id using errcode = 'no_data_found';
  end if;

  if v_rental.renter_user_id is null then
    raise exception 'rental % has no registered renter yet', p_rental_id using errcode = 'invalid_parameter_value';
  end if;

  if v_rental.status not in ('booked', 'active') then
    raise exception 'rental % is %, cannot grant access', p_rental_id, v_rental.status using errcode = 'invalid_parameter_value';
  end if;

  -- Kulanzfenster: Zugriff endet nicht auf die Minute der Rückgabe. Eine
  -- verspätete Rückkehr soll den Begleiter nicht mitten auf der Autobahn
  -- abschalten.
  insert into public.vehicle_access (
    vehicle_id, user_id, role, source, rental_id, valid_from, valid_until
  )
  values (
    v_rental.vehicle_id,
    v_rental.renter_user_id,
    'driver',
    'rental',
    v_rental.id,
    least(v_rental.starts_at, now()),
    v_rental.ends_at + interval '12 hours'
  )
  on conflict (vehicle_id, user_id, source) where revoked_at is null
  do update set
    rental_id   = excluded.rental_id,
    valid_from  = excluded.valid_from,
    valid_until = excluded.valid_until,
    role        = excluded.role,
    updated_at  = now()
  returning id into v_access;

  update public.rentals
     set status      = 'active',
         handover_at = coalesce(handover_at, now()),
         updated_at  = now()
   where id = p_rental_id;

  return v_access;
end;
$$;

create or replace function public.rental_revoke_access(p_rental_id uuid, p_complete boolean default true)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  update public.vehicle_access
     set revoked_at = now(),
         updated_at = now()
   where rental_id = p_rental_id
     and revoked_at is null;

  get diagnostics v_count = row_count;

  if p_complete then
    update public.rentals
       set status     = 'completed',
           return_at  = coalesce(return_at, now()),
           updated_at = now()
     where id = p_rental_id
       and status <> 'cancelled';
  end if;

  -- Laufende Reisen der Vermietung abschließen. Die Reise bleibt beim
  -- Mieter — nur ihr Kontext ist ab jetzt Vergangenheit und fließt nicht
  -- mehr in den Prompt ein.
  update public.trips
     set status     = 'completed',
         ended_at   = coalesce(ended_at, now()),
         updated_at = now()
   where rental_id = p_rental_id
     and status = 'active';

  return v_count;
end;
$$;

-- Sicherheitsnetz gegen vergessene Rückgaben: alle abgelaufenen
-- Berechtigungen hart widerrufen. Vorgesehen als täglicher Cron-Aufruf
-- (Vercel Cron → /api/cron/expire-access), nicht als Client-Aufruf.
create or replace function public.expire_vehicle_access()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  update public.vehicle_access
     set revoked_at = now(),
         updated_at = now()
   where revoked_at is null
     and valid_until is not null
     and valid_until < now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.rental_grant_access(uuid)          from public, anon, authenticated;
revoke execute on function public.rental_revoke_access(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.expire_vehicle_access()             from public, anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Row Level Security
--
-- Der Mieter sieht seine eigene Vermietung — aber nicht die anderen
-- Vermietungen desselben Fahrzeugs. Das ist der Punkt, an dem B2B2C
-- datenschutzrechtlich steht oder fällt.
-- ───────────────────────────────────────────────────────────────────────────

alter table public.rentals enable row level security;
alter table public.trips   enable row level security;

create policy "rentals_select_renter_or_org"
  on public.rentals for select
  using (
    renter_user_id = auth.uid()
    or public.is_org_member(organization_id, 'member')
  );

create policy "trips_select_own"
  on public.trips for select
  using (user_id = auth.uid());

create policy "trips_insert_own"
  on public.trips for insert
  with check (
    user_id = auth.uid()
    and (vehicle_id is null or public.has_vehicle_access(vehicle_id, 'driver'))
  );

create policy "trips_update_own"
  on public.trips for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "trips_delete_own"
  on public.trips for delete
  using (user_id = auth.uid());

commit;
