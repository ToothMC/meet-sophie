-- ═══════════════════════════════════════════════════════════════════════════
-- 0005 — Gedächtnis
--
-- Meet-Sophie trennt Gedächtnis nach GESPRÄCHSMODUS (Meeting, Brainstorming,
-- Pitch). Das ist dort eine Produktentscheidung — alles gehört ohnehin
-- demselben Nutzer.
--
-- CampKumpel trennt nach EIGENTÜMERSCHAFT UND LEBENSDAUER. Das ist keine
-- Produktentscheidung, sondern die Bedingung dafür, dass B2B2C überhaupt
-- zulässig ist:
--
--   user_memory      gehört der PERSON    → überlebt jeden Fahrzeugwechsel
--   vehicle_memory   gehört dem FAHRZEUG  → überlebt jeden Halterwechsel
--   trip_memory      gehört der REISE     → verfällt mit der Reise
--
-- Der Testfall, an dem sich die Trennung bewährt: Ein Mieter gibt das
-- Wohnmobil zurück.
--   → Sein Reiseprofil (fährt kurze Etappen, meidet Autobahnen) bleibt bei
--     ihm und ist beim nächsten Mietwagen sofort da.
--   → Sein Fund "die Heizung braucht zwei Minuten bis sie anspringt" bleibt
--     beim Fahrzeug und hilft dem nächsten Mieter.
--   → Sein Reisekontext (war in Bozen, Streit über die Route) verfällt und
--     wird von niemandem je wieder gelesen.
-- Keine dieser drei Regeln lässt sich über eine gemeinsame Tabelle mit
-- Filterlogik zuverlässig herstellen.
--
-- Von Sophie übernommen: Verdichtung statt Anhängen (eine Profilzeile, die
-- fortgeschrieben wird), TTL auf der Kurzzeitebene, Konfidenz je Eintrag.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ───────────────────────────────────────────────────────────────────────────
-- user_travel_profile — das verdichtete Reiseprofil der Person
--
-- Eine Zeile pro Nutzer, periodisch neu verdichtet. Das ist Sophies
-- sophie_long_term_memory-Muster: kein unbegrenzt wachsendes Log, sondern ein
-- Zustand, der überschrieben wird.
-- ───────────────────────────────────────────────────────────────────────────

create table public.user_travel_profile (
  user_id                 uuid        primary key references auth.users(id) on delete cascade,

  -- Fahrverhalten
  driving_style           text,                    -- relaxed | efficient | mixed
  daily_km_typical        int2,
  daily_km_max            int2,
  avoids_motorways        boolean,
  avoids_toll             boolean,
  avoids_narrow_roads     boolean,
  night_driving           boolean,

  -- Übernachten
  preferred_site_types    text[]      not null default '{}',  -- campingplatz, stellplatz, frei, bauernhof
  books_ahead             text,                    -- never | sometimes | always
  needs_shore_power       boolean,
  min_stay_nights         int2,

  -- Reisestil
  travel_pace             text,                    -- slow | balanced | packed
  interests               text[]      not null default '{}',
  avoid_topics            text[]      not null default '{}',
  budget_level            text,                    -- low | medium | high

  -- Begleitung (Standardwerte; die konkrete Reise überschreibt sie in trips)
  travels_with_children   boolean,
  travels_with_pets       boolean,
  accessibility_needs     text,

  experience_level        text,                    -- first_time | occasional | experienced

  -- Freies Dossier, von der KI nach jeder Sitzung zusammengeführt statt
  -- angehängt. Übernommen aus Sophies user_profile.memory_file — der Ansatz
  -- fängt genau das auf, was kein Schema vorhersieht.
  memory_file             text        not null default '',

  depth                   text        not null default 'light',
  last_condensed_at       timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint user_travel_profile_driving_style_check
    check (driving_style is null or driving_style in ('relaxed', 'efficient', 'mixed')),
  constraint user_travel_profile_books_ahead_check
    check (books_ahead is null or books_ahead in ('never', 'sometimes', 'always')),
  constraint user_travel_profile_pace_check
    check (travel_pace is null or travel_pace in ('slow', 'balanced', 'packed')),
  constraint user_travel_profile_budget_check
    check (budget_level is null or budget_level in ('low', 'medium', 'high')),
  constraint user_travel_profile_experience_check
    check (experience_level is null or experience_level in ('first_time', 'occasional', 'experienced')),
  constraint user_travel_profile_depth_check
    check (depth in ('light', 'medium', 'deep')),
  -- Dossier begrenzen. Sophie deckelt bei ~2000 Zeilen in der Anwendung;
  -- eine harte Grenze in der DB ist die verlässlichere Bremse.
  constraint user_travel_profile_memory_file_size
    check (length(memory_file) <= 60000)
);

