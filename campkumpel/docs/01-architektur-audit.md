# 01 — Architektur-Audit Meet-Sophie

Bestandsaufnahme der Meet-Sophie-Codebasis mit einer Frage pro Baustein:
**übernehmen, anpassen oder weglassen?**

Grundlage: Stand `main` @ `de54426`, 8.363 Zeilen in `api/` + `lib/`,
34 Migrationen, 12 Smoke-Tests.

---

## 1. Authentifizierung

**Was da ist:** `lib/sophie-auth-helper.js` — Supabase Auth, ausschließlich
E-Mail-OTP (6-stelliger Code). Magic Links wurden bewusst entfernt: sie brachen
bei Gmail-Weiterleitung, Doppel-Tabs, iOS-PWA-Storage-Isolation und
Link-Scannern, die den Token vorab verbrauchen.

Dazu Guard-Helper für anti-flash Redirects (`hasStoredSession()` synchron aus
localStorage im `<head>`, `getSessionOrNull()` asynchron autoritativ).

**Bewertung:** Das ist teuer erkauftes Wissen. Die OTP-Entscheidung und die
Guard-Helper übernehme ich unverändert.

**Anpassung:** Der Storage-Key `sb-ohzfojsbmzinpxhcynpt-auth-token` ist auf die
Sophie-Projekt-ID hartcodiert. Für CampKumpel muss er aus der Supabase-URL
abgeleitet werden, statt erneut eine Projekt-ID im Code zu vergraben.

**Verdikt: übernehmen, Storage-Key parametrisieren.**

---

## 2. Datenbank & Row Level Security

**Was da ist:** Postgres auf Supabase, RLS auf allen Nutzertabellen. Das Muster
ist durchgängig:

```sql
using (user_id = auth.uid())
with check (user_id = auth.uid())
```

Bei abgeleiteten Tabellen (`conversation_messages`) läuft die Prüfung über ein
`exists (select 1 from user_sessions s where s.id = ... and s.user_id = auth.uid())`.

Die Migration `20260323_chat_sessions_rls_hardening.sql` korrigiert eine frühe
Schwäche: die ursprüngliche Policy hatte `with check (true)` beim INSERT und
`or user_id is null` beim SELECT. Beides wurde geschlossen.
`20260527_security_audit_lockdown.sql` ergänzt nach Supabase-Advisor-Befund
`SET search_path = public, pg_temp` auf allen Funktionen und entzieht
`SECURITY DEFINER`-Funktionen das EXECUTE-Recht für `anon` und `authenticated`.

**Bewertung:** Das Sicherheitsmodell ist solide, aber die Lektionen wurden
nachträglich gelernt. CampKumpel startet direkt mit dem Endzustand:
`search_path` gesetzt, keine permissiven Policies, Schreibrechte serverseitig.

**Ein struktureller Unterschied:** Sophies Autorisierung ist immer
`row.user_id = auth.uid()`. Das reicht nicht mehr. CampKumpel braucht
*fahrzeugbezogene* Autorisierung — mehrere Personen mit verschiedenen Rollen und
befristeter Gültigkeit am selben Fahrzeug. Das ist die eine Stelle, an der
CampKumpel das Sophie-Muster nicht fortsetzen kann, sondern eine Ebene
darüberlegen muss (`has_vehicle_access()`, siehe Datenmodell).

**Verdikt: Muster übernehmen, Autorisierungsebene neu bauen.**

---

## 3. Conversation-Persistenz

**Was da ist:** Zwei parallele Session-Modelle, historisch gewachsen.

- `chat_sessions` (Migration 20260320) — das frühe Text-Chat-Modell
- `user_sessions` + `conversation_messages` + `conversation_outputs`
  (Migration 20260314) — das kanonische Modell

`api/chat.js` muss beides bedienen und führt dafür ein `isCanonical`-Flag mit:

```js
async function persistChatMessages(supabase, sessionId, ..., isCanonical) {
  if (!isCanonical) return; // Legacy chat_sessions — no message persistence
```

Gleichzeitig referenzieren die Memory-Tabellen (`sophie_short_term_memory`) über
`conversation_id` auf `chat_sessions`, während die Nachrichten an
`user_sessions` hängen. Migration `20260404_stm_fk_user_sessions.sql` versucht
das zu reparieren.

**Bewertung:** Klassische Altlast. Die Struktur des kanonischen Modells ist gut
— Session, Turns mit `seq`, strukturiertes Output-Objekt pro Session. Der
Dualismus ist reiner Ballast.

**Verdikt: kanonisches Modell übernehmen, `chat_sessions` ersatzlos streichen.**
CampKumpel hat genau eine Tabelle `conversations`. Sie bekommt zusätzlich
`vehicle_id` und `trip_id` — der Fahrzeugkontext ist bei CampKumpel nicht
optional, sondern das Produkt.

