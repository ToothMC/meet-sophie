# Missing RPCs — Recovery Runbook

**Status**: kritische Infrastruktur-Lücke. Vier RPCs werden vom Code aufgerufen,
existieren aber nur in Production — nicht in `supabase/migrations/`. Ein
Project-Fork, DB-Reset oder Setup einer Staging-Instanz würde Billing, Meetings
und Session-Locks sofort brechen.

Dieses Dokument ist ein **Schritt-für-Schritt-Runbook**, keine Diskussion.

---

## RPCs & Impact

| RPC | Call sites | Bei Fehlen bricht |
|---|---|---|
| `deduct_tokens(p_user_id uuid, p_amount int)` | [api/finalize-session.js:46](../api/finalize-session.js), [api/meeting.js:458,731,1525](../api/meeting.js), [api/user.js:86](../api/user.js), `meeting_billing_checkpoint`, `meeting_finalize_billing` | Jede Token-Abbuchung |
| `meeting_create_with_token_gate(...)` | [api/meeting.js:224](../api/meeting.js) | Meeting-Erstellung |
| `acquire_realtime_lock(p_user_id uuid, p_ttl_seconds int)` | [api/session.js:238](../api/session.js) | Voice-Session-Start |
| `reserve_free_seconds(p_seconds int, p_cap int)` | ~~[api/session.js:328]~~ **nicht mehr aufgerufen seit SG-4-Fix** | — (Cleanup-Kandidat) |

---

## Schritt 1 — Definitionen aus Production exportieren

**Im Supabase Dashboard** → Project `ohzfojsbmzinpxhcynpt` → **SQL Editor** → New query:

```sql
-- Exportiert alle vier RPCs als CREATE-Statements mit Trennern.
-- Output ist eine einzige Text-Spalte, die du direkt in eine Migration paste.
SELECT
  E'-- ─────────────────────────────────────────────\n' ||
  E'-- ' || n.nspname || '.' || p.proname || '\n' ||
  E'-- ─────────────────────────────────────────────\n' ||
  pg_get_functiondef(p.oid) || E';\n'
  AS definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'deduct_tokens',
    'meeting_create_with_token_gate',
    'acquire_realtime_lock',
    'reserve_free_seconds'
  )
ORDER BY p.proname;
```

Erwartet: vier Zeilen. Wenn weniger → Funktion fehlt auch in Production (red alert, billing bricht bereits).

**Output in Supabase**: Klick in erste Zelle → rechts „View cell" → copy raw. Für jede der vier Zeilen wiederholen und aneinanderreihen. Oder: SQL Editor → "Download CSV" und mit einem Editor zusammenkleben.

**Alternative über CLI** (falls Du `supabase` CLI + DB-Password hast):

```bash
SUPABASE_DB_URL='postgresql://postgres.ohzfojsbmzinpxhcynpt:PW@aws-0-eu-central-1.pooler.supabase.com:6543/postgres'

psql "$SUPABASE_DB_URL" -Atc "
  SELECT pg_get_functiondef(p.oid) || ';'
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public'
    AND p.proname IN ('deduct_tokens','meeting_create_with_token_gate','acquire_realtime_lock','reserve_free_seconds')
  ORDER BY p.proname;
" > /tmp/rpcs.sql
```

---

## Schritt 2 — Als Migration committen

Neues File anlegen — **Datum nach dem letzten bestehenden Eintrag**, damit die Reihenfolge stimmt:

```bash
# Aktueller letzter Stand:
ls supabase/migrations/ | sort | tail -3
# → 20260417_chat_notes_flag.sql
# → 20260419_billing_idempotency.sql
# → (das neue hier)

touch supabase/migrations/20260420_production_rpcs_recovered.sql
```

Inhalt der Datei (Template, Platzhalter durch Schritt-1-Output ersetzen):

```sql
-- Recovered from production on YYYY-MM-DD.
-- These RPCs were created manually via the Supabase SQL editor before
-- migrations were version-controlled. This file captures the authoritative
-- definitions so fresh projects / resets can rebuild them.
--
-- Source: `SELECT pg_get_functiondef(...)` against the prod DB
-- (see supabase/MISSING_RPCS.md for the export query).

BEGIN;

-- <PASTE deduct_tokens definition HERE, ending with ;>

-- <PASTE meeting_create_with_token_gate definition HERE>

-- <PASTE acquire_realtime_lock definition HERE>

-- <PASTE reserve_free_seconds definition HERE>
-- (Nicht mehr aufgerufen seit SG-4-Fix; einchecken für historische Vollständigkeit
-- oder gleich weglassen — dann in Schritt 4 auch in Prod droppen.)

COMMIT;
```

Wichtig: `pg_get_functiondef` liefert bereits `CREATE OR REPLACE FUNCTION` — idempotent. Die Migration kann mehrfach laufen ohne Bruch.

---

