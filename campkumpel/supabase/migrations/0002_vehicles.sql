-- ═══════════════════════════════════════════════════════════════════════════
-- 0002 — Fahrzeuge, Fahrzeugprofil, Zugriffsmodell
--
-- Die zentrale Architekturentscheidung von CampKumpel steht in dieser Datei:
--
--   Ein Fahrzeug gehört NIEMALS fest zu einem Nutzer.
--
-- vehicles.owner_* ist reine Eigentumsangabe (wem gehört das Fahrzeug
-- rechtlich). Die AUTORISIERUNG läuft ausschließlich über vehicle_access —
-- auch beim Privatbesitzer, der sein eigenes Wohnmobil eingetragen hat.
--
-- Warum diese Trennung, obwohl sie für B2C wie Overhead aussieht:
--
--   * Der Privatbesitzer verleiht an Freunde und Familie. Das ist kein
--     Sonderfall, das ist der Normalfall beim Wohnmobil.
--   * Fahrzeuge werden verkauft. Beim Halterwechsel muss das Fahrzeugwissen
--     bleiben und der Zugriff wechseln — zwei getrennte Vorgänge.
--   * Der Vermieterfall (B2B2C) ist dann derselbe Codepfad, nur mit
--     source = 'rental' und gesetztem valid_until. Kein zweites
--     Berechtigungssystem, kein "if (isRental)" in der Anwendung.
--
-- Hätten wir owner_user_id als Autorisierung genommen, wäre der
-- Vermieter-Pilot eine Migration über produktive Daten — genau die Sorte
-- Umbau, die man im laufenden Betrieb nicht mehr macht.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ───────────────────────────────────────────────────────────────────────────
-- vehicles — Identität und Eigentum
-- ───────────────────────────────────────────────────────────────────────────

create table public.vehicles (
  id                    uuid        primary key default gen_random_uuid(),

  -- Eigentum: genau eine der beiden Spalten ist gesetzt.
  owner_type            text        not null,
  owner_user_id         uuid        references auth.users(id) on delete set null,
  owner_organization_id uuid        references public.organizations(id) on delete cascade,

  nickname              text,                     -- "Berta", vom Nutzer vergeben
  make                  text,                     -- Hersteller, z.B. "Hymer"
  model                 text,
  model_year            int2,
  licence_plate         text,
  vin                   text,
  fleet_ref             text,                     -- interne Nummer beim Vermieter

  status                text        not null default 'active',
  created_by            uuid        references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint vehicles_owner_type_check
    check (owner_type in ('user', 'organization')),

  -- Genau ein Eigentümer, nie beide, nie keiner.
  constraint vehicles_exactly_one_owner
    check (
      (owner_type = 'user'         and owner_user_id is not null and owner_organization_id is null)
      or
      (owner_type = 'organization' and owner_organization_id is not null and owner_user_id is null)
    ),

  constraint vehicles_status_check
    check (status in ('active', 'sold', 'retired', 'archived')),

  constraint vehicles_model_year_check
    check (model_year is null or model_year between 1950 and 2100)
);

create index vehicles_owner_user_idx on public.vehicles (owner_user_id)
  where owner_user_id is not null;
create index vehicles_owner_org_idx  on public.vehicles (owner_organization_id)
  where owner_organization_id is not null;

-- VIN ist weltweit eindeutig, aber nicht immer bekannt.
create unique index vehicles_vin_unique on public.vehicles (upper(vin))
  where vin is not null;

create trigger vehicles_set_updated_at
  before update on public.vehicles
  for each row execute function public.set_updated_at();

-- ───────────────────────────────────────────────────────────────────────────
-- vehicle_access — wer darf was, ab wann, bis wann
--
-- Rollen (aufsteigend):
--   viewer   — darf lesen, nichts ändern (Beifahrer, Interessent)
--   driver   — darf fahren und Wissen beitragen (Mieter, Leihfahrer)
--   manager  — darf Profil pflegen und Zugriffe vergeben (Flottenverwalter)
--   owner    — volle Kontrolle inkl. Löschung
--
-- Ein Mieter ist ein 'driver' mit gesetztem valid_until. Es gibt bewusst
-- KEINE eigene Rolle 'renter': die Unterscheidung steckt in source und
-- Zeitfenster, nicht in der Berechtigung. Sonst hätte jede Prüfung im Code
-- zwei Fälle zu behandeln, die dasselbe dürfen.
-- ───────────────────────────────────────────────────────────────────────────