create trigger user_travel_profile_set_updated_at
  before update on public.user_travel_profile
  for each row execute function public.set_updated_at();

-- ───────────────────────────────────────────────────────────────────────────
-- user_memory — einzelne Erkenntnisse über die Person
--
-- Ergänzt das verdichtete Profil um das, was noch nicht verdichtet ist oder
-- in kein Feld passt. Upsert auf (user_id, kind, key): wiederholte
-- Beobachtungen erhöhen evidence_count und confidence, statt Duplikate
-- anzulegen.
-- ───────────────────────────────────────────────────────────────────────────

create table public.user_memory (
  id             uuid        primary key default gen_random_uuid(),
  user_id        uuid        not null references auth.users(id) on delete cascade,
  kind           text        not null,
  key            text        not null,
  value          text        not null,
  confidence     real        not null default 0.5,
  evidence_count int2        not null default 1,
  source         text        not null default 'conversation',
  last_seen_at   timestamptz not null default now(),
  expires_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint user_memory_kind_check
    check (kind in ('preference', 'pattern', 'fact', 'goal', 'constraint')),
  constraint user_memory_source_check
    check (source in ('conversation', 'onboarding', 'inferred', 'imported')),
  constraint user_memory_confidence_check
    check (confidence >= 0 and confidence <= 1),
  constraint user_memory_unique
    unique (user_id, kind, key)
);

create index user_memory_lookup_idx on public.user_memory (user_id, confidence desc);
create index user_memory_expiry_idx on public.user_memory (expires_at) where expires_at is not null;

create trigger user_memory_set_updated_at
  before update on public.user_memory
  for each row execute function public.set_updated_at();

-- ───────────────────────────────────────────────────────────────────────────
-- vehicle_memory — Wissen über DAS Fahrzeug
--
-- Nicht die technischen Stammdaten (die stehen in vehicle_profiles), sondern
-- das Erfahrungswissen: Eigenheiten, Defekte, Kniffe, wo die Kurbel liegt.
--
-- Die Spalte visibility ist die Datenschutzsicherung des B2B2C-Falls:
--
--   'vehicle'     — sichtbar für alle mit Fahrzeugzugriff. Der Regelfall und
--                   genau das, was die Vermietung wertvoll macht: der nächste
--                   Mieter profitiert.
--   'author_only' — nur für den, der es notiert hat. Für alles, was zwar am
--                   Fahrzeug hängt, aber niemanden sonst angeht.
--
-- Die Schreibpfade der Anwendung setzen visibility, nicht das Modell: was
-- während einer Miete (source = 'rental') geschrieben wird, gilt als
-- 'author_only', sofern es nicht eindeutig eine technische Fahrzeugeigenschaft
-- ist. Im Zweifel privat — ein verlorener Hinweis kostet Komfort, ein
-- geleakter Hinweis kostet das Produkt.
-- ───────────────────────────────────────────────────────────────────────────

create table public.vehicle_memory (
  id              uuid        primary key default gen_random_uuid(),
  vehicle_id      uuid        not null references public.vehicles(id) on delete cascade,

  -- Wer es beigetragen hat. on delete set null: das Wissen bleibt am
  -- Fahrzeug, auch wenn der Beitragende sein Konto löscht.
  author_user_id  uuid        references auth.users(id) on delete set null,

  kind            text        not null,
  key             text        not null,
  value           text        not null,
  visibility      text        not null default 'vehicle',
  confidence      real        not null default 0.5,
  evidence_count  int2        not null default 1,
  source          text        not null default 'conversation',
  document_id     uuid,                          -- FK wird in 0006 ergänzt
  last_seen_at    timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint vehicle_memory_kind_check
    check (kind in ('quirk', 'defect', 'tip', 'maintenance', 'equipment', 'fact')),
  constraint vehicle_memory_visibility_check
    check (visibility in ('vehicle', 'author_only')),
  constraint vehicle_memory_source_check
    check (source in ('conversation', 'document', 'manual_entry', 'inferred')),
  constraint vehicle_memory_confidence_check
    check (confidence >= 0 and confidence <= 1)
);

-- Eindeutigkeit getrennt nach Sichtbarkeit: geteiltes Wissen einmal pro
-- Fahrzeug, privates Wissen einmal pro Fahrzeug und Autor. Sonst würde der
-- private Eintrag eines Mieters den geteilten Eintrag blockieren.
create unique index vehicle_memory_shared_unique
  on public.vehicle_memory (vehicle_id, kind, key)
  where visibility = 'vehicle';

