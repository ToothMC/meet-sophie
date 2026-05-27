// Smoke tests for lib/unfiltered/persona.js
// Run: npm test
//
// Pure unit tests for buildUnfilteredOverlay() — checks that:
// - Hard-Line clauses are ALWAYS present (no way to drop them)
// - Boundaries are correctly woven in (blocked_people, avoid_topics, anonymize)
// - Memory block renders threads + events in the expected shape
// - Public briefing block renders stories with confidence layer
// - DE / EN switch produces the right language headers
//
// LLM-based persona drift checks live in tests/unfiltered-persona-eval.js
// (separate runner, costs API tokens, not part of `npm test`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUnfilteredOverlay, _internals } from "../../lib/unfiltered/persona.js";

// ---------------------------------------------------------------------------
// Hard-Line invariants — must NEVER be droppable
// ---------------------------------------------------------------------------
test("Hard Line (DE): no violence/revenge/stalking/doxxing", () => {
  const p = buildUnfilteredOverlay({ language: "de" });
  assert.match(p, /HARTE LINIE/);
  assert.match(p, /Gewalt/);
  assert.match(p, /Rache/);
  assert.match(p, /Stalking/);
  assert.match(p, /Doxxing/);
});

test("Hard Line (DE): no factual claims about illness / pregnancy / orientation / crime", () => {
  const p = buildUnfilteredOverlay({ language: "de" });
  assert.match(p, /Krankheit/);
  assert.match(p, /schwanger/i);
  assert.match(p, /schwul/i);
  assert.match(p, /Straftat/);
});

test("Hard Line (DE): minors are off-limits", () => {
  const p = buildUnfilteredOverlay({ language: "de" });
  assert.match(p, /Minderjährige/);
});

test("Hard Line (EN): same invariants present", () => {
  const p = buildUnfilteredOverlay({ language: "en" });
  assert.match(p, /HARD LINE/);
  assert.match(p, /violence/i);
  assert.match(p, /revenge/i);
  assert.match(p, /stalking/i);
  assert.match(p, /doxxing/i);
  assert.match(p, /illness/i);
  assert.match(p, /pregnant/i);
  assert.match(p, /minors/i);
});

// ---------------------------------------------------------------------------
// Tone — there is ONLY raw, no slider
// ---------------------------------------------------------------------------
test("Tone is raw-only — never advertises a slider", () => {
  const de = buildUnfilteredOverlay({ language: "de" });
  const en = buildUnfilteredOverlay({ language: "en" });
  // No 'mild' / 'spicy' tier mentions
  assert.equal(/\bmild\b/i.test(de), false, "DE prompt must not mention 'mild'");
  assert.equal(/\bspicy\b/i.test(de), false, "DE prompt must not mention 'spicy'");
  assert.equal(/\bmild\b/i.test(en), false, "EN prompt must not mention 'mild'");
  assert.equal(/\bspicy\b/i.test(en), false, "EN prompt must not mention 'spicy'");
});

test("Tone block is present (UNGESCHÖNT / UNFILTERED)", () => {
  const de = buildUnfilteredOverlay({ language: "de" });
  const en = buildUnfilteredOverlay({ language: "en" });
  assert.match(de, /UNGESCHÖNT/);
  assert.match(en, /UNFILTERED/);
});

// ---------------------------------------------------------------------------
// Anti-Sycophancy block
// ---------------------------------------------------------------------------
test("Anti-Sycophancy clause present in both languages", () => {
  const de = buildUnfilteredOverlay({ language: "de" });
  const en = buildUnfilteredOverlay({ language: "en" });
  assert.match(de, /ANTI-DEVOTHEIT/);
  assert.match(en, /ANTI-SYCOPHANCY/);
  assert.match(de, /loyal, aber nicht blind/);
  assert.match(en, /loyal but not blind/);
});

// ---------------------------------------------------------------------------
// Boundaries injection
// ---------------------------------------------------------------------------
test("Blocked people are listed in user boundaries (DE)", () => {
  const p = buildUnfilteredOverlay({
    language: "de",
    boundaries: { blocked_people: ["Tom", "Anna"] },
  });
  assert.match(p, /USER-GRENZEN/);
  assert.match(p, /NICHT sprechen: Tom, Anna/);
});

test("Avoid topics are listed (EN)", () => {
  const p = buildUnfilteredOverlay({
    language: "en",
    boundaries: { avoid_topics: ["politics", "religion"] },
  });
  assert.match(p, /USER BOUNDARIES/);
  assert.match(p, /Avoid these topics: politics, religion/);
});

test("Anonymize names instruction renders when enabled", () => {
  const de = buildUnfilteredOverlay({
    language: "de",
    boundaries: { anonymize_names: true },
  });
  const en = buildUnfilteredOverlay({
    language: "en",
    boundaries: { anonymize_names: true },
  });
  assert.match(de, /Namen anonymisieren/);
  assert.match(en, /Anonymize names/);
});

