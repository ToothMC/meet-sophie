-- Funktionsprüfung des Zugriffs- und Gedächtnismodells.
-- Szenario: Vermieter mit einem Fahrzeug, zwei aufeinanderfolgende Mieter.
-- Nicht Teil der Auslieferung — Validierungsskript.

\set ON_ERROR_STOP on
\pset pager off

-- Supabase vergibt diese Rechte über Default-Privileges; hier von Hand.
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- ── Aufbau (als Superuser, RLS umgangen) ──────────────────────────────────
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'admin@vermieter.de'),
  ('22222222-2222-2222-2222-222222222222', 'mieter-a@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'mieter-b@example.com');

insert into public.organizations (id, name, kind)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'Nordsee Wohnmobile', 'rental');

insert into public.organization_members (organization_id, user_id, role)
values ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'admin');

insert into public.vehicles (id, owner_type, owner_organization_id, nickname, make, model)
values ('bbbbbbbb-0000-0000-0000-000000000001', 'organization',
        'aaaaaaaa-0000-0000-0000-000000000001', 'Nordwind', 'Hymer', 'B-Klasse');

update public.vehicle_profiles
   set height_total_mm = 3150, mass_max_kg = 3500, fresh_water_l = 140
 where vehicle_id = 'bbbbbbbb-0000-0000-0000-000000000001';

insert into public.rentals (id, organization_id, vehicle_id, renter_user_id, starts_at, ends_at)
values ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
        now() - interval '1 day', now() + interval '6 days');

\echo ''
\echo '--- 1. Vor der Übergabe hat Mieter A keinen Zugriff'
set role authenticated;
set test.uid = '22222222-2222-2222-2222-222222222222';
select count(*) as sichtbare_fahrzeuge from public.vehicles;
reset role;

\echo ''
\echo '--- 2. Übergabe: rental_grant_access'
select public.rental_grant_access('cccccccc-0000-0000-0000-000000000001') is not null as zugriff_erteilt;

set role authenticated;
set test.uid = '22222222-2222-2222-2222-222222222222';
select nickname, (select height_total_mm from public.vehicle_profiles p where p.vehicle_id = v.id) as hoehe_mm
  from public.vehicles v;
\echo 'Mieter A darf das Profil NICHT ändern (driver, nicht manager):'
update public.vehicle_profiles set mass_max_kg = 9999
 where vehicle_id = 'bbbbbbbb-0000-0000-0000-000000000001';
reset role;

\echo ''
\echo '--- 3. Mieter A trägt Wissen bei: geteilt + privat'
insert into public.vehicle_memory (vehicle_id, author_user_id, kind, key, value, visibility)
values ('bbbbbbbb-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
        'quirk', 'heizung_anlaufzeit', 'Heizung braucht zwei Minuten bis sie anspringt', 'vehicle'),
       ('bbbbbbbb-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
        'tip', 'privater_hinweis', 'Streit mit Anke über die Route', 'author_only');

insert into public.user_memory (user_id, kind, key, value)
values ('22222222-2222-2222-2222-222222222222', 'preference', 'etappenlaenge', 'maximal 250 km pro Tag');

insert into public.conversations (id, user_id, vehicle_id)
values ('dddddddd-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
        'bbbbbbbb-0000-0000-0000-000000000001');
select public.insert_conversation_message(
  'dddddddd-0000-0000-0000-000000000001', 'user', 'Passe ich unter die Brücke?') is not null as nachricht_ok;

\echo ''
\echo '--- 4. Der Vermieter-Admin sieht das geteilte Wissen, nicht das private'
set role authenticated;
set test.uid = '11111111-1111-1111-1111-111111111111';
select key, visibility from public.vehicle_memory order by key;
\echo 'Gespräche des Mieters für den Vermieter:'
select count(*) as sichtbare_gespraeche from public.conversations;
reset role;

\echo ''
\echo '--- 5. Rückgabe: rental_revoke_access'
select public.rental_revoke_access('cccccccc-0000-0000-0000-000000000001') as entzogene_zugriffe;

set role authenticated;
set test.uid = '22222222-2222-2222-2222-222222222222';
select count(*) as fahrzeuge_nach_rueckgabe from public.vehicles;
\echo 'Eigenes Reisewissen bleibt:'
select key, value from public.user_memory;
\echo 'Eigenes Gespräch bleibt lesbar:'
select count(*) as eigene_gespraeche from public.conversations;
reset role;

\echo ''
\echo '--- 6. Mieter B übernimmt dasselbe Fahrzeug'
insert into public.rentals (id, organization_id, vehicle_id, renter_user_id, starts_at, ends_at)
values ('cccccccc-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333',
        now(), now() + interval '7 days');
select public.rental_grant_access('cccccccc-0000-0000-0000-000000000002') is not null as zugriff_b;

set role authenticated;
set test.uid = '33333333-3333-3333-3333-333333333333';
\echo 'B erbt das Fahrzeugwissen von A, aber nicht dessen Privates:'
select key, visibility from public.vehicle_memory order by key;
\echo 'B sieht nur die eigene Vermietung, nicht die von A:'
select count(*) filter (where renter_user_id = '33333333-3333-3333-3333-333333333333') as eigene,
       count(*) filter (where renter_user_id <> '33333333-3333-3333-3333-333333333333') as fremde
  from public.rentals;
\echo 'B sieht die Gespräche von A nicht:'
select count(*) as sichtbare_gespraeche from public.conversations;
reset role;

