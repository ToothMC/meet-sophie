# CampKumpel — Fundament

Dieses Verzeichnis enthält das **technische Fundament für CampKumpel**, erarbeitet
auf Basis der Meet-Sophie-Codebasis. Es ist bewusst als **abtrennbares Paket**
angelegt: der Inhalt wird später 1:1 in das eigenständige CampKumpel-Repository
gehoben, ohne dass Meet-Sophie verändert werden muss.

CampKumpel ist ein personalisierter KI-Begleiter für Wohnmobilreisende. Er kennt
**das konkrete Fahrzeug** und **die konkreten Reisegewohnheiten** — nicht
Wohnmobile im Allgemeinen.

## Inhalt

| Pfad | Inhalt |
|---|---|
| [`docs/01-architektur-audit.md`](docs/01-architektur-audit.md) | Audit der Meet-Sophie-Architektur: was übernommen wird, was nicht, und warum |
| [`docs/02-datenmodell.md`](docs/02-datenmodell.md) | CampKumpel-Datenmodell, Entscheidungen, Zugriffsmodell, Memory-Trennung |
| [`docs/03-repo-struktur.md`](docs/03-repo-struktur.md) | Zielstruktur des neuen Repos + Umzugsplan aus Meet-Sophie |
| [`docs/04-feature-flags.md`](docs/04-feature-flags.md) | Flag-Registry: was im MVP an ist, was vorbereitet aber aus ist |
| [`supabase/migrations/`](supabase/migrations/) | Acht Migrationen, die das komplette Schema aufbauen |
| [`lib/feature-flags.js`](lib/feature-flags.js) | Flag-Auflösung (Default → Env → Org → User) |
| [`tests/`](tests/) | Smoke-Tests für die Flag-Auflösung |

## Reihenfolge der Migrationen

Die Migrationen bauen aufeinander auf und müssen in dieser Reihenfolge laufen:

```
0001_foundation.sql          profiles, organizations, organization_members, Helper
0002_vehicles.sql            vehicles, vehicle_profiles, vehicle_access, Zugriffs-Helper
0003_trips_and_rentals.sql   trips, rentals, Lifecycle-RPCs für Mietzugriff
0004_conversations.sql       conversations, conversation_messages, conversation_outputs
0005_memory.sql              user_travel_profile, user_memory, vehicle_memory, trip_memory
0006_documents.sql           vehicle_documents, document_chunks, Volltextsuche
0007_analytics_feedback.sql  analytics_events, message_feedback
0008_billing.sql             user_subscriptions, user_usage, deduct_tokens
```

Anwenden in einem frischen Supabase-Projekt:

```bash
supabase db reset          # lokal
# oder pro Datei:
psql "$SUPABASE_DB_URL" -f campkumpel/supabase/migrations/0001_foundation.sql
```

## Zwei Prinzipien, die alles andere bestimmen

**1. Fahrzeuge gehören niemals fest zu Nutzern.**
Zugriff läuft ausschließlich über `vehicle_access` — auch beim Privatbesitzer.
Dadurch sind B2C (eigenes Fahrzeug) und B2B2C (Mietfahrzeug) derselbe Codepfad,
nur mit anderem `source` und anderem Gültigkeitszeitraum. Ein Vermieter-Pilot
braucht später keine Schema-Migration, nur ein Feature-Flag.

**2. Wissen wird nach Lebensdauer getrennt, nicht nach Herkunft.**
Fahrzeugwissen bleibt beim Fahrzeug, Nutzerpräferenzen bleiben beim Nutzer,
Reisekontext verfällt mit der Reise. Wenn eine Miete endet, verliert der Mieter
den Fahrzeugzugriff, behält aber sein Reiseprofil — und der Vermieter sieht
niemals dessen persönliche Daten.

Details und Begründung in [`docs/02-datenmodell.md`](docs/02-datenmodell.md).

## Status

Fundament und Schema sind fertig entworfen. **Noch nicht erfolgt:** Anlage des
eigenständigen GitHub-Repositories und der Umzug des Codes (siehe
[`docs/03-repo-struktur.md`](docs/03-repo-struktur.md), Abschnitt „Umzugsplan").
