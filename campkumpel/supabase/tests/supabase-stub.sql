-- Minimaler Supabase-Nachbau, nur zur Validierung der Migrationen.
-- Nicht Teil der Auslieferung.

-- Rollen sind clusterweit, deshalb idempotent anlegen.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon nologin;          end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')  then create role service_role nologin;  end if;
end $$;

create schema if not exists auth;

create table auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);

-- auth.uid() liest in Supabase aus dem JWT-Claim. Hier aus einer GUC,
-- damit die Tests eine Identität setzen können.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('test.uid', true), '')::uuid;
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth   to anon, authenticated, service_role;
