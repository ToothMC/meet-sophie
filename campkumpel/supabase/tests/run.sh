#!/usr/bin/env bash
# Wendet alle Migrationen auf eine frische Postgres-Datenbank an und fährt
# das Zugriffsszenario. Prüft, was Lesen allein nicht prüfen kann: ob die
# RLS-Policies die Trennung zwischen Mieter, Vermieter und Folgemieter
# tatsächlich herstellen.
#
# Aufruf:
#   campkumpel/supabase/tests/run.sh                       # lokaler Cluster auf :5433
#   PGPORT=5432 PGHOST=/var/run/postgresql tests/run.sh    # anderer Cluster
#
# Braucht KEIN Supabase: supabase-stub.sql baut auth.users und auth.uid()
# minimal nach. Der Stub ist nur für den Test da und wird nie ausgeliefert.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS="$HERE/../migrations"

export PGHOST="${PGHOST:-/var/run/postgresql}"
export PGPORT="${PGPORT:-5433}"
export PGUSER="${PGUSER:-postgres}"
DB="${PGDATABASE_TEST:-campkumpel_test}"

echo "→ Datenbank $DB neu anlegen"
psql -d postgres -q -c "drop database if exists $DB"
psql -d postgres -q -c "create database $DB"

echo "→ Supabase-Stub"
psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$HERE/supabase-stub.sql"

for f in "$MIGRATIONS"/[0-9][0-9][0-9][0-9]_*.sql; do
  echo "→ $(basename "$f")"
  psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$f"
done

echo "→ Szenario"
psql -d "$DB" -q -f "$HERE/rls-scenario.sql"

cat <<'EOF'

Erwartetes Ergebnis — jede Zeile ist eine Zusage des Datenmodells:

  1  vor der Übergabe sieht der Mieter 0 Fahrzeuge
  2  nach der Übergabe sieht er Fahrzeug und Profil, darf das Profil aber
     nicht ändern (driver, nicht manager)
  4  der Vermieter sieht NUR das geteilte Fahrzeugwissen und 0 Gespräche
  5  nach der Rückgabe: 0 Fahrzeuge, aber Reiseprofil und eigene Gespräche
     bleiben beim Mieter
  6  der Folgemieter erbt das geteilte Wissen, sieht aber weder das private
     Wissen noch die Vermietung noch die Gespräche des Vorgängers
  7  abgelaufener Zugriff greift auch ohne Rückgabe-Event nicht mehr
  8  Token-Wasserfall frei → bezahlt → Aufladung, Idempotenz hält,
     Überziehung wird abgelehnt
  9  Dokumentensuche findet den Absatz auch bei natürlichsprachiger Frage
 10  jede der fünf Zeilen MUSS mit ERROR scheitern

EOF
