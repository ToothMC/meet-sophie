#!/usr/bin/env node
// Generates the landing-page demo report HTML from the shared render function.
// Usage: node scripts/build-demo-report.mjs
// Output is written to stdout. Pipe into index.html or copy-paste.

import { renderReflectionReport } from '../lib/report-templates.js';

const demoSections = [
  {
    type: 'header',
    label: 'Sophie · Gesprächsleitfaden',
    title: 'Gesprächsleitfaden für das Gehaltsgespräch',
    subtitle: 'Michael',
  },
  {
    type: 'summary',
    text: 'Michael bereitet sich auf ein Gehaltsgespräch mit seiner Vorgesetzten am Freitag vor. Im Mittelpunkt steht der Wunsch, klar und ruhig zu kommunizieren, warum eine Gehaltserhöhung gerechtfertigt ist. Dabei geht es nicht nur um die inhaltlichen Argumente, sondern auch um die eigene Haltung im Gespräch: nicht zu weich werden, den roten Faden behalten und die eigene Leistung ohne Rechtfertigungsdruck benennen. Ziel ist ein Gespräch, das sachlich, direkt und verbindlich geführt wird.',
  },
  {
    type: 'insightBox',
    heading: 'Was mir aufgefallen ist',
    items: [
      'Die Kernherausforderung liegt nicht im Fehlen von Argumenten, sondern darin, sie im Gespräch klar und stabil zu vertreten.',
      'Die gewünschte Haltung ist eindeutig: ruhig, konkret und ohne sich kleinzumachen.',
      'Entscheidend ist, dass am Ende nicht nur das Thema angesprochen wurde, sondern auch eine klare Erwartung und ein nächster Schritt im Raum stehen.',
    ],
  },
  {
    type: 'actionCards',
    heading: 'Was ich mitnehme',
    cards: [
      {
        title: 'Klar in die Gehaltsanpassung gehen',
        detail: 'Die eigene Entwicklung, übernommene Verantwortung und konkrete Ergebnisse sollen klar benannt werden — mit dem Ziel, eine Gehaltsanpassung nicht nur anzusprechen, sondern verbindlich zu platzieren.',
      },
    ],
  },
  {
    type: 'highlight',
    heading: 'Kernbotschaft',
    text: 'Ich möchte meine Leistung klar benennen und eine konkrete Gehaltsanpassung ansprechen, ohne mich zu rechtfertigen oder kleinzumachen.',
  },
  {
    type: 'bulletList',
    heading: 'Was ich unbedingt sagen will',
    items: [
      'Ich habe in den letzten 12 Monaten mehr Verantwortung übernommen.',
      'Meine Ergebnisse waren messbar und relevant.',
      'Ich möchte, dass sich diese Entwicklung auch im Gehalt widerspiegelt.',
      'Ich spreche das bewusst klar und direkt an.',
    ],
  },
  {
    type: 'bulletList',
    heading: 'Mein Gesprächsziel',
    items: [
      'dass ich eine Anpassung erwarte',
      'in welchem Rahmen ich sie mir vorstelle',
      'bis wann es eine verbindliche Rückmeldung gibt',
    ],
  },
  {
    type: 'subsections',
    heading: 'Formulierungen, die ich nutzen kann',
    groups: [
      { label: 'Einstieg', lines: ['„Ich möchte heute offen über meine Entwicklung und mein Gehalt sprechen."'] },
      { label: 'Leistungsbezug', lines: ['„Ich habe in den letzten Monaten deutlich mehr Verantwortung übernommen, vor allem bei X und Y."'] },
      { label: 'Konkrete Forderung', lines: ['„Aus meiner Sicht ist jetzt der richtige Zeitpunkt für eine Gehaltsanpassung."'] },
      { label: 'Wenn ausgewichen wird', lines: ['„Mir ist wichtig, dass wir das nicht offen lassen. Wann kann ich mit einer klaren Rückmeldung rechnen?"'] },
    ],
  },
  {
    type: 'qaPairs',
    heading: 'Kritische Momente vorbereiten',
    pairs: [
      {
        q: 'Möglicher Einwand: „Dafür ist aktuell kein Budget da."',
        a: '„Ich verstehe den Rahmen. Trotzdem möchte ich festhalten, dass das Thema aus meiner Sicht berechtigt ist. Welche konkrete Perspektive können Sie mir geben?"',
      },
      {
        q: 'Möglicher Einwand: „Lassen Sie uns das später nochmal anschauen."',
        a: '„Okay. Dann würde ich gerne jetzt schon einen konkreten Zeitpunkt festlegen."',
      },
    ],
  },
  {
    type: 'bulletList',
    heading: 'Worauf ich achten sollte',
    items: [
      'nicht zu schnell reden',
      'nicht anfangen, mich zu entschuldigen',
      'nicht zu viele Nebenthemen aufmachen',
      'nach einer klaren nächsten Verabredung fragen',
    ],
  },
  {
    type: 'actionCards',
    heading: 'Nächste Schritte',
    cards: [
      { title: 'Gespräch am Freitag führen', detail: null },
      { title: 'Ergebnis direkt danach notieren', detail: null },
      { title: 'Falls keine Entscheidung fällt: Follow-up-Termin anfordern', detail: null },
      { title: 'Falls nötig: schriftliche Zusammenfassung senden', detail: null },
    ],
  },
  { type: 'footer' },
];

process.stdout.write(renderReflectionReport(demoSections));
