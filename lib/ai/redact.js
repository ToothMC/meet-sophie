// lib/ai/redact.js — format-based secret/PII redaction applied at every provider boundary.
// Detects the shape of credentials and identifiers, never the intent of the text.

const RULES = [
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, to: '[private-key]' },
  { name: 'jwt',         re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, to: '[token]' },
  { name: 'bearer',      re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g, to: 'Bearer [token]' },
  { name: 'api-key',     re: /\b(?:sk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{16,}|[sp]k_(?:live|test)_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})\b/g, to: '[api-key]' },
  { name: 'cookie-hdr',  re: /\b(Set-Cookie|Cookie)\s*:\s*[^\n]+/gi, to: '$1: [cookie]' },
  { name: 'session-kv',  re: /\b(session_?id|sessionid|sid|auth_?token|access_?token|refresh_?token|api_?key|apikey|secret)\s*[=:]\s*[^\s;&,]{8,}/gi, to: '$1=[token]' },
  { name: 'password',    re: /\b(passwor[dt]|password|passwd|pwd|kennwort|pin)\s*[:=]\s*\S+/gi, to: '$1: [redacted]' },
  { name: 'iban',        re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, to: '[iban]' },
  { name: 'hex-token',   re: /\b[a-fA-F0-9]{32,}\b/g, to: '[token]' },
  { name: 'b64-token',   re: /\b(?=[A-Za-z0-9+/]*\d)(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[A-Z])[A-Za-z0-9+/]{40,}={0,2}/g, to: '[token]' },
  { name: 'email',       re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, to: '[email]' },
];

function luhnValid(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const CARD_CANDIDATE = /\b(?:\d[ -]?){13,19}\b/g;
const PHONE_CANDIDATE = /(?:\+|00)\d{1,3}[\s./-]?(?:\(?\d{1,5}\)?[\s./-]?){2,6}\d{2,}|\b0\d{2,5}[\s./-]?\d{3,}(?:[\s./-]?\d{2,}){0,3}\b/g;

function redactCards(text) {
  let count = 0;
  const out = text.replace(CARD_CANDIDATE, (m) => {
    const digits = m.replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return m;
    count++;
    return '[card]';
  });
  return { text: out, count };
}

function redactPhones(text) {
  let count = 0;
  const out = text.replace(PHONE_CANDIDATE, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) return m;
    count++;
    return '[telefon]';
  });
  return { text: out, count };
}

/**
 * @param {string} input
 * @returns {{ text: string, count: number }}
 */
export function redactSensitive(input) {
  let text = String(input ?? '');
  let count = 0;
  for (const rule of RULES) {
    text = text.replace(rule.re, (...args) => {
      count++;
      const groups = args.slice(1, -2);
      return rule.to.replace(/\$(\d)/g, (_, n) => groups[Number(n) - 1] ?? '');
    });
  }
  const cards = redactCards(text);
  text = cards.text; count += cards.count;
  const phones = redactPhones(text);
  text = phones.text; count += phones.count;
  return { text, count };
}
