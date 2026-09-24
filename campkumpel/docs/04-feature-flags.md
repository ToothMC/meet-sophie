# 04 — Feature-Flags

Grundregel aus der Produktspezifikation: **nichts löschen, sondern
abschalten.** Ein gelöschtes Feature muss neu gebaut werden, ein abgeschaltetes
wird eingeschaltet.

Registry und Auflösung: [`../lib/feature-flags.js`](../lib/feature-flags.js).
Tests: [`../tests/feature-flags.test.mjs`](../tests/feature-flags.test.mjs).

---

## Auflösung

Spezifischer schlägt allgemeiner:

| # | Ebene | Quelle |
|---|---|---|
| 1 | Registry-Default | `FLAGS[name].default` |
| 2 | Umgebung | `CK_FLAG_<NAME>=on\|off` |
| 3 | Organisation | `organizations.feature_overrides` |
| 4 | Nutzer | `profiles.feature_overrides` |

```js
import { isEnabled, resolveFlags } from "./lib/feature-flags.js";

if (isEnabled("vehicle_documents", { org, user })) { … }

// Für den Prompt-Aufbau und das Bootstrap-Objekt des Clients:
const flags = resolveFlags({ org, user });
```

**Die Organisationsebene ist der Grund, warum es überhaupt eine Hierarchie
braucht.** Der Vermieter-Pilot bekommt `rental_context` eingeschaltet, ohne
dass es für Privatnutzer sichtbar wird und ohne Deploy.

Zwei bewusste Festlegungen im Verhalten:

- **Ein unbekannter Name liefert `false` statt zu werfen.** Ein Tippfehler im
  Aufruf soll ein Feature abschalten, nicht die Anfrage abbrechen.
- **Ein unbrauchbarer Override wird ignoriert, nicht als `false` gewertet.**
  Steht in der Datenbank `"vielleicht"`, bleibt das Flag auf seinem Default —
  sonst schaltet ein Tippfehler in einer JSONB-Spalte ein Feature ab.

Beides ist in den Tests festgehalten. Ebenso, dass jedes abgeschaltete Flag
eine `note` haben **muss**: sonst weiß in sechs Monaten niemand mehr, ob „aus"
Absicht oder Versehen war. Der Test hat beim ersten Lauf prompt ein Flag ohne
Begründung gefunden.

---

## MVP: an

| Flag | Steuert |
|---|---|
| `vehicle_profile` | Fahrzeugprofil anlegen, bearbeiten, Vollständigkeit anzeigen |
| `travel_profile` | Reisepräferenzen erfassen und fortschreiben |
| `chat_text` | Text-Chat mit Fahrzeug- und Reisekontext |
| `vehicle_documents` | Dokumente hochladen, parsen, im Gespräch zitieren |
| `memory_vehicle` | Fahrzeugwissen aus Gesprächen lernen |
| `memory_user` | Nutzerpräferenzen aus Gesprächen lernen |
| `trip_context` | Aktive Reise als Gesprächskontext |
| `live_research` | Live-Abruf für Wetter, Stellplätze, Öffnungszeiten, Regeln |
| `feedback` | Bewertung einzelner Antworten inkl. Personalisierungssignal |

Diese neun ergeben zusammen genau eine prüfbare Aussage: *CampKumpel kennt mein
Fahrzeug und meine Reisegewohnheiten und antwortet deshalb anders als eine
allgemeine KI.* Alles, was nicht zu dieser Aussage beiträgt, ist aus.

---

## Vorbereitet, aber aus

| Flag | Warum aus |
|---|---|
| `voice` | Für Wohnmobilfahrer langfristig der richtige Kanal — man fährt. Aber der aufwendigste Baustein, und der MVP muss zuerst die Personalisierung beweisen. `conversations.modality` kennt `'voice'` bereits, Aktivierung braucht keine Migration. |
| `rental_context` | Schema und Lifecycle-RPCs sind fertig (Migration 0003). Es fehlt nur die Oberfläche. Wird pro Organisation eingeschaltet. |
| `fleet_dashboard` | Nach dem Pilot. Vorher ist unklar, was darauf gehört. |
| `org_documents` | Braucht eine Dokumentebene oberhalb des Fahrzeugs. |
| `trip_planner` | Das offensichtliche nächste Feature — und die Stelle, an der falsche Fahrzeugdaten teuer werden. Erst wenn die Profile verlässlich gefüllt sind. |
| `maintenance_reminders` | Braucht Fristdaten am Fahrzeug und einen Zustellweg. Eine Erinnerung, die zu spät kommt, ist schlimmer als keine. |
| `multi_vehicle` | Das Datenmodell kann es ab Tag eins. Die Oberfläche bleibt einfahrzeugig, weil ein Umschalter jede Ansicht komplizierter macht und im B2C-Normalfall niemand zwei Wohnmobile hat. |
| `community_tips` | Datenschutzfrage vor Produktfrage: Fahrzeugwissen ist pro Fahrzeug zugriffsgeschützt. Aggregation über Fahrzeuge hinweg braucht ein eigenes Einwilligungsmodell. |
| `ai_council` | Drei Modellaufrufe pro Zug. Die typische CampKumpel-Frage braucht Fahrzeugdaten, keine Modellabwägung. |
| `document_embeddings` | Braucht Migration 0006b (pgvector). Volltextsuche reicht für Handbuchbegriffe zunächst. |
| `billing_b2b` | Tabelle `organization_subscriptions` existiert, Logik fehlt. |

---

## Wie ein Flag aktiviert wird

1. **Erst im Deploy:** `CK_FLAG_VOICE=on` in einer Vorschau-Umgebung.
2. **Dann für einzelne:** `profiles.feature_overrides` für interne Konten.
3. **Dann für eine Organisation:** `organizations.feature_overrides` für den
   Piloten.
4. **Zuletzt der Default:** `FLAGS.voice.default = true` und Flag entfernen,
   sobald es nicht mehr umschaltbar sein muss.

Schritt 4 gehört dazu. Ein Flag, das dauerhaft auf `true` steht, ist kein Flag
mehr, sondern eine Verzweigung, die niemand mehr testet.