---

## 4. Memory-System

**Was da ist:** Der durchdachteste Teil der Codebasis. Fünf Ebenen, definiert in
`src/memory/memory.enums.ts`:

| Ebene | Persistenz | Tabelle |
|---|---|---|
| A — Akut | nur im Prozess | keine |
| B — Kurzzeit | TTL 14–60 Tage | `sophie_short_term_memory` |
| C — Langzeit | unbegrenzt, periodisch verdichtet | `sophie_long_term_memory` |
| D — Modus-Arbeitsraum | isoliert pro Modus | `sophie_meeting_memory` u.a. |
| E — Relevanz | berechnet, nie geschrieben | — |

Dazu zwei Mechanismen, die ich für wertvoll halte:

**Verdichtung statt Anhängen.** `sophie_long_term_memory` hat genau eine Zeile
pro Nutzer, `last_condensed_at` markiert die letzte Verdichtung. Kein
unbegrenzt wachsendes Log.

**Tiefe als Berechtigung.** `lib/memory-helpers.js` koppelt die Abo-Stufe an die
Gedächtnistiefe und filtert beim Lesen:

```js
export const TIER_MEMORY_CONFIG = {
  free:      { depth: null,    ttlDays: 0  },
  assistant: { depth: "light",  ttlDays: 14 },
  ...
};
export function filterLtmByDepth(depth, row) { ... }
```

**Bewertung:** Die Ebenen-Idee und die Verdichtung übernehme ich. Die
Dimension, nach der getrennt wird, stimmt für CampKumpel aber nicht.

Sophie trennt nach **Gesprächsmodus** (Meeting / Brainstorm / Pitch). Alles
gehört demselben Nutzer, Isolation ist eine Produktentscheidung.

CampKumpel muss nach **Eigentümerschaft und Lebensdauer** trennen. Wissen über
ein Fahrzeug überlebt den Nutzer, der es eingetragen hat. Präferenzen eines
Nutzers überleben das Fahrzeug. Reisekontext überlebt keines von beidem. Das ist
keine Produktentscheidung, sondern eine Datenschutzanforderung: beim
B2B2C-Vermietfall darf der Vermieter nie persönliche Daten des Mieters sehen,
und der nächste Mieter nie die des vorigen.

**Verdikt: Mechanik übernehmen (Ebenen, TTL, Verdichtung, Tiefensteuerung),
Trenndimension ersetzen** — `user_memory` / `vehicle_memory` / `trip_memory`
statt Modus-Arbeitsräumen.

Der `memory_file`-Ansatz (`user_profile.memory_file`, freies Textdossier, das
die KI nach jeder Sitzung zusammenführt) ist gut und kommt mit — als
`user_travel_profile.memory_file`.

---

## 5. System-Prompt-Aufbau

**Was da ist:** `lib/server-prompt.js` lädt in **einem** `Promise.all` zehn
Kontextquellen (Profil, Beziehung, Abo, letzte Sitzungen, Importe, LTM, STM,
Reports, letzte Nachrichten, Kalender) und reicht sie an `buildSophiePrompt()`.

Zwei Dinge sind richtig gelöst:

- **Der Client sieht den System-Prompt nie.** Kommentar in Zeile 3:
  „The client NEVER sees or supplies the system prompt." Er wird serverseitig
  aus der DB gebaut.
- **Ein Roundtrip für allen Kontext.** Zehn parallele Queries statt
  sequenzieller Ladeketten.

**Bewertung:** Muster und Parallelisierung übernehmen. Die Quellen ändern sich:
statt Kalender und KI-Chat-Importen lädt CampKumpel Fahrzeugprofil,
Fahrzeugwissen, Reiseprofil und aktiven Reisekontext.

**Verdikt: übernehmen, Kontextquellen austauschen.**

---

## 6. Multi-Provider-KI-Routing

**Was da ist:** `api/ai/router.js` + `lib/ai/adapters/` — Klassifikation der
Anfrage, Routing auf einen Provider, Timeout-gesteuerter Fallback auf einen
zweiten, Kostenerfassung, Budget-Deckel mit Degradation auf ein günstigeres
Modell:

```js
const withinBudget = await checkDailyBudget(userId, ctx.userTier);
if (!withinBudget) {
  decision.primary = { provider: 'google', model: 'gemini-2.5-flash-lite' };
  decision.reason = 'budget-cap-degradation';
}
```

Dazu `lib/ai/persona-normalizer.js`, der providerspezifische Eigenheiten aus der
Antwort entfernt, damit die Stimme über alle Modelle gleich klingt.

