# 03 — Repo-Struktur und Umzugsplan

## Zielstruktur

Drei Ebenen, nach Abhängigkeitsrichtung getrennt. `features/` darf `campkumpel/`
benutzen, `campkumpel/` darf `core/` benutzen, `core/` kennt keines von beiden.

```
campkumpel/
├─ api/                          Vercel Serverless Functions (HTTP-Ebene)
│  ├─ chat.js                      Gesprächsendpunkt (SSE-Streaming)
│  ├─ vehicles.js                  CRUD Fahrzeug + Profil
│  ├─ vehicle-documents.js         Upload, Parsing-Anstoß, Signed URLs
│  ├─ trips.js
│  ├─ memory-update.js             Nachbearbeitung nach Gesprächsende
│  ├─ feedback.js
│  ├─ user.js                      Profil, Reiseprofil, Kontolöschung
│  ├─ track.js                     analytics_events
│  ├─ billing.js, stripe-webhook.js
│  ├─ cron/
│  │  ├─ expire-access.js          → expire_vehicle_access()
│  │  └─ cleanup-memory.js         → cleanup_expired_memory()
│  └─ ai/
│     ├─ router.js, tools.js, health.js
│     └─ transcribe.js, tts.js     (Flag: voice)
│
├─ core/                         Fachlogik ohne CampKumpel-Bezug
│  ├─ auth/                        OTP-Flow, Session-Guards
│  ├─ organizations/               Mitgliedschaft, Rollenprüfung
│  ├─ vehicles/                    Zugriffsmodell, has_vehicle_access-Wrapper
│  ├─ conversations/               Session-Lebenszyklus, Persistenz
│  ├─ memory/                      Ebenen, TTL, Verdichtung
│  ├─ documents/                   Parser, Chunking, Storage, Retrieval
│  ├─ ai/                          Adapter, Router, Classifier, Normalizer
│  └─ billing/                     Token-Wasserfall, Stripe
│
├─ campkumpel/                   Was das Produkt ausmacht
│  ├─ vehicle-profile/             Feldlogik, Vollständigkeit, Plausibilität
│  ├─ travel-profile/              Reisepräferenzen
│  ├─ personalization/             Prompt-Aufbau aus Fahrzeug + Reise + Wissen
│  ├─ documents/                   Wohnmobilspezifisches Chunking und Zitieren
│  └─ rental-context/              Mietlebenszyklus (Flag: rental_context)
│
├─ features/                     Alles hinter einem Flag
│  ├─ voice/
│  ├─ trip-planner/
│  ├─ fleet-dashboard/
│  └─ maintenance/
│
├─ lib/
│  ├─ feature-flags.js             Registry und Auflösung
│  ├─ billing-constants.js         Preise, Token-Kosten
│  └─ supabase.js                  Client-Erzeugung (anon + service role)
│
├─ app/                          Frontend
├─ supabase/
│  ├─ migrations/                  0001 … 0008
│  └─ tests/                       run.sh, rls-scenario.sql, supabase-stub.sql
├─ scripts/                      check-syntax, check-rpcs, build
├─ tests/smoke/
└─ .github/workflows/ci.yml
```

### Warum diese Schnitte

**`core/` gegen `campkumpel/`.** Die Grenze verläuft dort, wo Wohnmobilwissen
anfängt. `core/documents/` kann PDFs zerlegen und durchsuchen; dass ein
Abschnitt „Frischwassertank" heißt und deshalb beim Befüllen zitiert werden
soll, steht in `campkumpel/documents/`. Der Nutzen ist nicht Wiederverwendung
in anderen Produkten — den gibt es hier nicht —, sondern dass beim Lesen sofort
klar ist, ob eine Datei Infrastruktur oder Produktsubstanz enthält.

**`features/` als eigene Ebene.** Ein Flag, das nur einen Button versteckt,
während der Code überall verteilt liegt, ist kein Flag, sondern eine Absicht.
Liegt ein abgeschaltetes Feature in einem eigenen Verzeichnis, lässt es sich
beim Entfernen tatsächlich entfernen und beim Einschalten tatsächlich prüfen.

**`api/` dünn.** Sophies `api/chat.js` hat 1 862 Zeilen: HTTP-Behandlung,
Prompt-Aufbau, Tool-Ausführung, Council-Steuerung, Abrechnung und
Signal-Auswertung in einer Datei. Das ist die teuerste Stelle der Codebasis,
wenn man etwas ändern will. In CampKumpel bleibt in `api/` nur Request,
Response, Auth-Prüfung und Fehlerbehandlung; alles andere ist aufgerufene
Fachlogik.

---

## Umzugsplan

Sechs Schritte. Die Reihenfolge ist so gewählt, dass nach jedem Schritt etwas
Lauffähiges dasteht.

### Schritt 1 — Repository anlegen

Neues, eigenständiges Repository (kein Fork). Ein Fork erbt Sophies gesamte
Historie inklusive der Migrationen, die hier nicht mehr gelten, und macht jedes
spätere `git log` unlesbar.

```bash
# leeres Repo anlegen, dann:
git init campkumpel && cd campkumpel
git commit --allow-empty -m "chore: repository initialisiert"
```

Dann den Inhalt dieses Verzeichnisses übernehmen — `supabase/migrations/`,
`supabase/tests/`, `lib/feature-flags.js`, `tests/`, `docs/` liegen bereits in
der Zielstruktur und wandern eins zu eins.

> **Zu erledigen:** Dieser Schritt ist noch offen. Er braucht eine Entscheidung
> über Owner (persönlich oder Organisation) und Sichtbarkeit, und die GitHub-
> Freigabe dieser Session deckt nur `ToothMC/meet-sophie` ab.