create table public.vehicle_access (
  id          uuid        primary key default gen_random_uuid(),
  vehicle_id  uuid        not null references public.vehicles(id) on delete cascade,
  user_id     uuid        not null references auth.users(id) on delete cascade,
  role        text        not null default 'driver',
  source      text        not null default 'direct',
  rental_id   uuid,                                -- FK wird in 0003 ergänzt
  valid_from  timestamptz not null default now(),
  valid_until timestamptz,                         -- null = unbefristet
  granted_by  uuid        references auth.users(id) on delete set null,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint vehicle_access_role_check
    check (role in ('viewer', 'driver', 'manager', 'owner')),

  constraint vehicle_access_source_check
    check (source in ('direct', 'rental', 'invite', 'organization')),

  constraint vehicle_access_period_check
    check (valid_until is null or valid_until > valid_from)
);

-- Eine aktive Berechtigung pro (Fahrzeug, Nutzer, Quelle). Widerrufene
-- Einträge bleiben als Historie erhalten und kollidieren nicht.
create unique index vehicle_access_active_unique
  on public.vehicle_access (vehicle_id, user_id, source)
  where revoked_at is null;

create index vehicle_access_user_idx    on public.vehicle_access (user_id) where revoked_at is null;
create index vehicle_access_vehicle_idx on public.vehicle_access (vehicle_id) where revoked_at is null;
create index vehicle_access_expiry_idx  on public.vehicle_access (valid_until)
  where revoked_at is null and valid_until is not null;

create trigger vehicle_access_set_updated_at
  before update on public.vehicle_access
  for each row execute function public.set_updated_at();

-- ───────────────────────────────────────────────────────────────────────────
-- Zugriffsprüfung
--
-- has_vehicle_access ist SECURITY DEFINER und damit RLS-frei. Das ist keine
-- Bequemlichkeit, sondern notwendig: die Funktion wird aus den Policies von
-- vehicles, vehicle_profiles, vehicle_memory, vehicle_documents und
-- conversations aufgerufen. Liefe sie selbst unter RLS, entstünde beim
-- Auswerten der vehicle_access-Policy eine Rekursion.
--
-- Die Gegenmaßnahme ist die Signatur: die Funktion beantwortet ausschließlich
-- "darf der AKTUELLE Nutzer (auth.uid()) auf dieses Fahrzeug zugreifen" und
-- nimmt keine user_id entgegen. Sie kann damit nicht zum Ausspähen fremder
-- Berechtigungen zweckentfremdet werden.
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.vehicle_role_rank(p_role text)
returns int
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_role
           when 'owner'   then 40
           when 'manager' then 30
           when 'driver'  then 20
           when 'viewer'  then 10
           else 0
         end;
$$;

create or replace function public.has_vehicle_access(p_vehicle_id uuid, p_min_role text default 'viewer')
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.vehicle_access a
     where a.vehicle_id = p_vehicle_id
       and a.user_id    = auth.uid()
       and a.revoked_at is null
       and a.valid_from <= now()
       and (a.valid_until is null or a.valid_until > now())
       and public.vehicle_role_rank(a.role) >= public.vehicle_role_rank(p_min_role)
  )
  -- Organisationsfahrzeuge: Admins der Organisation haben immer Zugriff,
  -- auch ohne eigenen vehicle_access-Eintrag. Sonst müsste bei jedem neuen
  -- Flottenfahrzeug für jeden Verwalter eine Zeile angelegt werden.
  or exists (
    select 1
      from public.vehicles v
     where v.id = p_vehicle_id
       and v.owner_organization_id is not null
       and public.is_org_member(v.owner_organization_id, 'admin')
       and public.vehicle_role_rank('manager') >= public.vehicle_role_rank(p_min_role)
  );
$$;

revoke execute on function public.has_vehicle_access(uuid, text) from public;
grant  execute on function public.has_vehicle_access(uuid, text) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Eigentümer bekommt automatisch owner-Zugriff
--
-- Damit ist vehicle_access die EINZIGE Autorisierungsquelle. Ohne diesen
-- Trigger müsste jede Policy zusätzlich owner_user_id prüfen — und genau
-- solche Doppelpfade sind der Grund, warum Berechtigungsfehler entstehen.
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.grant_owner_vehicle_access()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.owner_type = 'user' and new.owner_user_id is not null then
    insert into public.vehicle_access (vehicle_id, user_id, role, source, granted_by)
    values (new.id, new.owner_user_id, 'owner', 'direct', new.created_by)
    on conflict do nothing;
  end if;
  return new;
