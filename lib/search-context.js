// lib/search-context.js — Search Isolation: Kontext-Block für Sophie
// Architecture Rule #1: Sophie ist die einzige Stimme.
// Keine Rohantwort durchreichen, kein answer-Feld.

export function buildSearchContext(searchResult) {
  if (!searchResult?.facts?.length) return '';
  const { facts, confidence } = searchResult;
  const lowConf = confidence < 0.6;
  const factsList = facts.map(f => `- ${f}`).join('\n');
  return `
---
AKTUELLE FAKTEN (interner Kontext):

${factsList}

ANWEISUNGEN:
- Nutze diese Fakten als Informationsbasis.
- Formuliere ausschließlich in deiner eigenen Stimme als Sophie.
- Nenne keine Quellen-URLs, Tool-Namen oder internen Systeme.
- Wenn explizit gefragt ob du aktuelle Daten genutzt hast:
  Antworte ehrlich — "Ja, ich habe aktuelle Informationen einbezogen."
- ${lowConf
    ? 'Verlässlichkeit niedrig — formuliere vorsichtig: "soweit ich weiß", "nach aktuellem Stand".'
    : 'Verlässlichkeit hoch — klar und direkt formulieren.'
  }
---`;
}
