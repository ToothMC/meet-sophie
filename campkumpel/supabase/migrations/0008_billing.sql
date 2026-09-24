-- ═══════════════════════════════════════════════════════════════════════════
-- 0008 — Abrechnung
--
-- Übernimmt Meet-Sophies Token-Wasserfall (frei → bezahlt → Aufladung) aus
-- lib/token-deduct.js, aber als DATENBANKFUNKTION statt als
-- Lese-Rechne-Schreibe-Folge in der Anwendung. Sophies JS-Variante hat
-- zwischen SELECT und UPDATE ein Zeitfenster; bei zwei parallelen Anfragen
-- desselben Nutzers kann ein Token doppelt ausgegeben werden. In einer
-- einzelnen UPDATE-Anweisung existiert das Fenster nicht.
--
-- Die Preise stehen bewusst NICHT hier, sondern in lib/billing-constants.js.
-- Sophie macht das genauso, und es ist richtig so: eine Preisänderung soll
-- ein Deploy sein, keine Migration.
--
-- B2B-Abrechnung (Organisation zahlt pro Fahrzeug statt pro Nutzer) ist als
-- Tabelle angelegt, aber im MVP ohne Implementierung — Flag billing_b2b.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ───────────────────────────────────────────────────────────────────────────
-- user_subscriptions
-- ───────────────────────────────────────────────────────────────────────────

create table public.user_subscriptions (
  user_id                uuid        primary key references auth.users(id) on delete cascade,
  plan                   text,
  status                 text        not null default 'none',
  is_active              boolean     not null default false,
  stripe_customer_id     text        unique,
  stripe_subscription_id text        unique,
  current_period_end     timestamptz,
  trial_end              timestamptz,
  cancel_at_period_end   boolean     not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint user_subscriptions_status_check
    check (status in ('none', 'trialing', 'active', 'past_due', 'canceled', 'incomplete'))
);

create trigger user_subscriptions_set_updated_at
  before update on public.user_subscriptions
  for each row execute function public.set_updated_at();

-- ───────────────────────────────────────────────────────────────────────────
-- user_usage — Token-Kontostand
-- ───────────────────────────────────────────────────────────────────────────

create table public.user_usage (
  user_id              uuid        primary key references auth.users(id) on delete cascade,
  free_tokens_total    int         not null default 0,
  free_tokens_used     int         not null default 0,
  paid_tokens_total    int         not null default 0,
  paid_tokens_used     int         not null default 0,
  topup_tokens_balance int         not null default 0,
  period_started_at    timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint user_usage_non_negative
    check (
      free_tokens_total    >= 0 and free_tokens_used  >= 0
      and paid_tokens_total >= 0 and paid_tokens_used >= 0
      and topup_tokens_balance >= 0
    ),

  -- Verbrauch kann das Kontingent nicht übersteigen. Ohne diese beiden
  -- Bedingungen bliebe ein Rechenfehler im Wasserfall unbemerkt, bis die
  -- Abrechnung nicht mehr aufgeht.
  constraint user_usage_free_within_total
    check (free_tokens_used <= free_tokens_total),
  constraint user_usage_paid_within_total
    check (paid_tokens_used <= paid_tokens_total)
);

create trigger user_usage_set_updated_at
  before update on public.user_usage
  for each row execute function public.set_updated_at();

-- ───────────────────────────────────────────────────────────────────────────
-- token_ledger — Nachweis jeder Buchung
--
-- Hat Sophie nicht. Ohne Journal lässt sich ein Abrechnungsstreit nicht
-- klären und ein Fehler im Wasserfall nicht nachrechnen; man sieht nur den
-- Endstand. Die Zeilen sind klein und fallen kaum ins Gewicht.
-- ───────────────────────────────────────────────────────────────────────────

create table public.token_ledger (
  id              bigint      generated always as identity primary key,
  user_id         uuid        not null references auth.users(id) on delete cascade,
  delta           int         not null,             -- negativ = Verbrauch
  reason          text        not null,
  conversation_id uuid        references public.conversations(id) on delete set null,
  balance_after   int         not null,
  idempotency_key text        unique,
  created_at      timestamptz not null default now()
);

create index token_ledger_user_idx on public.token_ledger (user_id, created_at desc);

