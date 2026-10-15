-- =========================================================
-- Cross-Mode Knowledge — ein gemeinsames Gedaechtnis fuer
-- Talk, Chat, Brainstorm, Sales Pitch und Meeting.
--
-- +Intelligence (xi) ist bewusst ausgeschlossen (Check-Constraint
-- auf source_mode) — xi speichert nichts und liest nichts.
--
-- Schreiben ausschliesslich ueber Service-Role (API). Clients duerfen
-- nur eigene Zeilen lesen (RLS). RPCs nur fuer service_role.
-- =========================================================

create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------
-- Items
-- ---------------------------------------------------------
create table if not exists public.sophie_knowledge_items (
  id                 uuid        primary key default gen_random_uuid(),
  user_id            uuid        not null references auth.users(id) on delete cascade,
  source_mode        text        not null check (source_mode in ('talk','chat','brainstorm','sales_pitch','meeting')),
  kind               text        not null check (kind in ('task','decision','fact','idea','open_question','pitch_feedback','session_recap')),
  -- binding = beschlossen/zugesagt, stated = vom User als Tatsache gesagt, tentative = Vorschlag/Idee/Option
  authority          text        not null default 'stated' check (authority in ('binding','stated','tentative')),
  text               text        not null check (char_length(text) between 1 and 4000),
  topic              text,
  detail             jsonb       not null default '{}'::jsonb,
  entity_refs        text[]      not null default '{}',
  status             text        not null default 'open' check (status in ('open','done','dropped','superseded')),
  -- AI-Vermutung, wird NIE automatisch angewendet (nur Nachfrage im Gespraech)
  suggested_status   text        check (suggested_status in ('done','dropped')),
  suggested_reason   text,
  superseded_by_id   uuid        references public.sophie_knowledge_items(id) on delete set null,
  related_item_id    uuid        references public.sophie_knowledge_items(id) on delete set null,
  valid_until        timestamptz,
  confidence         real        check (confidence is null or (confidence >= 0 and confidence <= 1)),
  source_ref         jsonb       not null default '{}'::jsonb,
  -- Idempotenz: z.B. meeting_summary:<id>:decision:<n>, pitch:<id>, recap:<session_id>
  idem_key           text        not null,
  embedding          extensions.vector(1536),
  search_tsv         tsvector    generated always as (
                       to_tsvector('simple', coalesce(topic, '') || ' ' || text)
                     ) stored,
  status_changed_at  timestamptz,
  last_referenced_at timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (user_id, idem_key)
);

create index if not exists sophie_knowledge_items_user_status_kind_idx
  on public.sophie_knowledge_items (user_id, status, kind);
create index if not exists sophie_knowledge_items_user_created_idx
  on public.sophie_knowledge_items (user_id, created_at desc);
create index if not exists sophie_knowledge_items_tsv_idx
  on public.sophie_knowledge_items using gin (search_tsv);
create index if not exists sophie_knowledge_items_entities_idx
  on public.sophie_knowledge_items using gin (entity_refs);
-- Bewusst KEIN HNSW: pro User wenige hundert Items -> exakte Suche nach
-- user_id-Filter ist schnell und hat kein Filter-Recall-Problem.

-- ---------------------------------------------------------
-- Sources (Item <-> Session). Steuert das Loeschen.
-- ---------------------------------------------------------
create table if not exists public.sophie_knowledge_sources (
  item_id    uuid        not null references public.sophie_knowledge_items(id) on delete cascade,
  session_id uuid        not null references public.user_sessions(id) on delete cascade,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (item_id, session_id)
);
create index if not exists sophie_knowledge_sources_session_idx
  on public.sophie_knowledge_sources (session_id);

-- Item verschwindet, sobald seine letzte Quell-Session geloescht ist.
create or replace function public.sophie_knowledge_drop_orphans()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.sophie_knowledge_items i
   where i.id = old.item_id
     and not exists (select 1 from public.sophie_knowledge_sources s where s.item_id = old.item_id);
  return null;
end;
$$;

drop trigger if exists sophie_knowledge_sources_orphan on public.sophie_knowledge_sources;
create trigger sophie_knowledge_sources_orphan
  after delete on public.sophie_knowledge_sources
  for each row execute function public.sophie_knowledge_drop_orphans();

