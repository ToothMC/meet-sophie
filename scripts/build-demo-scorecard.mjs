#!/usr/bin/env node
// Generates the landing-page demo scorecard HTML from the shared render function.
// Usage: node scripts/build-demo-scorecard.mjs

import { renderScorecardReport } from '../lib/report-templates.js';

const demo = {
  title: 'Pitch-Scorecard',
  situation: 'Gründer pitcht seine AI-Meeting-Software vor einem potenziellen Investor',
  goal: 'Klarer, relevanter und überzeugender auftreten',
  mainProblem: 'Der Pitch klingt zu breit und erklärt zu viel auf einmal',
  overallScore: 72,
  confidence: 'high',
  categories: [
    {
      label: 'Content', weight: 60,
      metrics: [
        { name: 'Clarity', score: 2.5, desc: 'Die Kernidee wird erst zu spät verständlich.' },
        { name: 'Problem Sharpness', score: 3.0, desc: 'Das Problem ist relevant, aber noch nicht hart genug zugespitzt.' },
        { name: 'Value Proposition', score: 2.0, desc: 'Der konkrete Nutzen bleibt zu allgemein und nicht scharf genug.' },
        { name: 'Structure', score: 2.5, desc: 'Der Pitch wirkt etwas sprunghaft und nicht klar geführt.' },
        { name: 'Differentiation', score: 3.0, desc: 'Die Einzigartigkeit ist erkennbar, aber nicht stark genug herausgearbeitet.' },
        { name: 'Credibility', score: 3.0, desc: 'Es gibt Ansätze, aber noch zu wenig belastbare Substanz.' },
        { name: 'Audience Fit', score: 3.0, desc: 'Der Pitch ist noch nicht präzise genug auf Investoren zugeschnitten.' },
      ],
    },
    {
      label: 'Delivery', weight: 40,
      metrics: [
        { name: 'Opening', score: 3.5, desc: 'Der Einstieg funktioniert, ist aber noch nicht scharf genug.' },
        { name: 'Closing', score: 3.0, desc: 'Das Ende bleibt etwas offen und setzt keinen starken Schlusspunkt.' },
        { name: 'Voice & Rhythm', score: 3.5, desc: 'Der Vortrag klingt solide, aber stellenweise monoton.' },
        { name: 'Rhetoric & Language', score: 3.5, desc: 'Die Sprache ist ordentlich, aber noch nicht pointiert genug.' },
        { name: 'Authenticity', score: 3.0, desc: 'Die Wirkung ist glaubwürdig, aber noch nicht durchgehend stark.' },
        { name: 'Persuasiveness', score: 3.0, desc: 'Die Richtung stimmt, aber der Zug nach vorn fehlt.' },
      ],
    },
  ],
  verdictText: 'Der Pitch hat Potenzial, verliert aber Wirkung durch Breite, fehlende Zuspitzung und einen noch zu weichen Nutzen. Für einen Investor-Pitch braucht es mehr Klarheit, mehr Relevanz und einen stärkeren Spannungsbogen.',
  strengths: [
    'Das Problem wirkt nicht erfunden',
    'Es gibt ein relevantes Anwendungsfeld',
    'Der Pitch hat Substanz',
  ],
  weaknesses: [
    'Zu viele Erklärungen am Anfang',
    'Nutzen wird nicht schnell genug greifbar',
    'Kein starker Satz, der hängen bleibt',
  ],
  nextSteps: [
    'Einstieg deutlich kürzen und schneller zum Schmerz kommen',
    'Nutzen in einem klaren Satz formulieren',
    'Pitch stärker auf Investor-Logik zuschneiden',
    'Abschluss mit klarem Takeaway schärfen',
  ],
};

process.stdout.write(renderScorecardReport(demo));