end;
$$;

revoke execute on function public.grant_owner_vehicle_access() from public, anon, authenticated;

create trigger vehicles_grant_owner_access
  after insert on public.vehicles
  for each row execute function public.grant_owner_vehicle_access();

-- ───────────────────────────────────────────────────────────────────────────
-- vehicle_profiles — die technische Wahrheit über das Fahrzeug
--
-- Das ist der Kern des Produktversprechens. Wenn CampKumpel sagt "auf diesen
-- Stellplatz passt du nicht", muss es aus diesen Zahlen kommen — nie aus
-- einer Live-Recherche und nie aus Modellwissen über Wohnmobile im
-- Allgemeinen.
--
-- Typisierte Spalten statt einem großen JSONB, weil die Werte validiert,
-- verglichen und in Prompts gerechnet werden. Was selten gebraucht wird oder
-- modellspezifisch ist, liegt in extra.
--
-- field_sources hält die Herkunft je Feld:
--   {"height_total_mm": {"source": "document", "confidence": 0.9,
--                        "updated_at": "...", "document_id": "..."}}
-- Damit kann die Anwendung "laut deinen Papieren" von "hast du mir gesagt"
-- von "habe ich aus dem Katalog" unterscheiden. Bei Maßangaben ist dieser
-- Unterschied sicherheitsrelevant.
-- ───────────────────────────────────────────────────────────────────────────

create table public.vehicle_profiles (
  vehicle_id              uuid        primary key references public.vehicles(id) on delete cascade,

  -- Bauform und Basis
  body_type               text,
  base_vehicle            text,                  -- Chassis, z.B. "Fiat Ducato 2.3"
  licence_required        text,                  -- B | B96 | BE | C1 | C

  -- Maße in Millimetern. Ganzzahlig, weil Zentimeterangaben in Gesprächen
  -- gerundet werden und wir den Rundungsfehler nicht in der DB wollen.
  length_mm               int,
  width_mm                int,                   -- ohne Spiegel
  width_mirrors_mm        int,                   -- mit Spiegeln (Fähren, Waschstraßen)
  height_mm               int,                   -- Herstellerangabe
  height_total_mm         int,                   -- inkl. Aufbauten: Klima, Solar, Dachbox
  wheelbase_mm            int,

  -- Gewichte in Kilogramm
  mass_empty_kg           int,                   -- Leergewicht
  mass_max_kg             int,                   -- zulässige Gesamtmasse
  payload_kg              int,                   -- Zuladung
  axle_load_front_kg      int,
  axle_load_rear_kg       int,
  roof_load_kg            int,
  towbar                  boolean,
  trailer_load_braked_kg  int,
  bike_rack_max_kg        int,

  -- Wasser und Sanitär, Liter
  fresh_water_l           int,
  grey_water_l            int,
  black_water_l           int,
  toilet_type             text,                  -- cassette | fixed | separett | none

  -- Antrieb
  fuel_type               text,                  -- diesel | petrol | lpg | electric | hybrid
  fuel_tank_l             int,
  adblue_tank_l           int,
  consumption_l_100km     numeric(4,1),
  emission_class          text,                  -- für Umweltzonen

  -- Gas
  gas_system              text,                  -- bottles | refillable_tank | none
  gas_bottle_count        int2,
  gas_bottle_kg           int2,
  gas_tank_l              int,

  -- Strom
  leisure_battery_type    text,                  -- agm | gel | lifepo4 | lead
  leisure_battery_ah      int,
  solar_wp                int,
  inverter_w              int,
  shore_power_a           int2       default 16,

  -- Ausbau
  heating_type            text,                  -- diesel | gas | combi | electric
  has_aircon              boolean,
  has_awning              boolean,
  beds_count              int2,
  seats_travel            int2,                  -- eingetragene Sitzplätze mit Gurt

  winter_grade            text,                  -- none | winter_capable | winterized

  -- Freitext und Herkunft
  extra                   jsonb       not null default '{}'::jsonb,
  field_sources           jsonb       not null default '{}'::jsonb,
  completeness            int2        not null default 0,   -- 0..100, berechnet
  verified_by_user        boolean     not null default false,
  notes                   text,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint vehicle_profiles_body_type_check
    check (body_type is null or body_type in (
      'kastenwagen', 'teilintegriert', 'vollintegriert', 'alkoven',
      'campervan', 'wohnwagen', 'pickup_camper', 'other'
    )),

  constraint vehicle_profiles_licence_check
    check (licence_required is null or licence_required in ('B', 'B96', 'BE', 'C1', 'C')),

  constraint vehicle_profiles_toilet_check
    check (toilet_type is null or toilet_type in ('cassette', 'fixed', 'separett', 'none')),

  constraint vehicle_profiles_gas_system_check
    check (gas_system is null or gas_system in ('bottles', 'refillable_tank', 'none')),

  constraint vehicle_profiles_winter_check
    check (winter_grade is null or winter_grade in ('none', 'winter_capable', 'winterized')),

  constraint vehicle_profiles_completeness_check
    check (completeness between 0 and 100),

  -- Plausibilität. Kein Ersatz für Validierung in der Anwendung, aber ein
  -- Netz gegen Einheitenfehler (Meter statt Millimeter, Tonnen statt Kilo).
  constraint vehicle_profiles_dimensions_plausible
    check (
      (length_mm is null or length_mm between 2000 and 20000)
      and (width_mm is null or width_mm between 1000 and 3000)
      and (height_mm is null or height_mm between 1000 and 5000)
      and (height_total_mm is null or height_total_mm between 1000 and 5000)
    ),

  constraint vehicle_profiles_mass_plausible
    check (
      (mass_empty_kg is null or mass_empty_kg between 500 and 40000)
      and (mass_max_kg is null or mass_max_kg between 500 and 40000)
      and (mass_empty_kg is null or mass_max_kg is null or mass_empty_kg <= mass_max_kg)
    ),

  -- Aufbauten machen ein Fahrzeug höher, nie niedriger.
  constraint vehicle_profiles_total_height_gte_height
    check (height_mm is null or height_total_mm is null or height_total_mm >= height_mm)
);

