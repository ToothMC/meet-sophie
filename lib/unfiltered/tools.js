// lib/unfiltered/tools.js — Realtime Function-Call-Definitionen für
// den Unfiltered-Substate des Talk-Modus.
//
// Architektur:
// - TALK_MODE_GATEWAY_TOOL: ein einziger Tool-Eintrag, der im NORMALEN
//   Talk-Modus aktiv ist. Sophie ruft ihn, wenn der User in Klatsch-/
//   Lästerei-Richtung geht und nach kurzer Rückfrage Ja gesagt hat.
//   Frontend triggert dann den Toggle.
//
// - UNFILTERED_TOOLS: Tools, die nur im aktivierten Unfiltered-Substate
//   verfügbar sind. W2 enthält Stubs/Definitions; die Implementation
//   (save_thread_event Backend, analyze_receipt UI) kommt in W3 bzw. W5.

/**
 * Aktiviert via Sophie selbst nach User-OK ("Sag einfach Ja").
 * Frontend mappt diesen Tool-Call auf POST /api/unfiltered/toggle {active:true}.
 */
export const TALK_MODE_GATEWAY_TOOL = {
  type: "function",
  name: "enable_unfiltered_mode",
  description:
    "Schaltet den Unfiltered-Modus an. NUR aufrufen wenn der User in privates Klatschen/Lästern/Beobachten über reale Personen aus seinem Umfeld geht UND danach explizit Ja gesagt hat auf deine Rückfrage ('Soll ich ungeschönt antworten? Sag einfach Ja.'). NIE ungefragt aktivieren.",
  parameters: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "Kurzer Grund (ein Satz), warum jetzt — z.B. 'User redet über Konflikt mit Schwiegermutter'.",
      },
    },
    required: ["reason"],
  },
};

/**
 * Speichert einen Event in unf_events. W3 implementiert das Backend
 * (api/unfiltered/events.js). In W2 ist es als Stub vorhanden, damit
 * die Toggle-Pipeline schon das richtige Tools-Array liefert.
 */
export const SAVE_THREAD_EVENT_TOOL = {
  type: "function",
  name: "save_thread_event",
  description:
    "Speichert ein einzelnes Vorkommnis (Event) in einer Story-Thread. Wenn thread_id null/leer ist, erzeugst du einen neuen Thread mit dem Titel.",
  parameters: {
    type: "object",
    properties: {
      thread_id: { type: ["string", "null"], description: "UUID eines bestehenden Threads, oder null für neuen." },
      title:     { type: "string", description: "Kurzer Titel des Threads, falls neu (z.B. 'Lisa wirkt komisch bei Anna-Themen')." },
      people:    { type: "array", items: { type: "string" }, description: "Beteiligte Personen (Vornamen)." },
      what:      { type: "string", description: "Was ist passiert? Ein Satz." },
      quote:     { type: ["string", "null"], description: "Falls vorhanden: exakter Wortlaut." },
      user_feeling: { type: ["string", "null"], description: "Wie fühlt sich der User dabei? Ein Wort/Satz." },
      sophie_take:  { type: "string", description: "Deine Lesart in einem Satz." },
      next_watch_signal: { type: ["string", "null"], description: "Worauf soll der User als Nächstes achten?" },
    },
    required: ["people", "what", "sophie_take"],
  },
};

/**
 * Receipts-Check als Voice-Tool. W5 implementiert das Backend.
 */
export const ANALYZE_RECEIPT_TOOL = {
  type: "function",
  name: "analyze_receipt",
  description:
    "Bittet das Frontend, einen Upload-Dialog zu öffnen, damit der User ein Screenshot oder Foto einer Nachricht hochlädt. Wenn das Bild da ist, analysierst du Subtext und Shady-Score.",
  parameters: {
    type: "object",
    properties: {
      purpose: { type: "string", description: "Was soll geprüft werden? Ein Satz." },
    },
    required: ["purpose"],
  },
};

/**
 * Daily Briefing — öffentliche Klatsch-Stories aus geprüften Quellen.
 * Sophie ruft das Tool, wenn der User danach fragt ("was läuft heute?",
 * "neuer Royals-Klatsch?"). Das Frontend liefert die Stories-Liste
 * inklusive Confidence-Layer (bestätigt / Gerücht) zurück, Sophie liest
 * sinngemäss vor.
 */
export const GET_DAILY_BRIEFING_TOOL = {
  type: "function",
  name: "get_daily_briefing",
  description:
    "Holt das heutige Daily Briefing mit aktuellen Klatsch-Stories aus geprüften Quellen. Nur aufrufen wenn der User explizit nach Tagesklatsch / News / Trends / 'was läuft' fragt. Halte dich beim Vorlesen an die Confidence-Tags: 'bestätigt' kannst du als Fakt nennen, 'Gerücht' explizit als Gerücht markieren.",
  parameters: {
    type: "object",
    properties: {
      refresh: { type: "boolean", description: "Wenn true: Cache überspringen und frisch crawlen. Default false." },
    },
  },
};

/**
 * Liefert das Tools-Array für den aktiven Unfiltered-Substate.
 * Wird vom Toggle-Endpoint zurückgegeben und vom Frontend in die
 * session.update gemerged.
 */
export function getUnfilteredTools() {
  return [SAVE_THREAD_EVENT_TOOL, ANALYZE_RECEIPT_TOOL, GET_DAILY_BRIEFING_TOOL];
}