-- ---------------------------------------------------------
-- Events (Audit + Undo)
-- ---------------------------------------------------------
create table if not exists public.sophie_knowledge_events (
  id         uuid        primary key default gen_random_uuid(),
  item_id    uuid        not null references public.sophie_knowledge_items(id) on delete cascade,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  event      text        not null check (event in ('created','merged','superseded','status_changed','suggested','reverted')),
  old        jsonb,
  new        jsonb,
  actor      text        not null check (actor in ('user_confirmed','ai_extraction','backfill')),
  evidence   text,
  session_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists sophie_knowledge_events_item_idx
  on public.sophie_knowledge_events (item_id, created_at desc);

-- ---------------------------------------------------------
-- RLS: nur eigene Zeilen lesen, Schreiben nur Service-Role
-- ---------------------------------------------------------
alter table public.sophie_knowledge_items   enable row level security;
alter table public.sophie_knowledge_sources enable row level security;
alter table public.sophie_knowledge_events  enable row level security;

drop policy if exists "own knowledge items" on public.sophie_knowledge_items;
create policy "own knowledge items" on public.sophie_knowledge_items
  for select using (auth.uid() = user_id);
drop policy if exists "own knowledge sources" on public.sophie_knowledge_sources;
create policy "own knowledge sources" on public.sophie_knowledge_sources
  for select using (auth.uid() = user_id);
drop policy if exists "own knowledge events" on public.sophie_knowledge_events;
create policy "own knowledge events" on public.sophie_knowledge_events
  for select using (auth.uid() = user_id);

-- ---------------------------------------------------------
-- RPC: aehnlichste bestehende Items (Validierung beim Schreiben)
-- ---------------------------------------------------------
create or replace function public.match_knowledge(
  p_user_id   uuid,
  p_embedding extensions.vector(1536),
  p_limit     int default 5
)
returns table (
  id uuid, source_mode text, kind text, authority text, status text,
  text text, topic text, created_at timestamptz, similarity double precision
)
language sql
stable
set search_path = public, extensions
as $$
  select k.id, k.source_mode, k.kind, k.authority, k.status, k.text, k.topic, k.created_at,
         1 - (k.embedding <=> p_embedding) as similarity
    from public.sophie_knowledge_items k
   where k.user_id = p_user_id
     and k.embedding is not null
     and k.kind <> 'session_recap'
     and k.status in ('open','done')
   order by k.embedding <=> p_embedding
   limit greatest(1, least(p_limit, 20));
$$;

-- ---------------------------------------------------------
-- RPC: Hybrid-Recall (Filter + Volltext + Vektor, RRF, Re-Ranking)
-- ---------------------------------------------------------
create or replace function public.recall_knowledge(
  p_user_id         uuid,
  p_query           text,
  p_embedding       extensions.vector(1536) default null,
  p_modes           text[] default null,
  p_since           timestamptz default null,
  p_until           timestamptz default null,
  p_entity          text default null,
  p_include_history boolean default false,
  p_limit           int default 8
)
returns table (
  id uuid, source_mode text, kind text, authority text, status text,
  text text, topic text, entity_refs text[], detail jsonb,
  created_at timestamptz, score double precision
)
language sql
stable
set search_path = public, extensions
as $$
  with base as (
    select k.*
      from public.sophie_knowledge_items k
     where k.user_id = p_user_id
       and (p_modes is null or k.source_mode = any (p_modes))
       and (p_since is null or k.created_at >= p_since)
       and (p_until is null or k.created_at <= p_until)
       and (p_entity is null or exists (
             select 1 from unnest(k.entity_refs) e where e ilike '%' || p_entity || '%'))
       and (p_include_history or k.status in ('open','done'))
  ),
  vec as (
    select b.id, row_number() over (order by b.embedding <=> p_embedding) as r
      from base b
     where p_embedding is not null and b.embedding is not null
     order by b.embedding <=> p_embedding
     limit 30
  ),
  q as (select websearch_to_tsquery('simple', coalesce(p_query, '')) as tsq),
  fts as (
    select b.id, row_number() over (order by ts_rank(b.search_tsv, q.tsq) desc) as r
      from base b, q
     where b.search_tsv @@ q.tsq
     order by ts_rank(b.search_tsv, q.tsq) desc
     limit 30
  ),
  fused as (
    select u.id, sum(1.0 / (60 + u.r)) as rrf
      from (select * from vec union all select * from fts) u
     group by u.id
  )
  select b.id, b.source_mode, b.kind, b.authority, b.status, b.text, b.topic,
         b.entity_refs, b.detail, b.created_at,
         (f.rrf
           * case b.authority when 'binding' then 1.3 when 'stated' then 1.1 else 1.0 end
           * case when b.status in ('superseded','dropped') then 0.5 else 1.0 end
           * (1.0 / (1.0 + extract(epoch from (now() - b.created_at)) / (86400.0 * 90)))
         )::double precision as score
    from fused f
    join base b on b.id = f.id
   order by score desc
   limit greatest(1, least(p_limit, 20));
$$;

revoke all on function public.match_knowledge(uuid, extensions.vector, int) from public, anon, authenticated;
revoke all on function public.recall_knowledge(uuid, text, extensions.vector, text[], timestamptz, timestamptz, text, boolean, int) from public, anon, authenticated;
revoke all on function public.sophie_knowledge_drop_orphans() from public, anon, authenticated;
grant execute on function public.match_knowledge(uuid, extensions.vector, int) to service_role;
grant execute on function public.recall_knowledge(uuid, text, extensions.vector, text[], timestamptz, timestamptz, text, boolean, int) to service_role;