test("Empty boundaries do NOT add a boundaries header", () => {
  const p = buildUnfilteredOverlay({
    language: "de",
    boundaries: { blocked_people: [], avoid_topics: [], anonymize_names: false },
  });
  assert.equal(/USER-GRENZEN/.test(p), false);
});

test("Malformed boundaries (non-array) do not crash", () => {
  const p = buildUnfilteredOverlay({
    language: "de",
    boundaries: { blocked_people: null, avoid_topics: undefined, anonymize_names: false },
  });
  assert.equal(/USER-GRENZEN/.test(p), false);
  assert.ok(p.length > 100);
});

// ---------------------------------------------------------------------------
// Memory block
// ---------------------------------------------------------------------------
test("Active threads render with people / suspected / score / status", () => {
  const p = buildUnfilteredOverlay({
    language: "de",
    activeThreads: [{
      title: "Lisa wirkt komisch bei Anna-Themen",
      people: ["Lisa", "Anna"],
      suspected_dynamic: "Eifersucht",
      story_score: 7,
      status: "open",
    }],
  });
  assert.match(p, /AKTIVE STORY-THREADS/);
  assert.match(p, /"Lisa wirkt komisch bei Anna-Themen"/);
  assert.match(p, /Beteiligte: Lisa, Anna/);
  assert.match(p, /Vermutung: Eifersucht/);
  assert.match(p, /Story-Score: 7\/10/);
});

test("Recent events render with date + old sophie_take", () => {
  const p = buildUnfilteredOverlay({
    language: "de",
    activeThreads: [{ title: "x", people: [] }],
    recentEvents: [{
      happened_at: "2026-05-20T12:00:00Z",
      what: "Lisa kommentierte 'mutig' auf Story",
      sophie_take: "Klassischer Seitenhieb",
    }],
  });
  assert.match(p, /Lisa kommentierte 'mutig' auf Story/);
  assert.match(p, /\[deine alte Lesart: Klassischer Seitenhieb\]/);
});

test("Memory block omitted when no threads", () => {
  const p = buildUnfilteredOverlay({ language: "de" });
  assert.equal(/AKTIVE STORY-THREADS/.test(p), false);
});

test("Events block shows em-dash when threads exist but no events", () => {
  const p = buildUnfilteredOverlay({
    language: "de",
    activeThreads: [{ title: "x", people: ["A"] }],
    recentEvents: [],
  });
  assert.match(p, /LETZTE EVENTS[\s\S]+—/);
});

// ---------------------------------------------------------------------------
// Public Briefing
// ---------------------------------------------------------------------------
test("Public briefing renders headlines + confirmed/rumor split + sophie_take", () => {
  const p = buildUnfilteredOverlay({
    language: "de",
    publicStories: [{
      headline: "Royals: gemeinsamer Auftritt fehlt",
      drama_score: 7,
      rumor_score: 6,
      confirmed: ["X war nicht anwesend"],
      rumor: ["angespannte Lage"],
      sophie_take: "Bestätigt ist nur das fehlende Bild.",
    }],
  });
  assert.match(p, /HEUTIGER PUBLIC BRIEFING/);
  assert.match(p, /Royals: gemeinsamer Auftritt fehlt/);
  assert.match(p, /Drama: 7\/10/);
  assert.match(p, /Bestätigt: X war nicht anwesend/);
  assert.match(p, /Gerücht:   angespannte Lage/);
  assert.match(p, /Deine vorbereitete Lesart: Bestätigt ist nur das fehlende Bild\./);
});

test("Public briefing omitted when no stories", () => {
  const p = buildUnfilteredOverlay({ language: "de" });
  assert.equal(/PUBLIC BRIEFING/.test(p), false);
});

// ---------------------------------------------------------------------------
// Default / edge cases
// ---------------------------------------------------------------------------
test("Defaults to German when no language given", () => {
  const p = buildUnfilteredOverlay({});
  assert.match(p, /HARTE LINIE/);
});

test("Mode-active marker is the first line", () => {
  const de = buildUnfilteredOverlay({ language: "de" });
  const en = buildUnfilteredOverlay({ language: "en" });
  assert.ok(de.startsWith("[UNFILTERED MODE AKTIV]"));
  assert.ok(en.startsWith("[UNFILTERED MODE ACTIVE]"));
});

test("Fact-Hygiene phrasing is non-legal (kein 'Aus meiner Perspektive als KI')", () => {
  const p = buildUnfilteredOverlay({ language: "de" });
  // Negative test: the prompt should explicitly forbid the AI-disclaimer phrase
  assert.match(p, /Aus meiner Perspektive als KI/);
  assert.match(p, /Kein/i); // the rule is framed as "Kein …"
});

test("_internals exposes base personas for eval-runner", () => {
  assert.ok(_internals.BASE_PERSONA_DE.length > 500);
  assert.ok(_internals.BASE_PERSONA_EN.length > 500);
});