**Bewertung:** Genau das, was ein Produkt mit KI-Kosten braucht, und
produktgetestet. Der Normalizer ist für CampKumpel genauso relevant — ein
Begleiter, der je nach Provider anders klingt, wäre kein Begleiter.

**Verdikt: unverändert übernehmen.** Personabeschreibungen und
Klassifikations-Heuristiken werden ersetzt.

---

## 7. Live-Recherche

**Was da ist:** Tools in `api/ai/tools.js` (Wetter, Websuche, News, Wikipedia,
Flugdaten, grounded search), aufgerufen über Tags im Modellsatz
(`[TOOL:grounded_search:...]`). Die Ergebnisse gehen **nicht** roh an den Nutzer,
sondern durch `lib/search-context.js`:

> Architecture Rule #1: Sophie ist die einzige Stimme.
> Keine Rohantwort durchreichen, kein answer-Feld.

Der Kontextblock trägt zusätzlich die Konfidenz und weist das Modell an, bei
niedriger Verlässlichkeit vorsichtiger zu formulieren.

**Bewertung:** Richtig und für CampKumpel unmittelbar wertvoll — Stellplätze,
Öffnungszeiten, Mautregeln, Wetter und Durchfahrtshöhen sind alles
Live-Informationen. Die Isolationsregel gilt unverändert.

**Verdikt: übernehmen.** Flugdaten-Tools fliegen raus, dafür kommen
Stellplatz- und Streckenabfragen.

**Ein Hinweis fürs Produkt:** die Konfidenzstufe wird bei CampKumpel wichtiger
als bei Sophie. Eine falsche Öffnungszeit kostet einen Umweg, eine falsche
Durchfahrtshöhe kostet das Fahrzeugdach. Fahrzeugbezogene Maßangaben dürfen
**nie** aus Live-Recherche stammen, immer nur aus dem Fahrzeugprofil.

---

## 8. Council (Mehr-Modell-Beratung)

**Was da ist:** `lib/ai/council.js` — mehrere Modelle bewerten dieselbe Frage,
Sophie formuliert daraus eine eigene Antwort. Mit einer bemerkenswert sauberen
Prompt-Injection-Abwehr (`COUNCIL_RULE` in `api/chat.js`): Inhalte in
`<COUNCIL_DATA>` sind ungeprüfte Daten, Anweisungen darin werden nicht befolgt,
Mehrheit ist kein Abstimmungsergebnis.

**Bewertung:** Technisch stark, aber teuer (drei Modellaufrufe pro Zug) und für
den CampKumpel-MVP ohne Nutzen. Die typische Frage ist „passt mein Fahrzeug auf
diesen Stellplatz" — dafür braucht es Fahrzeugdaten, keine Modellabwägung.

**Verdikt: mitnehmen, per Flag aus.** Die Injection-Abwehr wird als Muster für
Dokumenteninhalte wiederverwendet — hochgeladene Bedienungsanleitungen sind
genauso ungeprüfte Fremddaten wie Council-Antworten.

---

## 9. Voice / Realtime

**Was da ist:** `api/session.js` (1.340 Zeilen) — Realtime-Sessions mit
`acquire_realtime_lock`-RPC gegen Parallelnutzung, `api/ai/transcribe.js`,
`api/ai/tts.js`, sekundengenaue Abrechnung.

**Bewertung:** Für Wohnmobilreisende ist Sprache langfristig *der* richtige
Kanal — man fährt. Aber es ist der aufwendigste Baustein, und der MVP muss
zuerst beweisen, dass die Personalisierung trägt.

**Verdikt: mitnehmen, per Flag aus.** Keine Ausbaustufe verbauen: `conversations`
bekommt von Anfang an eine `modality`-Spalte, damit Sprachzüge später ohne
Migration danebenpassen.

---

## 10. Dokumente & Import

**Was da ist:** `lib/import/` mit Parsern für Chat-Exporte (ChatGPT, Claude,
Gemini) und Dokumente (`pdf-parse`, `mammoth` für docx), eine Pipeline mit
Sensitivitätsprüfung und Zoneneinteilung (`zone` A/B/C nach Vertraulichkeit),
ein `source_ledger` für Herkunftsnachweis.

Dateien landen in Supabase Storage, Bucket privat, Zugriff über Signed URLs
(`20260326_meeting_file_uploads.sql`).

**Bewertung:** Die Chat-Import-Parser sind für CampKumpel irrelevant. Die
**Dokumenten-Pipeline** ist dagegen zentral — die Bedienungsanleitung ist die
wichtigste Wissensquelle über ein Fahrzeug, und sie liegt als PDF vor.

