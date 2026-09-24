// lib/feature-flags.js — zentrale Flag-Registry und Auflösung
//
// CampKumpel bringt die gesamte Infrastruktur von Meet-Sophie mit, aber nur
// einen Teil davon ist im MVP an. Die Regel aus der Produktspezifikation:
// nichts löschen, sondern abschalten. Ein gelöschtes Feature muss neu gebaut
// werden, ein abgeschaltetes wird eingeschaltet.
//
// Auflösungsreihenfolge, spezifischer schlägt allgemeiner:
//
//   1. Registry-Default   — was in dieser Datei steht
//   2. Umgebungsvariable  — CK_FLAG_<NAME>=on|off, für Deploy-Steuerung
//   3. Organisation       — organizations.feature_overrides
//   4. Nutzer             — profiles.feature_overrides
//
// Die Organisationsebene ist der Grund, warum es überhaupt eine Hierarchie
// braucht: der Vermieter-Pilot bekommt rental_context eingeschaltet, ohne
// dass es für Privatnutzer sichtbar wird, und ohne Deploy.

/**
 * @typedef {object} FlagDefinition
 * @property {boolean} default   Im MVP an?
 * @property {string}  summary   Was das Flag steuert
 * @property {string}  [note]    Warum es aus ist, bzw. was die Aktivierung braucht
 */

/** @type {Record<string, FlagDefinition>} */
export const FLAGS = {
  // ── MVP: an ────────────────────────────────────────────────────────────
  vehicle_profile: {
    default: true,
    summary: "Fahrzeugprofil anlegen, bearbeiten, Vollständigkeit anzeigen",
  },
  travel_profile: {
    default: true,
    summary: "Reisepräferenzen erfassen und fortschreiben",
  },
  chat_text: {
    default: true,
    summary: "Text-Chat mit Fahrzeug- und Reisekontext",
  },
  vehicle_documents: {
    default: true,
    summary: "Dokumente hochladen, parsen, im Gespräch zitieren",
  },
  memory_vehicle: {
    default: true,
    summary: "Fahrzeugwissen aus Gesprächen lernen (vehicle_memory)",
  },
  memory_user: {
    default: true,
    summary: "Nutzerpräferenzen aus Gesprächen lernen (user_memory)",
  },
  trip_context: {
    default: true,
    summary: "Aktive Reise als Gesprächskontext (trip_memory)",
  },
  live_research: {
    default: true,
    summary: "Live-Abruf für Wetter, Stellplätze, Öffnungszeiten, Regeln",
  },
  feedback: {
    default: true,
    summary: "Bewertung einzelner Antworten inkl. Personalisierungssignal",
  },

  // ── Vorbereitet, aber aus ──────────────────────────────────────────────
  voice: {
    default: false,
    summary: "Sprachmodus (Realtime, Transkription, TTS)",
    note:
      "Infrastruktur aus Meet-Sophie übernommen. Für Wohnmobilfahrer " +
      "langfristig der richtige Kanal, aber der MVP muss zuerst zeigen, " +
      "dass die Personalisierung trägt. conversations.modality kennt " +
      "'voice' bereits — Aktivierung ohne Migration.",
  },
  rental_context: {
    default: false,
    summary: "Mietkontext: Übergabe, befristeter Zugriff, Mieteransicht",
    note:
      "Schema und Lifecycle-RPCs sind fertig (Migration 0003). Fehlt: UI. " +
      "Wird für den ersten Vermieter-Pilot pro Organisation eingeschaltet.",
  },
  fleet_dashboard: {
    default: false,
    summary: "Flottenübersicht für Vermieter",
    note: "Nach dem Pilot. Vorher ist unklar, was darauf gehört.",
  },
  org_documents: {
    default: false,
    summary: "Flottenweite Dokumente (einmal hochladen, für alle Fahrzeuge)",
    note: "Braucht eine Dokumentebene oberhalb des Fahrzeugs.",
  },
  trip_planner: {
    default: false,
    summary: "Routenplanung mit fahrzeugspezifischen Beschränkungen",
    note:
      "Das offensichtliche nächste Feature — und die Stelle, an der " +
      "falsche Fahrzeugdaten teuer werden. Erst wenn die Profile " +
      "verlässlich gefüllt sind.",
  },
  maintenance_reminders: {
    default: false,
    summary: "Wartungs- und Prüfungserinnerungen (TÜV, Gasprüfung, Service)",
    note:
      "Braucht verlässliche Fristdaten am Fahrzeug und einen Zustellweg " +
      "(Push oder E-Mail). Beides hat der MVP nicht. Eine Erinnerung, die " +
      "zu spät oder gar nicht kommt, ist schlimmer als keine.",
  },
  multi_vehicle: {
    default: false,
    summary: "Mehrere Fahrzeuge pro Nutzer in der Oberfläche",
    note:
      "Datenmodell kann es ab Tag eins. Die Oberfläche bleibt im MVP " +
      "einfahrzeugig, weil ein Fahrzeugumschalter jede Ansicht komplizierter " +
      "macht und im B2C-Normalfall niemand zwei Wohnmobile hat.",
  },
  community_tips: {
    default: false,
    summary: "Fahrzeugübergreifendes Wissen (andere Hymer-B-Klasse-Fahrer)",
    note:
      "Datenschutzfrage vor Produktfrage: Fahrzeugwissen ist pro Fahrzeug " +
      "zugriffsgeschützt. Eine Aggregation über Fahrzeuge hinweg braucht " +
      "ein eigenes Einwilligungsmodell.",
  },
  ai_council: {
    default: false,
    summary: "Mehr-Modell-Beratung aus Meet-Sophie",
    note:
      "Drei Modellaufrufe pro Zug. Die typische CampKumpel-Frage braucht " +
      "Fahrzeugdaten, keine Modellabwägung.",
  },
  document_embeddings: {
    default: false,
    summary: "Semantische Dokumentensuche zusätzlich zur Volltextsuche",
    note: "Benötigt Migration 0006b (pgvector). Siehe Kommentar dort.",
  },
  billing_b2b: {
    default: false,
    summary: "Abrechnung pro Organisation statt pro Nutzer",
    note: "Tabelle organization_subscriptions existiert, Logik fehlt.",
  },
};

