-- =========================================================
-- Test-User Seed Script
-- E-Mail: sophie@meet-sophie.ai
-- Sprechzeit: 30 Minuten (1800 Sekunden) als topup_seconds_balance
--
-- VORBEDINGUNG:
--   User muss zuerst manuell im Supabase Auth Dashboard angelegt werden:
--   Authentication → Users → Add User
--   E-Mail: sophie@meet-sophie.ai
--   Passwort: (beliebig setzen)
--   "Auto Confirm User" aktivieren (kein Mailversand nötig)
--
-- Danach dieses Script im Supabase SQL Editor ausführen.
-- =========================================================

do $$
declare
  v_user_id uuid;
begin

  -- User-ID aus Auth-Tabelle holen
  select id into v_user_id
  from auth.users
  where email = 'sophie@meet-sophie.ai'
  limit 1;

  if v_user_id is null then
    raise exception 'User sophie@meet-sophie.ai nicht gefunden. Bitte zuerst im Auth Dashboard anlegen.';
  end if;

  raise notice 'User gefunden: %', v_user_id;

  -- -------------------------------------------------------
  -- user_profile: vorbefülltes Profil (Onboarding übersprungen)
  -- -------------------------------------------------------
  insert into public.user_profile (
    user_id,
    first_name,
    preferred_name,
    preferred_addressing,
    preferred_pronoun,
    preferred_language,
    age,
    relationship_status,
    occupation,
    conversation_style,
    topics_like,
    topics_avoid,
    notes,
    onboarding_completed
  ) values (
    v_user_id,
    'Sophie',                        -- Vorname (Tester kann sich vorstellen als "Sophie")
    'Sophie',
    'du',                            -- Duzform
    'she/her',
    'de',                            -- Deutsch
    30,
    'single',
    'Product Tester',
    'warm, neugierig, direkt',
    array['Produktivität', 'Wohlbefinden', 'Kreativität'],
    array[]::text[],
    'Dies ist ein Test-Account. Sophie ist eine fiktive Testerin für meet-sophie.ai.',
    true                             -- Onboarding als abgeschlossen markiert
  )
  on conflict (user_id) do update set
    first_name          = excluded.first_name,
    preferred_name      = excluded.preferred_name,
    preferred_addressing = excluded.preferred_addressing,
    preferred_pronoun   = excluded.preferred_pronoun,
    preferred_language  = excluded.preferred_language,
    age                 = excluded.age,
    relationship_status = excluded.relationship_status,
    occupation          = excluded.occupation,
    conversation_style  = excluded.conversation_style,
    topics_like         = excluded.topics_like,
    topics_avoid        = excluded.topics_avoid,
    notes               = excluded.notes,
    onboarding_completed = excluded.onboarding_completed;

  -- -------------------------------------------------------
  -- user_relationship: vorbefüllte "Beziehungs-History"
  -- damit Sophie nicht als kompletter Neuzugang startet
  -- -------------------------------------------------------
  insert into public.user_relationship (
    user_id,
    tone_baseline,
    openness_level,
    emotional_patterns,
    last_interaction_summary
  ) values (
    v_user_id,
    'warm und offen',
    'hoch',
    'neugierig, reflektiert, manchmal ungeduldig wenn Technik nicht klappt',
    'Sophie hat meet-sophie.ai zum ersten Mal ausprobiert und ist gespannt wie das Gespräch läuft. Sie ist offen für tiefere Themen, möchte aber erstmal ein Gefühl für die App bekommen.'
  )
  on conflict (user_id) do update set
    tone_baseline           = excluded.tone_baseline,
    openness_level          = excluded.openness_level,
    emotional_patterns      = excluded.emotional_patterns,
    last_interaction_summary = excluded.last_interaction_summary;

  -- -------------------------------------------------------
  -- user_subscriptions: Plus-Plan aktiv (Best Friend Mode)
  -- -------------------------------------------------------
  insert into public.user_subscriptions (
    user_id,
    stripe_customer_id,
    stripe_subscription_id,
    status,
    is_active,
    plan,
    current_period_end
  ) values (
    v_user_id,
    'cus_test_sophie',               -- Platzhalter, kein echter Stripe-Customer
    'sub_test_sophie',               -- Platzhalter
    'active',
    true,
    'plus',                          -- Plus = Best Friend Mode (bis zu 3 Sessions)
    now() + interval '90 days'       -- 90 Tage gültig
  )
  on conflict (user_id) do update set
    status             = excluded.status,
    is_active          = excluded.is_active,
    plan               = excluded.plan,
    current_period_end = excluded.current_period_end;

  -- -------------------------------------------------------
  -- user_usage: 30 Minuten Sprechzeit (1800 Sekunden)
  -- Vergabe über topup_seconds_balance → keine Abo-Logik nötig
  -- -------------------------------------------------------
  insert into public.user_usage (
    user_id,
    free_seconds_total,
    free_seconds_used,
    paid_seconds_total,
    paid_seconds_used,
    topup_seconds_balance
  ) values (
    v_user_id,
    120,                             -- Standard Free-Kontingent (bereits "verbraucht")
    120,                             -- → freetime abgelaufen, Tester nutzt topup
    0,
    0,
    1800                             -- 30 Minuten als Topup-Guthaben
  )
  on conflict (user_id) do update set
    free_seconds_used     = 120,     -- Free-Zeit als verbraucht markieren
    topup_seconds_balance = 1800;    -- 30 Minuten setzen (überschreibt bestehenden Wert)

  raise notice '✓ Test-User vollständig angelegt: sophie@meet-sophie.ai (30 min Sprechzeit)';

end $$;