create trigger vehicle_profiles_set_updated_at
  before update on public.vehicle_profiles
  for each row execute function public.set_updated_at();

-- Profil automatisch mit dem Fahrzeug anlegen, damit die Anwendung nie
-- zwischen "kein Profil" und "leeres Profil" unterscheiden muss.
create or replace function public.create_vehicle_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.vehicle_profiles (vehicle_id)
  values (new.id)
  on conflict (vehicle_id) do nothing;
  return new;
end;
$$;

revoke execute on function public.create_vehicle_profile() from public, anon, authenticated;

create trigger vehicles_create_profile
  after insert on public.vehicles
  for each row execute function public.create_vehicle_profile();

-- ───────────────────────────────────────────────────────────────────────────
-- Row Level Security
--
-- Lesen: jeder mit gültigem Zugriff.
-- Schreiben: nur manager und owner — und zwar serverseitig über die API.
-- Ein Mieter (driver) darf das Fahrzeugprofil also NICHT verändern. Was er
-- über das Fahrzeug lernt, landet in vehicle_memory (0005), nicht in den
-- technischen Stammdaten.
-- ───────────────────────────────────────────────────────────────────────────

alter table public.vehicles         enable row level security;
alter table public.vehicle_access   enable row level security;
alter table public.vehicle_profiles enable row level security;

create policy "vehicles_select_with_access"
  on public.vehicles for select
  using (public.has_vehicle_access(id, 'viewer'));

create policy "vehicles_update_manager"
  on public.vehicles for update
  using (public.has_vehicle_access(id, 'manager'))
  with check (public.has_vehicle_access(id, 'manager'));

create policy "vehicle_profiles_select_with_access"
  on public.vehicle_profiles for select
  using (public.has_vehicle_access(vehicle_id, 'viewer'));

create policy "vehicle_profiles_update_manager"
  on public.vehicle_profiles for update
  using (public.has_vehicle_access(vehicle_id, 'manager'))
  with check (public.has_vehicle_access(vehicle_id, 'manager'));

-- Eigene Berechtigungen sieht jeder; alle Berechtigungen am Fahrzeug nur,
-- wer es verwaltet. Ein Mieter soll nicht sehen, wer das Fahrzeug sonst noch
-- gemietet hat.
create policy "vehicle_access_select_own_or_manager"
  on public.vehicle_access for select
  using (user_id = auth.uid() or public.has_vehicle_access(vehicle_id, 'manager'));

-- Vergabe und Entzug von Zugriffen ausschließlich serverseitig.
-- Keine INSERT/UPDATE/DELETE-Policies.

commit;
