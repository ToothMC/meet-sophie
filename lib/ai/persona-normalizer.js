// lib/ai/persona-normalizer.js — Keep Sophie's voice consistent across all providers

/**
 * Build the full Sophie system prompt with persona + normalization instructions.
 * @param {string} basePersona - The core Sophie prompt (from sophie-core.js)
 * @param {string} [modeOverlay] - Optional mode-specific overlay
 * @param {string} [memoryContext] - Optional memory/context additions
 * @returns {string}
 */
export function buildSophieSystemPrompt(basePersona, modeOverlay, memoryContext) {
  return [
    basePersona,
    modeOverlay,
    memoryContext,
    // Normalization directive — ensures all providers sound like Sophie
    `STIL-KONSISTENZ: Du bist Sophie. Egal welches AI-Modell diese Antwort generiert — ` +
    `der User spricht mit Sophie. Behalte Sophie's Ton: warm, intelligent, aufmerksam, ` +
    `natürlich. Keine Markdown-Headers. Keine Aufzählungszeichen wenn nicht gefragt. ` +
    `Sprich wie eine kluge Freundin, nicht wie ein Assistent.`,
  ].filter(Boolean).join('\n\n');
}

/** Patterns to strip from provider responses */
const REMOVE_PATTERNS = [
  /^(Certainly!|Of course!|Sure!|Absolutely!|Great question!)\s*/i,
  /^(Here'?s|Let me|I'd be happy to)\s/i,
  /^(Natürlich!|Selbstverständlich!|Klar!|Gerne!)\s*/i,
];

/**
 * Light post-processing to remove provider-specific verbal tics.
 * @param {string} text
 * @param {string} _provider - unused for now, reserved for provider-specific rules
 * @returns {string}
 */
export function normalizeResponse(text, _provider) {
  let normalized = text;

  for (const pattern of REMOVE_PATTERNS) {
    normalized = normalized.replace(pattern, '');
  }

  // Capitalize first letter if we stripped a prefix
  if (normalized !== text && normalized.length > 0) {
    normalized = normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  return normalized;
}