-- ───────────────────────────────────────────────────────────────────────────
-- deduct_tokens — Wasserfall in einer Anweisung
--
-- Reihenfolge wie in Sophies lib/token-deduct.js: erst Freikontingent, dann
-- bezahltes Kontingent, dann Aufladung. Teilabbuchungen gibt es nicht — wenn
-- das Guthaben nicht reicht, wird gar nichts abgebucht und der Aufrufer
-- bekommt ok = false.
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.deduct_tokens(
  p_user_id         uuid,
  p_amount          int     default 1,
  p_reason          text    default 'chat_message',
  p_conversation_id uuid    default null,
  p_idempotency_key text    default null
)
returns table (ok boolean, remaining int, exhausted boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_free   int;
  v_paid   int;
  v_topup  int;
  v_total  int;
  v_amount int := greatest(0, coalesce(p_amount, 1));
  v_from_free  int;
  v_from_paid  int;
  v_from_topup int;
  v_remaining  int;
begin
  -- Wiederholte Zustellung desselben Aufrufs darf nicht doppelt abbuchen.
  if p_idempotency_key is not null
     and exists (select 1 from public.token_ledger where idempotency_key = p_idempotency_key) then
    select (u.free_tokens_total - u.free_tokens_used)
         + (u.paid_tokens_total - u.paid_tokens_used)
         + u.topup_tokens_balance
      into v_remaining
      from public.user_usage u
     where u.user_id = p_user_id;
    return query select true, coalesce(v_remaining, 0), coalesce(v_remaining, 0) <= 0;
    return;
  end if;

  insert into public.user_usage (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select u.free_tokens_total - u.free_tokens_used,
         u.paid_tokens_total - u.paid_tokens_used,
         u.topup_tokens_balance
    into v_free, v_paid, v_topup
    from public.user_usage u
   where u.user_id = p_user_id
     for update;

  v_total := greatest(0, v_free) + greatest(0, v_paid) + greatest(0, v_topup);

  if v_total < v_amount then
    return query select false, v_total, true;
    return;
  end if;

  v_from_free  := least(v_amount, greatest(0, v_free));
  v_from_paid  := least(v_amount - v_from_free, greatest(0, v_paid));
  v_from_topup := v_amount - v_from_free - v_from_paid;

  update public.user_usage
     set free_tokens_used     = free_tokens_used + v_from_free,
         paid_tokens_used     = paid_tokens_used + v_from_paid,
         topup_tokens_balance = topup_tokens_balance - v_from_topup,
         updated_at           = now()
   where user_id = p_user_id;

  v_remaining := v_total - v_amount;

  insert into public.token_ledger (user_id, delta, reason, conversation_id, balance_after, idempotency_key)
  values (p_user_id, -v_amount, p_reason, p_conversation_id, v_remaining, p_idempotency_key);

  return query select true, v_remaining, v_remaining <= 0;
end;
$$;

revoke execute on function public.deduct_tokens(uuid, int, text, uuid, text)
  from public, anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- organization_subscriptions — vorbereitet, im MVP ungenutzt
-- ───────────────────────────────────────────────────────────────────────────

create table public.organization_subscriptions (
  organization_id        uuid        primary key references public.organizations(id) on delete cascade,
  plan                   text,
  status                 text        not null default 'none',
  vehicle_quota          int         not null default 0,
  stripe_customer_id     text        unique,
  stripe_subscription_id text        unique,
  current_period_end     timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint organization_subscriptions_status_check
    check (status in ('none', 'trialing', 'active', 'past_due', 'canceled')),
  constraint organization_subscriptions_quota_check
    check (vehicle_quota >= 0)
);

create trigger organization_subscriptions_set_updated_at
  before update on public.organization_subscriptions
  for each row execute function public.set_updated_at();

-- ───────────────────────────────────────────────────────────────────────────
-- stripe_events — Idempotenz für Webhooks
--
-- Stripe stellt Ereignisse mehrfach zu. Ohne diese Tabelle wird bei jeder
-- Wiederholung erneut gutgeschrieben.
-- ───────────────────────────────────────────────────────────────────────────

create table public.stripe_events (
  event_id     text        primary key,
  event_type   text        not null,
  processed_at timestamptz not null default now(),
  payload      jsonb
);

-- ───────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ───────────────────────────────────────────────────────────────────────────

alter table public.user_subscriptions         enable row level security;
alter table public.user_usage                 enable row level security;
alter table public.token_ledger               enable row level security;
alter table public.organization_subscriptions enable row level security;
alter table public.stripe_events              enable row level security;

create policy "user_subscriptions_select_own"
  on public.user_subscriptions for select
  using (user_id = auth.uid());

create policy "user_usage_select_own"
  on public.user_usage for select
  using (user_id = auth.uid());

create policy "token_ledger_select_own"
  on public.token_ledger for select
  using (user_id = auth.uid());

create policy "organization_subscriptions_select_admin"
  on public.organization_subscriptions for select
  using (public.is_org_member(organization_id, 'admin'));

-- stripe_events: keine Policy. Ausschließlich Service-Role.
-- Alle Schreibvorgänge auf Abrechnungstabellen laufen serverseitig.

commit;