\echo ''
\echo '--- 7. Ablauf ohne Rückgabe-Event (Sicherheitsnetz)'
update public.vehicle_access
   set valid_from  = now() - interval '2 days',
       valid_until = now() - interval '1 hour'
 where rental_id = 'cccccccc-0000-0000-0000-000000000002';
set role authenticated;
set test.uid = '33333333-3333-3333-3333-333333333333';
select count(*) as fahrzeuge_nach_ablauf from public.vehicles;
reset role;
select public.expire_vehicle_access() as hart_widerrufen;

\echo ''
\echo '--- 8. Token-Wasserfall'
insert into public.user_usage (user_id, free_tokens_total, paid_tokens_total, topup_tokens_balance)
values ('22222222-2222-2222-2222-222222222222', 2, 3, 5);
\echo 'Abbuchung 4 (2 frei + 2 bezahlt):'
select * from public.deduct_tokens('22222222-2222-2222-2222-222222222222', 4, 'chat_message');
select free_tokens_used, paid_tokens_used, topup_tokens_balance from public.user_usage
 where user_id = '22222222-2222-2222-2222-222222222222';
\echo 'Idempotenz: derselbe Schlüssel zweimal:'
select * from public.deduct_tokens('22222222-2222-2222-2222-222222222222', 2, 'chat_message', null, 'key-1');
select * from public.deduct_tokens('22222222-2222-2222-2222-222222222222', 2, 'chat_message', null, 'key-1');
\echo 'Guthaben nach beiden Aufrufen (nur einmal abgebucht):'
select free_tokens_used, paid_tokens_used, topup_tokens_balance from public.user_usage
 where user_id = '22222222-2222-2222-2222-222222222222';
\echo 'Mehr abbuchen als vorhanden:'
select * from public.deduct_tokens('22222222-2222-2222-2222-222222222222', 99, 'chat_message');

\echo ''
\echo '--- 9. Dokumentensuche'
insert into public.vehicle_documents (id, vehicle_id, doc_type, title, storage_path, status)
values ('eeeeeeee-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
        'manual', 'Bedienungsanleitung Hymer B-Klasse',
        'bbbbbbbb-0000-0000-0000-000000000001/eeeeeeee.pdf', 'parsed');
insert into public.document_chunks (document_id, vehicle_id, chunk_index, heading, content, page_from)
values ('eeeeeeee-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 0,
        'Frischwassertank', 'Der Frischwassertank fasst 140 Liter und wird über den Einfüllstutzen an der linken Fahrzeugseite befüllt.', 42),
       ('eeeeeeee-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 1,
        'Aufbaubatterie', 'Die Aufbaubatterie wird über die Lichtmaschine und optional über Solarmodule geladen.', 57);
\echo 'Der Trigger korrigiert die absichtlich falsch gesetzte vehicle_id:'
select chunk_index, vehicle_id = 'bbbbbbbb-0000-0000-0000-000000000001' as vehicle_id_korrekt
  from public.document_chunks order by chunk_index;
\echo 'Natuerlichsprachige Frage (scheitert an reiner UND-Semantik):'
select heading, page_from, exact from public.search_vehicle_documents(
  'bbbbbbbb-0000-0000-0000-000000000001', 'Wie fuelle ich den Frischwassertank?');
\echo 'Exakte Begriffe -> exact = true:'
select heading, page_from, exact from public.search_vehicle_documents(
  'bbbbbbbb-0000-0000-0000-000000000001', 'Frischwassertank Liter');
\echo 'Anderes Thema trifft den richtigen Absatz:'
select heading, page_from, exact from public.search_vehicle_documents(
  'bbbbbbbb-0000-0000-0000-000000000001', 'Wird die Aufbaubatterie ueber Solar geladen?');
\echo 'Ohne Treffer bleibt es leer:'
select count(*) as treffer from public.search_vehicle_documents(
  'bbbbbbbb-0000-0000-0000-000000000001', 'Motorrad Anhaengerkupplung Hafen');
\echo 'Leere Abfrage wirft nicht:'
select count(*) as treffer from public.search_vehicle_documents(
  'bbbbbbbb-0000-0000-0000-000000000001', '   ');

\echo ''
\echo '--- 10. Constraints greifen (jede Zeile MUSS scheitern)'
\set ON_ERROR_STOP off
\echo 'Fahrzeug mit zwei Eigentümern:'
insert into public.vehicles (owner_type, owner_user_id, owner_organization_id)
values ('user', '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000001');
\echo 'Gesamthöhe kleiner als Höhe:'
update public.vehicle_profiles set height_mm = 3000, height_total_mm = 2800
 where vehicle_id = 'bbbbbbbb-0000-0000-0000-000000000001';
\echo 'Einheitenfehler (Meter statt Millimeter):'
update public.vehicle_profiles set length_mm = 7
 where vehicle_id = 'bbbbbbbb-0000-0000-0000-000000000001';
\echo 'Verbrauch über Kontingent:'
update public.user_usage set free_tokens_used = 999
 where user_id = '22222222-2222-2222-2222-222222222222';
\echo 'Zwei aktive Reisen für denselben Nutzer:'
insert into public.trips (user_id, status) values ('22222222-2222-2222-2222-222222222222', 'active');
insert into public.trips (user_id, status) values ('22222222-2222-2222-2222-222222222222', 'active');
