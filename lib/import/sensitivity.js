// lib/import/sensitivity.js — Classify sensitivity of imported content

const CONFIDENTIAL_PATTERNS = [
  /gehalt|salary|einkommen|income/i,
  /passwort|password|token|secret|api.?key/i,
  /kreditkarte|credit.?card|iban|bank/i,
  /krankheit|diagnosis|gesundheit|health/i,
  /steuern|tax|sozialversicherung/i,
];

const VERY_CONFIDENTIAL_PATTERNS = [
  /steuer.?id|sozialversicherungsnummer|ssn/i,
  /ausweis|passport|personalausweis/i,
  /medikament|medication|therapie|therapy/i,
];

/**
 * Classify the sensitivity of a piece of content.
 * @param {string} content
 * @returns {'standard' | 'confidential' | 'very_confidential'}
 */
export function classifySensitivity(content) {
  if (!content) return 'standard';
  const text = typeof content === 'string' ? content : JSON.stringify(content);

  if (VERY_CONFIDENTIAL_PATTERNS.some(p => p.test(text))) return 'very_confidential';
  if (CONFIDENTIAL_PATTERNS.some(p => p.test(text))) return 'confidential';
  return 'standard';
}