### Schritt 2 — Infrastruktur portieren, unverändert

Dateien, die ohne fachliche Änderung mitkommen. Nur Importpfade anpassen:

| Aus Meet-Sophie | Nach |
|---|---|
| `lib/ai/adapters/*` | `core/ai/adapters/` |
| `lib/ai/classifier.js`, `cost-tracker.js`, `persona-normalizer.js` | `core/ai/` |
| `lib/sophie-auth-helper.js` | `core/auth/otp.js` |
| `lib/token-deduct.js` | `core/billing/` (Wasserfall ruft jetzt den RPC) |
| `lib/import/parsers/documents.js` | `core/documents/parsers/` |
| `lib/search-context.js` | `core/ai/search-context.js` |
| `scripts/check-syntax.mjs`, `check-rpcs.mjs` | `scripts/` |
| `.github/workflows/ci.yml` | unverändert |

**Eine Änderung ist Pflicht:** In `sophie-auth-helper.js` steht der
Supabase-Storage-Key hartcodiert als
`sb-ohzfojsbmzinpxhcynpt-auth-token`. Der muss aus der Supabase-URL abgeleitet
werden, statt erneut eine Projekt-ID im Code zu vergraben.

### Schritt 3 — Schema anlegen

Frisches Supabase-Projekt, Migrationen `0001` … `0008` anwenden, dann den
Storage-Bucket `vehicle-documents` (privat) von Hand anlegen — siehe Anleitung
am Ende von `0006_documents.sql`.

Danach `supabase/tests/run.sh` gegen eine lokale Postgres-Instanz laufen
lassen. Der Lauf ist die Abnahme des Zugriffsmodells.

### Schritt 4 — Prompt-Aufbau neu schreiben

`lib/server-prompt.js` ist die Vorlage: **ein** `Promise.all` für allen
Kontext, System-Prompt ausschließlich serverseitig. Die Quellen werden getauscht:

| Sophie lädt | CampKumpel lädt |
|---|---|
| `user_profile`, `user_relationship` | `profiles`, `user_travel_profile` |
| `sophie_long_term_memory` | `user_memory` |
| `sophie_short_term_memory` | `trip_memory` (aktive Reise) |
| Kalender, Chat-Importe | `vehicle_profiles`, `vehicle_memory` |
| — | `search_vehicle_documents()` bei Bedarf |

Das ist die inhaltlich anspruchsvollste Stelle des Umzugs, weil hier
entschieden wird, was ein Gespräch überhaupt weiß.

### Schritt 5 — Endpunkte

`api/chat.js` neu schreiben statt portieren. Sophies Datei enthält zu viel, was
hier nicht gilt (Council, Meeting-Modi, Brainstorm-Phasen,
Referrer-Signalauswertung). Übernommen werden die Muster: SSE-Streaming,
Tool-Tags, Statusmeldungen während der Tool-Ausführung, Kostenerfassung.

Danach `vehicles.js`, `vehicle-documents.js`, `user.js`, `feedback.js`,
`track.js`.

### Schritt 6 — Frontend

Zuletzt, mit dem MVP-Umfang aus `04-feature-flags.md`: Onboarding
(Fahrzeug anlegen, Profil füllen), Chat, Dokumentenupload, Reiseprofil,
Feedback. Kein Fahrzeugumschalter, kein Flottendashboard, kein Sprachmodus.

---

## Was nicht mitkommt

| Aus Meet-Sophie | Grund |
|---|---|
| `api/unfiltered/*`, `lib/unfiltered/*` | eigenständiges Produkt, kein Bezug |
| `api/meeting.js`, Meeting-Migrationen | Arbeitsraum-Modi entfallen |
| `lib/import/parsers/{chatgpt,claude,gemini}.js` | Chat-Import ist hier ohne Nutzen |
| `lib/ai/council*.js` | mitgenommen, aber hinter Flag `ai_council` |
| `lib/sophie-face-visualizer.js`, `sophie-emotion.js` | an Sophies Figur gebunden |
| `blog/`, `pricing/`, Landingpage | eigene Marke, eigener Inhalt |
| `supabase/rpc-allowlist.txt` | die Allowlist bleibt leer, siehe unten |

**Zur Allowlist.** Sophie führt darin sieben RPCs, die nur in der
Produktionsdatenbank existieren — unter anderem `deduct_tokens`,
`handle_new_user` und `insert_conversation_message`. Das eigene Runbook
(`supabase/MISSING_RPCS.md`) benennt die Folge deutlich: ein Fork oder DB-Reset
bricht Abrechnung, Nutzeranlage und Nachrichtenpersistenz. In CampKumpel hat
jede aufgerufene Funktion eine Migration; der Drift-Check aus
`scripts/check-rpcs.mjs` kommt mit, die Allowlist-Datei nicht.

---

## Zwei Repos, gemeinsame Herkunft

Meet-Sophie und CampKumpel teilen sich nach dem Umzug Infrastruktur, aber
keinen Code. Ein gemeinsames Paket (`@toothmc/core`) wäre die naheliegende
Idee und wäre jetzt verfrüht: zwei Produkte reichen nicht, um zu wissen, wo die
stabile Grenze verläuft, und ein zu früh geschnittenes gemeinsames Paket
bremst beide.

Die praktikable Zwischenform: Fehlerkorrekturen in portierten Dateien werden
bewusst in beide Repos übernommen, solange die Dateien noch erkennbar dieselben
sind. Die Liste der betroffenen Dateien steht in Schritt 2.
