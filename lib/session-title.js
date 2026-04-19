// lib/session-title.js — Pure helpers for normalizing free-form text
// into compact session titles. Extracted from api/memory-update.js so
// the logic is testable without the whole memory-update dependency graph.
//
// No side effects, no imports — safe to use from tests.

export function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

// Generates a short, clean session title from free-form text.
// After SG-5 (audit 2026-04-19) this function MUST NOT do keyword-
// based classification. It only strips boilerplate prefixes and keeps
// the first clause, capped at 40 chars. Hardcoded topic mappings
// (jobrad/gehalt/salary/…) are forbidden — title generation belongs
// to the AI layer upstream.
export function buildSessionTitle(value = "") {
  const text = cleanText(value);

  if (!text) return "Session";

  const cleaned = text
    .replace(/^der benutzer\s+/i, "")
    .replace(/^the user\s+/i, "")
    .replace(/^user\s+/i, "")
    .replace(/^conversation about\s+/i, "")
    .replace(/^meeting about\s+/i, "")
    .replace(/^discussion about\s+/i, "")
    .trim();

  const firstChunk = cleaned
    .split(/[.!?]/)[0]
    .split(",")[0]
    .trim()
    .slice(0, 40);

  return firstChunk || "Session";
}
