# 02 — Datenmodell

Vier Wurzelentitäten, strikt getrennt:

```
PERSON ──────┐
             ├──── VEHICLE_ACCESS ────── VEHICLE ────── ORGANIZATION
TRIP ────────┘                              │
                                            └── VEHICLE_PROFILE, DOKUMENTE, WISSEN
```

Die Migrationen liegen in [`../supabase/migrations/`](../supabase/migrations/).
Jede ist für sich lauffähig und in der Nummernreihenfolge anzuwenden.

---

## Die eine Entscheidung, die alles trägt

> **Ein Fahrzeug gehört niemals fest zu einem Nutzer.**

`vehicles.owner_user_id` bzw. `owner_organization_id` sagen, **wem das
Fahrzeug gehört**. Sie sagen **nicht**, wer darauf zugreifen darf. Das steht
ausschließlich in `vehicle_access` — auch beim Privatbesitzer, der sein
eigenes Wohnmobil eingetragen hat. Ein Trigger legt ihm beim Anlegen des
Fahrzeugs automatisch einen `owner`-Eintrag an.

**Warum das kein Overhead ist, obwohl es für B2C so aussieht:**

- Der Privatbesitzer verleiht an Freunde und Familie. Beim Wohnmobil ist das
  kein Randfall, sondern der Normalfall.
- Fahrzeuge werden verkauft. Beim Halterwechsel muss das Fahrzeugwissen
  bleiben und der Zugriff wechseln — zwei Vorgänge, die sich nur trennen
  lassen, wenn sie an verschiedenen Stellen stehen.
- Der Vermieterfall wird damit **derselbe Codepfad**, nur mit
  `source = 'rental'` und gesetztem `valid_until`. Kein zweites
  Berechtigungssystem, kein `if (isRental)` durch die Anwendung verteilt.

Hätte die Autorisierung an `owner_user_id` gehangen, wäre der Vermieter-Pilot
eine Migration über produktive Fahrzeug- und Gesprächsdaten geworden — also
genau der Umbau, den man im laufenden Betrieb nicht mehr macht.

### Rollen

| Rolle | Darf |
|---|---|
| `viewer` | lesen |
| `driver` | lesen, Wissen beitragen, Reisen anlegen |
| `manager` | zusätzlich Fahrzeugprofil pflegen, Zugriffe vergeben |
| `owner` | alles, inkl. Löschung |

Es gibt bewusst **keine Rolle `renter`**. Ein Mieter ist ein `driver` mit
gesetztem `valid_until`. Die Unterscheidung steckt in `source` und Zeitfenster,
nicht in der Berechtigung — sonst müsste jede Prüfung im Code zwei Fälle
behandeln, die dasselbe dürfen.

### Zugriffsprüfung

`has_vehicle_access(vehicle_id, min_role)` ist `SECURITY DEFINER` und damit
RLS-frei. Das ist notwendig, nicht bequem: die Funktion wird aus den Policies
von `vehicles`, `vehicle_profiles`, `vehicle_memory`, `vehicle_documents` und
`conversations` aufgerufen. Liefe sie selbst unter RLS, entstünde beim
Auswerten der `vehicle_access`-Policy eine Rekursion.

Die Gegenmaßnahme steckt in der Signatur: die Funktion beantwortet
ausschließlich *"darf der aktuelle Nutzer"* und nimmt **keine `user_id`**
entgegen. Sie lässt sich damit nicht zum Ausspähen fremder Berechtigungen
zweckentfremden.

---

## Gedächtnis: getrennt nach Lebensdauer, nicht nach Modus

Meet-Sophie trennt Gedächtnis nach Gesprächsmodus (Meeting, Brainstorming,
Pitch). Dort ist das eine Produktentscheidung — alles gehört ohnehin demselben
Nutzer.

CampKumpel trennt nach **Eigentümerschaft und Lebensdauer**. Das ist keine
Produktentscheidung, sondern die Bedingung dafür, dass B2B2C überhaupt zulässig
ist:

| Tabelle | Gehört | Überlebt |
|---|---|---|
| `user_travel_profile`, `user_memory` | der Person | jeden Fahrzeugwechsel |
| `vehicle_memory` | dem Fahrzeug | jeden Halterwechsel |
| `trip_memory` | der Reise | nichts (TTL 30 Tage nach Reiseende) |

**Der Testfall, an dem sich die Trennung bewährt.** Ein Mieter gibt das
Wohnmobil zurück:

- Sein Reiseprofil („fährt kurze Etappen, meidet Autobahnen") bleibt bei ihm
  und ist beim nächsten Mietwagen sofort da.
- Sein Fund („die Heizung braucht zwei Minuten bis sie anspringt") bleibt beim
  Fahrzeug und hilft dem nächsten Mieter.
- Sein Reisekontext („war in Bozen, Streit über die Route") verfällt und wird
  von niemandem je wieder gelesen.

Keine dieser drei Regeln lässt sich über eine gemeinsame Tabelle mit
Filterlogik zuverlässig herstellen. Deshalb drei Tabellen.

### `vehicle_memory.visibility` — die Datenschutzsicherung

| Wert | Sichtbar für |
|---|---|
| `vehicle` | alle mit Fahrzeugzugriff |
| `author_only` | nur den Verfasser, auch nicht den Fahrzeugeigentümer |

Der Regelfall ist `vehicle` — genau das macht die Vermietung wertvoll, weil der
nächste Mieter profitiert. `author_only` fängt alles ab, was zwar am Fahrzeug
hängt, aber niemanden sonst angeht.

**Die Zuordnung trifft der Schreibpfad der Anwendung, nicht das Modell.** Was
während einer Miete (`source = 'rental'`) geschrieben wird, gilt als
`author_only`, sofern es nicht eindeutig eine technische Fahrzeugeigenschaft
ist. Im Zweifel privat: ein verlorener Hinweis kostet Komfort, ein geleakter
Hinweis kostet das Produkt.

### Verdichtung statt Anhängen

Von Sophie übernommen: `user_travel_profile` hat **eine Zeile pro Nutzer**, die
periodisch neu verdichtet wird (`last_condensed_at`), kein unbegrenzt
wachsendes Log. Daneben `user_memory` als Schlüssel-Wert-Speicher mit
`confidence` und `evidence_count` für das, was noch nicht verdichtet ist oder
in kein Feld passt. Upsert auf `(user_id, kind, key)`: wiederholte
Beobachtungen erhöhen die Konfidenz, statt Duplikate anzulegen.

Ebenfalls übernommen: das freie Dossier `memory_file`, das die KI nach jeder
Sitzung zusammenführt. Es fängt auf, was kein Schema vorhersieht. Die Größe ist
hier per Constraint gedeckelt (60 000 Zeichen) statt nur in der Anwendung.

---

## `vehicle_profiles` — die technische Wahrheit

Der Kern des Produktversprechens. Wenn CampKumpel sagt *„auf diesen Stellplatz
passt du nicht"*, muss das aus diesen Zahlen kommen — nie aus einer
Live-Recherche und nie aus Modellwissen über Wohnmobile im Allgemeinen.

Typisierte Spalten statt einem großen JSONB, weil die Werte validiert,
verglichen und in Prompts gerechnet werden. Maße durchgehend in **Millimetern**
und ganzzahlig: Zentimeterangaben werden im Gespräch gerundet, und diesen
Rundungsfehler will man nicht in der Datenbank haben.

**Zwei Felder, die in der Praxis den Unterschied machen:**

- `height_total_mm` **neben** `height_mm`. Die Herstellerhöhe stimmt nach dem
  Nachrüsten von Klimaanlage, Solarmodul oder Dachbox nicht mehr. Für
  Durchfahrtshöhen zählt nur die tatsächliche. Ein Constraint erzwingt
  `height_total_mm >= height_mm`.
- `width_mirrors_mm` **neben** `width_mm`. Für Fähren und Waschstraßen zählt
  die Breite mit Spiegeln.

**Plausibilitäts-Constraints** fangen Einheitenfehler ab (Meter statt
Millimeter, Tonnen statt Kilogramm). Sie ersetzen keine Validierung in der
Anwendung, aber sie sind das Netz darunter.

### Herkunft je Feld

`field_sources` (JSONB) hält pro Feld, woher der Wert stammt:

```json
{ "height_total_mm": { "source": "document", "confidence": 0.9,
                       "document_id": "…", "updated_at": "…" } }
```

Damit kann die Anwendung *„laut deinen Papieren"* von *„hast du mir gesagt"*
von *„habe ich aus dem Katalog"* unterscheiden. Bei Maßangaben ist dieser
Unterschied sicherheitsrelevant, und 40 zusätzliche Herkunftsspalten wären der
falsche Preis dafür.

---

## Dokumente und Abruf

Die Bedienungsanleitung ist die dichteste Wissensquelle über ein Fahrzeug, und
sie liegt als PDF vor. Sophie hat Parser und ein Storage-Muster, aber keine
Abrufschicht — Dokumente werden zusammengefasst, nicht durchsuchbar gemacht.
Bei 200 Seiten Handbuch reicht das nicht.

Deshalb `document_chunks` mit deutscher Volltextsuche. **Bewusst keine
Embeddings im MVP:** sie kosten pro Dokument und pro Abfrage, und für
Fachbegriffe in einem Handbuch („Frischwassertank", „Aufbaubatterie") ist
lexikalische Suche oft besser als semantische. Die Erweiterung ist vorbereitet
(Kommentar am Ende von `0006_documents.sql`, Flag `document_embeddings`); weil
der Abruf hinter der Funktion `search_vehicle_documents` steckt, ändert sich
dann nur deren Implementierung, nicht die Aufrufstelle.

### Warum die Suche zweistufig ist

Das ist beim Testen aufgefallen und wäre sonst lautlos falsch gewesen.

`websearch_to_tsquery('german', 'wie fülle ich den Frischwassertank')` ergibt
`'frischwassertank' & 'full'` — alle Begriffe mit **UND**. Der Handbuchabsatz
enthält aber `frischwassertank` und `befullt`; der deutsche Stemmer bildet
„befüllt" nicht auf „füllen" ab. Ergebnis: **null Treffer, ohne Fehlermeldung**
— die Antwort kommt einfach ohne Handbuchwissen.

`search_vehicle_documents` sucht deshalb mit **ODER** über dieselben Lexeme und
sortiert nach `ts_rank`; Treffer, die zusätzlich der strikten Abfrage genügen,
stehen oben und sind im Rückgabefeld `exact` markiert. Für einen Abruf, der ein
Sprachmodell füttert, ist Trefferquote wichtiger als Genauigkeit: das Modell
verwirft einen unpassenden Absatz, aber es kann einen fehlenden nicht erraten.

### Sicherheitsannahme

Dokumentinhalte sind **Fremddaten**. Sophie behandelt Council-Antworten bereits
so (`COUNCIL_RULE` in `api/chat.js`: Anweisungen im Datenblock werden nicht
befolgt). Für hochgeladene PDFs gilt dasselbe — Chunks gehen in einen
abgegrenzten Kontextblock, nie in die Anweisungsebene.

`document_chunks.vehicle_id` ist gegenüber `vehicle_documents` dupliziert,
damit Policy und Filter auf dem heißen Pfad ohne Join auskommen. Ein Trigger
leitet den Wert **immer** aus dem Dokument ab und übernimmt ihn nie vom
Aufrufer — sonst könnte ein fehlerhafter Schreibpfad Chunks am falschen
Fahrzeug einhängen und damit an der RLS vorbei sichtbar machen.

---

## Gespräche

**Ein** Session-Modell, nicht zwei. Sophie trägt `chat_sessions` *und*
`user_sessions` + `conversation_messages` parallel und muss in `api/chat.js`
per `isCanonical`-Flag entscheiden, ob Nachrichten überhaupt persistiert
werden. Dieser Dualismus wird nicht übernommen.

Neu: `vehicle_id` und `trip_id` am Gespräch. Der Kontext „welches Fahrzeug,
welche Reise" ist bei CampKumpel kein Zusatz, sondern die Voraussetzung dafür,
dass die Antwort überhaupt stimmt.

**Gespräche gehören dem Nutzer, nicht dem Fahrzeughalter.** In den Policies von
`conversations` steht ausschließlich `user_id = auth.uid()` und nirgends
`has_vehicle_access()`. Ein Vermieter bekommt die Gespräche seiner Mieter nie
zu sehen, auch nicht über das eigene Fahrzeug. Beim *Anlegen* wird der
Fahrzeugzugriff dagegen sehr wohl geprüft.

`insert_conversation_message` vergibt die Sequenznummer **in der Funktion**,
nicht beim Aufrufer, und sperrt dafür die Gesprächszeile. Zwei gleichzeitige
Schreibvorgänge liefen sonst in einen Unique-Konflikt.

---

## Abrechnung

Der Token-Wasserfall (frei → bezahlt → Aufladung) kommt aus Sophies
`lib/token-deduct.js`, hier aber als **Datenbankfunktion** statt als
Lese-Rechne-Schreibe-Folge in der Anwendung. Sophies JS-Variante hat zwischen
`SELECT` und `UPDATE` ein Zeitfenster; bei zwei parallelen Anfragen desselben
Nutzers kann ein Token doppelt ausgegeben werden. In einer einzelnen Anweisung
unter Zeilensperre existiert das Fenster nicht.

Zusätzlich gegenüber Sophie:

- `token_ledger` — Journal jeder Buchung. Ohne Journal lässt sich ein
  Abrechnungsstreit nicht klären und ein Fehler im Wasserfall nicht
  nachrechnen; man sieht nur den Endstand.
- `idempotency_key` — derselbe Aufruf zweimal zugestellt bucht einmal ab.
- Constraints `used <= total` — ein Rechenfehler im Wasserfall fällt sofort
  auf, statt still die Abrechnung schief zu ziehen.

Preise stehen **nicht** in der Datenbank, sondern in `lib/billing-constants.js`
— wie bei Sophie, und aus gutem Grund: eine Preisänderung soll ein Deploy sein,
keine Migration.

---

## Konventionen

- **`text` + `CHECK` statt `ENUM`.** ENUM-Werte lassen sich nicht entfernen und
  nicht umbenennen. Bei einem Produkt, dessen Zustandsmodell sich noch bewegt,
  ist das der falsche Tausch. Sophie mischt beides; hier ist es durchgängig.
- **`SET search_path = public, pg_temp` auf jeder Funktion.** Sophie musste das
  nachträglich über alle Funktionen ziehen (`20260527_security_audit_lockdown.sql`).
- **`SECURITY DEFINER` nur bei unvermeidbarer RLS-Rekursion**, und dann immer
  mit `REVOKE EXECUTE FROM PUBLIC, anon, authenticated`.
- **Schreiben läuft serverseitig.** Client-Policies decken überwiegend `SELECT`
  ab. Einzige Ausnahme: `message_feedback` — dort wäre jede zusätzliche Hürde
  teurer als der Kontrollgewinn, weil wir sonst keine Daten bekommen.
- **Jeder aufgerufene RPC hat eine Migration.** Sophies Allowlist
  (`supabase/rpc-allowlist.txt`) listet sieben Funktionen, die nur in
  Produktion existieren — darunter `deduct_tokens`, `handle_new_user` und
  `insert_conversation_message`. Ein DB-Reset bricht dort Abrechnung,
  Nutzeranlage und Nachrichtenpersistenz. Diese drei sind hier von Anfang an
  im Repo.

---

## Was geprüft ist

`supabase/tests/run.sh` wendet alle acht Migrationen auf eine frische
Postgres-Datenbank an und fährt ein Vermietungsszenario mit zwei
aufeinanderfolgenden Mietern. Geprüft wird, was Lesen allein nicht zeigt:

| # | Zusage |
|---|---|
| 1 | Vor der Übergabe sieht der Mieter 0 Fahrzeuge |
| 2 | Nach der Übergabe sieht er Fahrzeug und Profil, darf das Profil aber nicht ändern |
| 4 | Der Vermieter sieht nur geteiltes Fahrzeugwissen und 0 Gespräche |
| 5 | Nach der Rückgabe: 0 Fahrzeuge, aber Reiseprofil und eigene Gespräche bleiben |
| 6 | Der Folgemieter erbt geteiltes Wissen, sieht aber weder privates Wissen noch Vermietung noch Gespräche des Vorgängers |
| 7 | Abgelaufener Zugriff greift auch ohne Rückgabe-Event nicht mehr |
| 8 | Token-Wasserfall, Idempotenz, Überziehungsschutz |
| 9 | Dokumentensuche findet den Absatz auch bei natürlichsprachiger Frage |
| 10 | Fünf Constraints scheitern erwartungsgemäß |

Der Lauf braucht kein Supabase: `supabase-stub.sql` baut `auth.users` und
`auth.uid()` minimal nach.

**Nicht geprüft**, weil ohne laufende Anwendung nicht sinnvoll: das Verhalten
unter Nebenläufigkeit, die Prompt-Größe bei vollem Kontext, und ob die
Chunk-Größe für echte Handbücher passt.

---

## Offene Punkte

- **Preismodell.** Sophies Konstanten sind auf ~60 % Marge bei ihrem
  Nutzungsprofil kalibriert. CampKumpel hat ein anderes (weniger, aber längere
  Sitzungen; Dokumentenabruf statt Council) und muss neu gerechnet werden.
- **Chunk-Größe und Überlappung.** Steht bewusst nicht im Schema, sondern in
  der Parser-Konfiguration. Braucht echte Handbücher zum Kalibrieren.
- **Vollständigkeitsberechnung.** `vehicle_profiles.completeness` ist eine
  Spalte, aber welche Felder wie zählen, ist eine Produktfrage: welche zehn
  Felder machen den Unterschied zwischen „kennt mein Fahrzeug" und „kennt
  Wohnmobile"?
- **Fahrzeugkatalog.** Marke/Modell/Baujahr → Vorbelegung des Profils würde das
  Onboarding drastisch verkürzen. `field_sources` sieht `source: "catalog"` vor,
  eine Datenquelle dafür gibt es noch nicht.