Was fehlt: Sophie hat keine Chunking- und Retrieval-Schicht. Dokumente werden
zusammengefasst, nicht durchsuchbar gemacht. Bei einer 200-seitigen
Wohnmobil-Anleitung reicht eine Zusammenfassung nicht — man braucht die
konkrete Stelle über die Wasserpumpe.

**Verdikt: Parser und Storage-Muster übernehmen, Retrieval neu bauen.**
Im MVP deutsche Volltextsuche (`tsvector`), Embeddings sind als spätere
Migration vorgesehen.

---

## 11. Billing

**Was da ist:** Stripe-Integration, Token-Wasserfall in `lib/token-deduct.js`
(frei → bezahlt → Aufladung), zentrale Konstanten in `lib/billing-constants.js`,
Idempotenz für Webhooks (`20260419_billing_idempotency.sql`).

**Bewertung:** Übernehmbar. Die Konstanten sind auf ~60 % Marge kalibriert und
müssen für CampKumpel neu gerechnet werden — anderes Nutzungsprofil, andere
Preisbereitschaft.

**Eine Lücke:** B2B braucht Abrechnung pro Organisation, nicht pro Nutzer. Ein
Vermieter zahlt für Fahrzeuge, nicht für Mieter. Das Schema sieht dafür
`organization_subscriptions` vor, im MVP aber ohne Implementierung.

**Verdikt: übernehmen, Preismodell neu rechnen, Org-Abrechnung vorbereiten.**

---

## 12. CI & Qualitätssicherung

**Was da ist:** `.github/workflows/ci.yml` mit drei Schritten — Syntaxcheck,
RPC-Drift-Check, Smoke-Tests (`node --test`, keine Test-Framework-Abhängigkeit).

Der **RPC-Drift-Check** (`scripts/check-rpcs.mjs`) verdient Hervorhebung: er
vergleicht die im Code aufgerufenen `supabase.rpc(...)`-Namen gegen die in
`supabase/migrations/` definierten Funktionen und warnt bei Abweichung. Die
Lücken sind in `supabase/rpc-allowlist.txt` dokumentiert, mit einem
Recovery-Runbook in `supabase/MISSING_RPCS.md`.

**Der Befund dahinter ist die wichtigste Lehre des ganzen Audits:** sieben RPCs
existieren nur in der Produktionsdatenbank, nicht in den Migrationen. Aus
`MISSING_RPCS.md`:

> Ein Project-Fork, DB-Reset oder Setup einer Staging-Instanz würde Billing,
> Meetings und Session-Locks sofort brechen.

Betroffen sind unter anderem `deduct_tokens`, `insert_conversation_message` und
`handle_new_user` — also Abrechnung, Nachrichtenpersistenz und Nutzeranlage.

**Verdikt: CI-Setup und Drift-Check übernehmen. Die Allowlist bleibt leer.**
Jede Funktion, die CampKumpel aufruft, hat eine Migration. Die Migrationen in
`supabase/migrations/` definieren `deduct_tokens` und
`insert_conversation_message` deshalb von Anfang an im Repo.

---

## Zusammenfassung

| Baustein | Entscheidung |
|---|---|
| Auth (OTP, Guards) | übernehmen, Storage-Key parametrisieren |
| RLS-Muster | übernehmen, Fahrzeugebene ergänzen |
| Conversation-Modell | kanonischen Teil übernehmen, `chat_sessions` streichen |
| Memory-Mechanik | übernehmen |
| Memory-Trenndimension | ersetzen (Nutzer / Fahrzeug / Reise) |
| Prompt-Builder | übernehmen, Quellen tauschen |
| KI-Routing + Fallback + Budget | unverändert übernehmen |
| Persona-Normalizer | unverändert übernehmen |
| Live-Recherche + Isolationsregel | übernehmen, Tools tauschen |
| Council | mitnehmen, Flag aus |
| Voice / Realtime | mitnehmen, Flag aus |
| Dokumenten-Parser + Storage | übernehmen |
| Dokumenten-Retrieval | neu bauen |
| Chat-Import (ChatGPT/Claude/Gemini) | weglassen |
| Meeting / Brainstorm / Pitch | weglassen |
| Unfiltered (`api/unfiltered/`, `lib/unfiltered/`) | weglassen |
| Billing-Mechanik | übernehmen, Preise neu rechnen |
| CI + RPC-Drift-Check | übernehmen, Allowlist leer halten |

Der Wiederverwendungsanteil liegt damit bei etwa **70 %** der Infrastruktur —
was der ursprünglichen Einschätzung entspricht. Der Rest ist nicht
Mehraufwand durch Portierung, sondern die eigentliche Produktsubstanz:
Fahrzeugwissen, Zugriffsmodell und Dokumenten-Retrieval.
