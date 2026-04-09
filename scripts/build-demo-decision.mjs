#!/usr/bin/env node
// Generates the landing-page demo decision protocol HTML.
// Usage: node scripts/build-demo-decision.mjs

import { renderReflectionReport } from '../lib/report-templates.js';

const demoSections = [
  {
    type: 'header',
    label: 'Sophie · Entscheidungsprotokoll',
    title: 'Soll ich kündigen und voll auf mein Projekt setzen?',
    subtitle: 'Entscheidungsprotokoll',
  },
  {
    type: 'summary',
    text: '<strong>Situation:</strong> Soll ich meinen sicheren Job kündigen und mich voll auf mein eigenes Projekt konzentrieren?<br><strong>Ziel:</strong> Eine belastbare Entscheidung treffen statt weiter innerlich zu pendeln<br><strong>Hauptproblem:</strong> Ich schwanke jeden Tag zwischen Mut und Angst',
  },
  {
    type: 'highlight',
    heading: '1. Die eigentliche Entscheidungsfrage',
    text: 'Soll ich in den nächsten 3 Monaten kündigen und mich voll auf mein Projekt konzentrieren — oder noch im Job bleiben und das Risiko reduzieren?',
  },
  {
    type: 'bulletList',
    heading: '2. Was emotional im Hintergrund mitläuft',
    items: [
      'Angst vor Einkommensverlust',
      'Sorge, später zu bereuen, es nicht versucht zu haben',
      'Druck, endlich voranzukommen',
      'Unsicherheit, ob der richtige Zeitpunkt schon da ist',
    ],
  },
  {
    type: 'subsections',
    heading: '3. Option A — Im Job bleiben',
    groups: [
      { label: 'Vorteile', lines: ['finanzielle Sicherheit', 'weniger Druck', 'mehr Zeit zum Validieren'] },
      { label: 'Nachteile', lines: ['langsamer Fortschritt', 'hohe Doppelbelastung', 'Gefahr, sich weiter aufzuschieben'] },
    ],
  },
  {
    type: 'subsections',
    heading: '4. Option B — In 3 Monaten kündigen',
    groups: [
      { label: 'Vorteile', lines: ['voller Fokus', 'schnellere Lernkurve', 'echte Verbindlichkeit'] },
      { label: 'Nachteile', lines: ['finanzielles Risiko', 'emotional höherer Druck', 'mehr Unsicherheit im Alltag'] },
    ],
  },
  {
    type: 'bulletList',
    heading: '5. Was in der Entscheidung wirklich zählt',
    items: [
      'finanzielle Reichweite',
      'Marktfeedback der nächsten 8–12 Wochen',
      'mein Energielevel',
      'realistische Traktion, nicht Wunschdenken',
      'wie viel Risiko ich psychologisch tragen kann',
    ],
  },
  {
    type: 'insightBox',
    heading: '6. Nüchterne Abwägung',
    items: [
      'Aktuell spricht emotional viel für den Sprung.',
      'Sachlich fehlt aber noch eine stabilere Grundlage.',
      'Die stärkere Entscheidung ist deshalb nicht „sofort kündigen", sondern eine klare Zwischenstrategie mit messbaren Kriterien.',
    ],
  },
  {
    type: 'highlight',
    heading: '7. Vorläufige Empfehlung',
    text: 'Noch nicht kündigen. Stattdessen in den nächsten 8 Wochen drei harte Validierungspunkte definieren: X zahlende Gespräche, Y echte Nutzung, Z belastbare Nachfrage-Signale. Wenn diese Punkte erreicht werden, wird die Kündigung deutlich fundierter.',
  },
  {
    type: 'actionCards',
    heading: '8. Nächste Schritte',
    cards: [
      { title: 'Finanzielle Runway sauber ausrechnen', detail: null },
      { title: '8-Wochen-Validierungsplan festlegen', detail: null },
      { title: 'Entscheidungstermin jetzt schon setzen', detail: null },
      { title: 'Bis dahin keine tägliche Neuverhandlung im Kopf', detail: null },
    ],
  },
  { type: 'footer' },
];

process.stdout.write(renderReflectionReport(demoSections));
