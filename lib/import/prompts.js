// lib/import/prompts.js — Extraction prompts for each AI platform

export const EXTRACTION_PROMPTS = {
  chatgpt: `Liste alles auf was du über mich weißt und gelernt hast. Strukturiere es so:

ARBEIT: Beruf, Rolle, Branche, aktuelle Projekte
KOMMUNIKATION: Wie ich schreibe, welchen Ton ich bevorzuge, Sprache
THEMEN: Wiederkehrende Themen der letzten Monate
PRÄFERENZEN: Was ich mag/nicht mag bei KI-Antworten
PERSÖNLICH: Name, Ort, Interessen, Kontext
PROJEKTE: Laufende Projekte mit Status
MUSTER: Wie ich Probleme angehe, was ich oft frage

Sei vollständig. Lass nichts aus. Formatiere als klare Liste.`,

  claude: `Ich möchte alles exportieren was du über mich gespeichert hast. Bitte liste vollständig auf:

1. Alle gespeicherten Memories über mich
2. Meine Kommunikationspräferenzen
3. Beruflicher Kontext und aktuelle Projekte
4. Wiederkehrende Themen und Muster
5. Persönliche Details die du dir gemerkt hast
6. Wie ich am liebsten arbeite

Formatiere alles als strukturierte Liste. Lass nichts aus.`,

  gemini: `Fasse alles zusammen was du über mich als Person und Nutzer weißt:

- Wer ich bin (Beruf, Kontext, Interessen)
- Wie ich kommuniziere (Stil, Ton, Sprache)
- Woran ich arbeite (Projekte, Ziele)
- Was ich bei KI-Antworten bevorzuge
- Wiederkehrende Themen unserer Gespräche
- Alles weitere was du dir gemerkt hast

Sei so vollständig wie möglich. Strukturierte Liste bitte.`,
};

/**
 * Get the extraction prompt for a given source.
 * @param {'chatgpt' | 'claude' | 'gemini'} source
 * @returns {string}
 */
export function getExtractionPrompt(source) {
  return EXTRACTION_PROMPTS[source] || EXTRACTION_PROMPTS.chatgpt;
}