## Schritt 3 — Verifikation (bevor Du committest)

### 3a. Byte-Diff gegen Production

Führe in Supabase SQL Editor aus:

```sql
WITH current_defs AS (
  SELECT p.proname, pg_get_functiondef(p.oid) AS def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND p.proname IN (
    'deduct_tokens','meeting_create_with_token_gate',
    'acquire_realtime_lock','reserve_free_seconds'
  )
)
SELECT proname, length(def) AS chars, md5(def) AS hash FROM current_defs ORDER BY proname;
```

Speichere die vier MD5s. Wenn Du die Migration gleich anwendest, führe die Query nochmal aus — die Hashes müssen **identisch** bleiben. Wenn nicht: Du hast beim Copy-Paste Whitespace oder ein Semikolon verloren.

### 3b. Signatur-Check gegen den Call-Code

Jede RPC muss **exakt** die Argument-Namen und Typen haben, die der Node-Code erwartet. Quick-Check:

```bash
# Alle rpc()-Aufrufe mit Argument-Objekt auflisten
grep -rn "supabase\.rpc(" api/ lib/ | grep -E "deduct_tokens|meeting_create_with_token_gate|acquire_realtime_lock|reserve_free_seconds"
```

Abgleichen mit `SELECT proname, pg_get_function_arguments(oid) FROM pg_proc …`. Args müssen 1:1 matchen (Supabase mappt die JS-Object-Keys auf die SQL-Parameternamen).

### 3c. Staging-Smoke-Test

Falls Du eine Staging-DB hast:

```bash
supabase db push --db-url "$STAGING_DB_URL" --include-all
```

Danach: manuell im SQL Editor einen Call ausführen:

```sql
SELECT * FROM deduct_tokens('00000000-0000-0000-0000-000000000000'::uuid, 1);
-- Erwartet: Row (charged=0, remaining=0) ODER Fehler (nicht-existierender User) — nicht "function does not exist"
```

---

## Schritt 4 — Cleanup `reserve_free_seconds` (optional)

Seit dem SG-4-Fix ([api/session.js](../api/session.js)) wird `reserve_free_seconds` **nicht mehr aufgerufen**. Die Funktion in Production ist toter Code. Zwei Optionen:

**A) Recovered & behalten** (konservativ): Einfach in der neuen Migration mit-einchecken. Kein Impact.

**B) Droppen**: Anschließende Mini-Migration:

```sql
-- supabase/migrations/20260421_drop_reserve_free_seconds.sql
DROP FUNCTION IF EXISTS public.reserve_free_seconds(int, int);
-- (Argument-Liste exakt wie in Production — sonst NoOp)
```

Empfehlung: **erstmal B aufheben**, bis klar ist, dass der SG-4-Fix auch tatsächlich in Prod rolled. Erst dann droppen.

---

## Schritt 5 — Prävention (CI-Check)

Nach dem Recovery in `package.json` einbauen (oder als GitHub Action):

```bash
#!/usr/bin/env bash
# scripts/check-rpcs.sh
set -euo pipefail

CALLED=$(grep -rhoE 'supabase\.rpc\("([a-z_]+)"' api/ lib/ \
  | sed -E 's/.*rpc\("([^"]+)".*/\1/' | sort -u)

DEFINED=$(grep -rhoE 'CREATE (OR REPLACE )?FUNCTION [a-zA-Z_.]+' supabase/migrations/ \
  | sed -E 's/.*FUNCTION (public\.)?([a-zA-Z_]+).*/\2/' | sort -u)

MISSING=$(comm -23 <(echo "$CALLED") <(echo "$DEFINED"))

if [ -n "$MISSING" ]; then
  echo "❌ RPCs called by code but not defined in migrations:"
  echo "$MISSING"
  exit 1
fi
echo "✅ All called RPCs are defined in migrations."
```

Hook das entweder in `package.json` (`"scripts": { "check-rpcs": "bash scripts/check-rpcs.sh" }`) oder in Deinen Vercel Build Command (`vercel.json` → `buildCommand`). Vercel bricht dann ab wenn jemand wieder eine RPC im SQL Editor baut ohne sie einzuchecken.

---

## Warum das überhaupt passiert ist

Die Migration [20260406_hybrid_meeting_billing.sql](migrations/20260406_hybrid_meeting_billing.sql) ruft `deduct_tokens` auf, definiert sie aber nicht — die Funktion wurde manuell im Supabase SQL Editor erstellt und nie exportiert. Drei weitere folgten dem gleichen Muster. Der CI-Check aus Schritt 5 macht genau diese Lücke unmöglich.

---

## Nach erfolgreichem Recovery

1. `supabase/MISSING_RPCS.md` löschen (oder „Historisch" umbenennen).
2. Das Audit-Ticket SG-3 auf closed setzen.
3. Sicherstellen dass ein frisches Setup via `supabase db reset --linked` ohne Fehler durchläuft.
