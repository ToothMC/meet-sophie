-- ═══════════════════════════════════════════════════════════════════════════
-- 0006 — Fahrzeugdokumente und Abruf
--
-- Die Bedienungsanleitung ist die dichteste Wissensquelle über ein Fahrzeug,
-- und sie liegt als PDF vor. Meet-Sophie hat dafür Parser (pdf-parse,
-- mammoth) und ein Storage-Muster (privater Bucket, Signed URLs), aber keine
-- Abrufschicht: Dokumente werden zusammengefasst, nicht durchsuchbar gemacht.
-- Bei 200 Seiten Wohnmobilhandbuch reicht eine Zusammenfassung nicht — man
-- braucht die eine Stelle über die Wasserpumpe.
--
-- Deshalb Chunking plus deutsche Volltextsuche. Bewusst KEINE Embeddings im
-- MVP: sie kosten Geld pro Dokument und pro Abfrage, und für Fachbegriffe in
-- einem Handbuch ("Frischwassertank", "Aufbaubatterie") ist lexikalische
-- Suche oft besser als semantische. Die Erweiterung ist in 0006b vorbereitet
-- (siehe Kommentar am Dateiende) und hinter dem Flag document_embeddings.
--
-- Sicherheitsannahme: Dokumentinhalte sind FREMDDATEN. Sophie behandelt
-- Council-Antworten bereits so (COUNCIL_RULE in api/chat.js — Anweisungen im
-- Datenblock werden nicht befolgt). Für hochgeladene PDFs gilt dasselbe:
-- Chunks gehen in einen abgegrenzten Kontextblock, nie in die Anweisungsebene.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ───────────────────────────────────────────────────────────────────────────
-- vehicle_documents
--
-- storage_path zeigt in den privaten Supabase-Storage-Bucket
-- 'vehicle-documents'. Der Bucket wird nicht per SQL angelegt (Supabase
-- Storage hat dafür keine SQL-API) — siehe Anleitung am Dateiende.
-- ───────────────────────────────────────────────────────────────────────────

create table public.vehicle_documents (
  id               uuid        primary key default gen_random_uuid(),
  vehicle_id       uuid        not null references public.vehicles(id) on delete cascade,
  uploaded_by      uuid        references auth.users(id) on delete set null,

  doc_type         text        not null default 'other',
  title            text        not null,
  storage_path     text        not null unique,
  mime_type        text,
  size_bytes       bigint,
  page_count       int,
  language         text,

  -- Wie vehicle_memory.visibility: der Regelfall ist "alle mit
  -- Fahrzeugzugriff". Die Fahrzeugpapiere eines Vermieters gehen den Mieter
  -- aber nichts an, und die Versicherungspolice des Mieters nicht den
  -- Vermieter.
  visibility       text        not null default 'vehicle',

  status           text        not null default 'pending',
  error_message    text,
  parsed_at        timestamptz,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint vehicle_documents_doc_type_check
    check (doc_type in (
      'manual',            -- Bedienungsanleitung
      'registration',      -- Fahrzeugschein / Zulassung
      'insurance',
      'service',           -- Wartungsnachweis
      'handover',          -- Übergabeprotokoll (B2B2C)
      'floorplan',
      'other'
    )),

  constraint vehicle_documents_visibility_check
    check (visibility in ('vehicle', 'org_only', 'author_only')),

  constraint vehicle_documents_status_check
    check (status in ('pending', 'parsing', 'parsed', 'failed')),

  constraint vehicle_documents_size_check
    check (size_bytes is null or size_bytes between 0 and 104857600)  -- 100 MB
);

create index vehicle_documents_vehicle_idx on public.vehicle_documents (vehicle_id, doc_type);
create index vehicle_documents_status_idx  on public.vehicle_documents (status) where status in ('pending', 'parsing');

create trigger vehicle_documents_set_updated_at
  before update on public.vehicle_documents
  for each row execute function public.set_updated_at();

-- Die in 0005 offen gelassene Referenz nachziehen: ein Gedächtniseintrag darf
-- auf das Dokument zeigen, aus dem er stammt.
alter table public.vehicle_memory
  add constraint vehicle_memory_document_fk
  foreign key (document_id) references public.vehicle_documents(id) on delete set null;