create unique index vehicle_memory_private_unique
  on public.vehicle_memory (vehicle_id, author_user_id, kind, key)
  where visibility = 'author_only';

create index vehicle_memory_lookup_idx
  on public.vehicle_memory (vehicle_id, visibility, confidence desc);

create trigger vehicle_memory_set_updated_at
  before update on public.vehicle_memory
  for each row execute function public.set_updated_at();

-- ───────────────────────────────────────────────────────────────────────────
-- trip_memory — Kontext der laufenden Reise
--
-- Die Kurzzeitebene. TTL wie bei Sophies sophie_short_term_memory, hier an
-- die Reise gebunden statt an einen festen Zeitraum: 30 Tage nach Reiseende
-- ist der Kontext nicht mehr aktuell und fließt nicht mehr in Prompts ein.
-- ───────────────────────────────────────────────────────────────────────────

create table public.trip_memory (
  id               uuid        primary key default gen_random_uuid(),
  trip_id          uuid        not null references public.trips(id) on delete cascade,
  user_id          uuid        not null references auth.users(id) on delete cascade,
  conversation_id  uuid        references public.conversations(id) on delete set null,

  summary          text        not null,
  open_topics      text[]      not null default '{}',
  next_steps       text[]      not null default '{}',
  current_location text,
  importance       real        not null default 0.5,
  expires_at       timestamptz not null default now() + interval '30 days',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint trip_memory_importance_check
    check (importance >= 0 and importance <= 1)
);

create index trip_memory_trip_idx   on public.trip_memory (trip_id, importance desc);
create index trip_memory_expiry_idx on public.trip_memory (expires_at);

create trigger trip_memory_set_updated_at
  before update on public.trip_memory
  for each row execute function public.set_updated_at();

-- Reiseprofil automatisch anlegen, analog zu vehicle_profiles.
create or replace function public.create_travel_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.user_travel_profile (user_id)
  values (new.user_id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke execute on function public.create_travel_profile() from public, anon, authenticated;

create trigger profiles_create_travel_profile
  after insert on public.profiles
  for each row execute function public.create_travel_profile();

-- Aufräumen abgelaufener Einträge. Vorgesehen als täglicher Cron-Aufruf.
create or replace function public.cleanup_expired_memory()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_total int := 0;
  v_count int;
begin
  delete from public.trip_memory where expires_at < now();
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;

  delete from public.user_memory where expires_at is not null and expires_at < now();
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;

  return v_total;
end;
$$;

revoke execute on function public.cleanup_expired_memory() from public, anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ───────────────────────────────────────────────────────────────────────────

alter table public.user_travel_profile enable row level security;
alter table public.user_memory         enable row level security;
alter table public.vehicle_memory      enable row level security;
alter table public.trip_memory         enable row level security;

create policy "user_travel_profile_select_own"
  on public.user_travel_profile for select
  using (user_id = auth.uid());

create policy "user_travel_profile_update_own"
  on public.user_travel_profile for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "user_memory_select_own"
  on public.user_memory for select
  using (user_id = auth.uid());

-- Löschen darf der Nutzer selbst: "vergiss das" muss ohne Support gehen.
create policy "user_memory_delete_own"
  on public.user_memory for delete
  using (user_id = auth.uid());

-- Die zentrale Policy des B2B2C-Modells. Geteiltes Fahrzeugwissen sieht
-- jeder mit Zugriff; privates Wissen nur sein Autor — auch der
-- Fahrzeugeigentümer nicht.
create policy "vehicle_memory_select_scoped"
  on public.vehicle_memory for select
  using (
    (visibility = 'vehicle'     and public.has_vehicle_access(vehicle_id, 'viewer'))
    or
    (visibility = 'author_only' and author_user_id = auth.uid())
  );

create policy "vehicle_memory_delete_author"
  on public.vehicle_memory for delete
  using (
    author_user_id = auth.uid()
    or public.has_vehicle_access(vehicle_id, 'manager')
  );

create policy "trip_memory_select_own"
  on public.trip_memory for select
  using (user_id = auth.uid());

create policy "trip_memory_delete_own"
  on public.trip_memory for delete
  using (user_id = auth.uid());

-- Geschrieben wird Gedächtnis ausschließlich serverseitig, aus der
-- Nachbearbeitung eines Gesprächs. Keine INSERT/UPDATE-Policies für
-- user_memory, vehicle_memory, trip_memory.

commit;
