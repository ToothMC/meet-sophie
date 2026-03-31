// lib/sophie-capabilities.js — Zentrale Quelle der Wahrheit über Sophies Fähigkeiten
// Wird genutzt für: Self-Knowledge Prompt, Tool Auto-Check, Feature-Discovery
// WICHTIG: Bei neuen Features hier eintragen — Sophie prüft automatisch ob alles erfasst ist

export const SOPHIE_CAPABILITIES = {
  modes: {
    talk:       { name: "Talk",        desc: "Natürliche Gespräche — wie mit einer echten Freundin", free: true },
    brainstorm: { name: "Brainstorm",  desc: "Strukturierte Ideenfindung — Solo oder im Team mit Phasen", free: false },
    meeting:    { name: "Meeting",     desc: "Meetings vorbereiten, begleiten und Protokoll erstellen", free: false },
    salespitch: { name: "Sales Pitch", desc: "Pitch üben mit detailliertem Scoring und Feedback", free: false },
  },

  tools: {
    weather:    { name: "Wetter",        desc: "Aktuelles Wetter + 3-Tage-Vorhersage für jeden Ort" },
    search:     { name: "Web-Suche",     desc: "Aktuelle Fakten, Preise, Ereignisse live aus dem Internet" },
    news:       { name: "News",          desc: "Aktuelle Nachrichten zu jedem Thema" },
    wiki:       { name: "Wikipedia",     desc: "Faktenwissen, Definitionen, Biographien" },
    flight:     { name: "Flugstatus",    desc: "Live-Status jedes Flugs — Verspätung, Gate, Terminal" },
    arrivals:   { name: "Ankünfte",      desc: "Ankunftstafel eines Flughafens in Echtzeit" },
    departures: { name: "Abflüge",       desc: "Abflugtafel eines Flughafens in Echtzeit" },
  },

  voice: {
    desc: "Natürliche Sprachgespräche — wie telefonieren mit einer Freundin",
    requires_auth: true,
  },

  memory: {
    desc: "Merkt sich Vorlieben, Name, Gesprächsstil — wird von Session zu Session persönlicher",
    requires_auth: true,
  },

  ai_routing: {
    desc: "Nutzt automatisch die beste KI für jede Aufgabe (GPT-4o, Claude, Gemini)",
    requires_paid: true,
  },

  data_import: {
    desc: "ChatGPT, Claude oder Gemini-Verlauf importieren — kennt dich sofort",
    requires_auth: true,
    sources: ["ChatGPT", "Claude", "Gemini", "PDF", "Word", "PowerPoint"],
  },

  reports: {
    desc: "Zusammenfassungen nach Gesprächen, Meeting-Protokolle, Pitch-Scorecards",
    requires_paid: true,
  },

  languages: {
    desc: "Erkennt automatisch die Sprache und spricht fast alle Sprachen der Welt",
  },

  tiers: [
    { id: "free",    name: "Free",    price: null,  tokens: 50,   highlight: "Text-Chat, Tools, Auto-Modi" },
    { id: "starter", name: "Starter", price: 9.90,  tokens: 300,  highlight: "Voice, Brainstorm, Meeting, Pitch, Memory" },
    { id: "friend",  name: "Friend",  price: 19.90, tokens: 800,  highlight: "Beste-Freundin-Modus, tiefe Personalisierung" },
    { id: "partner", name: "Partner", price: 39.90, tokens: 2000, highlight: "Premium-KI, volle Beziehungsebene, Priorität" },
  ],
};

/** Returns the tool keys from the capabilities registry (for auto-check) */
export function getRegisteredToolKeys() {
  return Object.keys(SOPHIE_CAPABILITIES.tools);
}