-- ───────────────────────────────────────────────────────────────────────────
-- document_chunks
--
-- vehicle_id ist hier absichtlich dupliziert (es ließe sich über
-- document_id joinen). Grund: die RLS-Policy und der Abruffilter laufen bei
-- jeder Suchanfrage, und ein Join auf vehicle_documents in der Policy wäre
-- auf dem heißen Pfad. Die Konsistenz sichert ein Trigger.
-- ───────────────────────────────────────────────────────────────────────────

create table public.document_chunks (
  id           uuid        primary key default gen_random_uuid(),
  document_id  uuid        not null references public.vehicle_documents(id) on delete cascade,
  vehicle_id   uuid        not null references public.vehicles(id) on delete cascade,

  chunk_index  int         not null,
  content      text        not null,
  page_from    int,
  page_to      int,
  heading      text,
  token_count  int,

  content_tsv  tsvector    generated always as (
                 to_tsvector('german', coalesce(heading, '') || ' ' || content)
               ) stored,

  created_at   timestamptz not null default now(),

  constraint document_chunks_index_check check (chunk_index >= 0),
  constraint document_chunks_unique      unique (document_id, chunk_index)
);

create index document_chunks_tsv_idx     on public.document_chunks using gin (content_tsv);
create index document_chunks_vehicle_idx on public.document_chunks (vehicle_id);

-- vehicle_id am Chunk immer aus dem Dokument ableiten, nie vom Aufrufer
-- übernehmen. Sonst könnte ein fehlerhafter Schreibpfad Chunks am falschen
-- Fahrzeug einhängen — und damit an der RLS vorbei sichtbar machen.
create or replace function public.sync_chunk_vehicle_id()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  select d.vehicle_id into new.vehicle_id
    from public.vehicle_documents d
   where d.id = new.document_id;

  if new.vehicle_id is null then
    raise exception 'document % not found', new.document_id using errcode = 'no_data_found';
  end if;

  return new;
end;
$$;

revoke execute on function public.sync_chunk_vehicle_id() from public, anon, authenticated;

create trigger document_chunks_sync_vehicle
  before insert or update of document_id on public.document_chunks
  for each row execute function public.sync_chunk_vehicle_id();

-- ───────────────────────────────────────────────────────────────────────────
-- search_vehicle_documents — Abruf für den Prompt-Aufbau
--
-- SECURITY INVOKER (Standard), damit die RLS-Policies der aufrufenden Rolle
-- greifen. Wird die Funktion mit Service-Role aufgerufen, muss die API den
-- Fahrzeugzugriff vorher selbst geprüft haben — wie bei allen anderen
-- serverseitigen Pfaden auch.
--
-- Zwei Stufen, und das ist der entscheidende Teil:
--
--   strikt  — websearch_to_tsquery, verknüpft alle Begriffe mit UND
--   weit    — dieselben Lexeme mit ODER
--
-- Nur die strikte Stufe zu nehmen wäre der naheliegende Fehler. Die Frage
-- "wie fülle ich den Frischwassertank" wird zu 'frischwassertank' & 'full',
-- der Handbuchabsatz enthält aber 'frischwassertank' und 'befullt' — der
-- deutsche Stemmer bildet "befüllt" nicht auf "füllen" ab. Mit UND-Semantik
-- liefert die Suche nichts, und zwar lautlos: kein Fehler, nur eine Antwort
-- ohne Handbuchwissen.
--
-- Deshalb ODER als Grundlage und ts_rank für die Reihenfolge; Treffer, die
-- zusätzlich der strikten Abfrage genügen, stehen oben. Für einen Abruf, der
-- ein Sprachmodell füttert, ist Trefferquote wichtiger als Genauigkeit —
-- das Modell verwirft einen unpassenden Absatz, aber es kann einen fehlenden
-- nicht erraten.
--
-- Die Lexeme kommen aus to_tsvector, sind also bereits gestemmt und von
-- Stoppwörtern befreit. quote_literal schützt beim Zusammenbau der Abfrage
-- vor Sonderzeichen aus der Nutzereingabe.
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.search_vehicle_documents(
  p_vehicle_id uuid,
  p_query      text,
  p_limit      int default 6
)
returns table (
  chunk_id    uuid,
  document_id uuid,
  doc_type    text,
  title       text,
  heading     text,
  content     text,
  page_from   int,
  rank        real,
  exact       boolean
)
language sql
stable
set search_path = public, pg_temp
as $$
  with q as (
    select websearch_to_tsquery('german', coalesce(p_query, '')) as strict_q,
           (
             select to_tsquery('german', string_agg(quote_literal(lexeme), ' | '))
               from unnest(to_tsvector('german', coalesce(p_query, '')))
           ) as loose_q
  )
  select c.id,
         c.document_id,
         d.doc_type,
         d.title,
         c.heading,
         c.content,
         c.page_from,
         ts_rank(c.content_tsv, coalesce(q.loose_q, q.strict_q)) as rank,
         coalesce(c.content_tsv @@ q.strict_q, false)            as exact
    from public.document_chunks c
    join public.vehicle_documents d on d.id = c.document_id
   cross join q
   where c.vehicle_id = p_vehicle_id
     and d.status = 'parsed'
     and coalesce(q.loose_q, q.strict_q) is not null
     and c.content_tsv @@ coalesce(q.loose_q, q.strict_q)
   -- Ausdrücke statt Aliasnamen: chunk_id, rank und exact sind auch
   -- OUT-Parameter der Funktion und wären hier mehrdeutig.
   order by coalesce(c.content_tsv @@ q.strict_q, false) desc,
            ts_rank(c.content_tsv, coalesce(q.loose_q, q.strict_q)) desc
   limit greatest(1, least(coalesce(p_limit, 6), 20));