/** Normalisiert einen Override-Wert zu true/false/null (= kein Override). */
function normalize(value) {
  if (value === true || value === false) return value;
  if (value === null || value === undefined) return null;
  const s = String(value).trim().toLowerCase();
  if (["1", "on", "true", "yes", "enabled"].includes(s)) return true;
  if (["0", "off", "false", "no", "disabled"].includes(s)) return false;
  return null;
}

/** Name der Umgebungsvariable für ein Flag. */
export function envVarName(name) {
  return `CK_FLAG_${String(name).toUpperCase()}`;
}

/**
 * Löst ein einzelnes Flag auf.
 *
 * Ein unbekannter Name liefert false statt zu werfen: ein Tippfehler im
 * Aufruf soll ein Feature abschalten, nicht die Anfrage abbrechen.
 *
 * @param {string} name
 * @param {object} [ctx]
 * @param {Record<string, unknown>} [ctx.org]  organizations.feature_overrides
 * @param {Record<string, unknown>} [ctx.user] profiles.feature_overrides
 * @param {Record<string, string|undefined>} [ctx.env] Standard: process.env
 * @returns {boolean}
 */
export function isEnabled(name, ctx = {}) {
  const def = FLAGS[name];
  if (!def) return false;

  const env = ctx.env || (typeof process !== "undefined" ? process.env : {});

  let value = def.default;

  const fromEnv = normalize(env?.[envVarName(name)]);
  if (fromEnv !== null) value = fromEnv;

  const fromOrg = normalize(ctx.org?.[name]);
  if (fromOrg !== null) value = fromOrg;

  const fromUser = normalize(ctx.user?.[name]);
  if (fromUser !== null) value = fromUser;

  return value;
}

/**
 * Löst alle Flags auf einmal auf — für den Prompt-Aufbau und für das
 * Bootstrap-Objekt, das der Client beim Start bekommt.
 *
 * @param {object} [ctx] wie bei isEnabled
 * @returns {Record<string, boolean>}
 */
export function resolveFlags(ctx = {}) {
  const out = {};
  for (const name of Object.keys(FLAGS)) out[name] = isEnabled(name, ctx);
  return out;
}

/** Namen aller im MVP aktiven Flags (ohne Kontext). */
export function mvpFlags() {
  return Object.keys(FLAGS).filter((n) => FLAGS[n].default);
}