$$;

grant execute on function public.search_vehicle_documents(uuid, text, int) to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ───────────────────────────────────────────────────────────────────────────

alter table public.vehicle_documents enable row level security;
alter table public.document_chunks   enable row level security;

create policy "vehicle_documents_select_scoped"
  on public.vehicle_documents for select
  using (
    (visibility = 'vehicle'     and public.has_vehicle_access(vehicle_id, 'viewer'))
    or
    (visibility = 'org_only'    and public.has_vehicle_access(vehicle_id, 'manager'))
    or
    (visibility = 'author_only' and uploaded_by = auth.uid())
  );

create policy "vehicle_documents_delete_scoped"
  on public.vehicle_documents for delete
  using (
    uploaded_by = auth.uid()
    or public.has_vehicle_access(vehicle_id, 'manager')
  );

-- Chunks erben die Sichtbarkeit ihres Dokuments. Der exists-Join greift hier
-- die vehicle_documents-Policy nicht automatisch ab, deshalb wird die
-- Bedingung gespiegelt.
create policy "document_chunks_select_scoped"
  on public.document_chunks for select
  using (exists (
    select 1
      from public.vehicle_documents d
     where d.id = document_chunks.document_id
       and (
         (d.visibility = 'vehicle'     and public.has_vehicle_access(d.vehicle_id, 'viewer'))
         or (d.visibility = 'org_only'    and public.has_vehicle_access(d.vehicle_id, 'manager'))
         or (d.visibility = 'author_only' and d.uploaded_by = auth.uid())
       )
  ));

-- Upload und Parsing laufen serverseitig. Keine INSERT/UPDATE-Policies.

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Manuell nach dieser Migration (Supabase Storage hat keine SQL-API):
--
--   Bucket:  vehicle-documents
--   Public:  nein
--   Zugriff: ausschließlich über Signed URLs aus der Backend-API,
--            nachdem has_vehicle_access geprüft wurde
--   Pfad:    {vehicle_id}/{document_id}.{ext}
--
-- Der Pfad beginnt mit der vehicle_id, damit sich später eine
-- Storage-Policy auf Pfadpräfix-Basis ergänzen lässt, ohne die Dateien
-- umzulegen.
--
-- Spätere Erweiterung 0006b (Flag: document_embeddings):
--
--   create extension if not exists vector;
--   alter table public.document_chunks add column embedding vector(1536);
--   create index on public.document_chunks
--     using hnsw (embedding vector_cosine_ops);
--
-- Dann Hybridabruf: Volltext-Rang und Vektorähnlichkeit kombiniert. Die
-- Signatur von search_vehicle_documents bleibt dabei unverändert, nur die
-- Implementierung wird ersetzt — deshalb steht die Suche überhaupt hinter
-- einer Funktion statt als Query in der Anwendung.
-- ═══════════════════════════════════════════════════════════════════════════
