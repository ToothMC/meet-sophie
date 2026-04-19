// Smoke tests for lib/session-title.js
// Run: npm test
//
// Guards against SG-5 regression (keyword-based classification) and basic
// text-cleaning correctness. Pure function, no DB, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSessionTitle, cleanText } from "../../lib/session-title.js";

test("cleanText: collapses whitespace and trims", () => {
  assert.equal(cleanText("  a\n\nb  \tc  "), "a b c");
  assert.equal(cleanText(""), "");
  assert.equal(cleanText(null), "");
  assert.equal(cleanText(undefined), "");
});

test("buildSessionTitle: empty inputs return 'Session'", () => {
  assert.equal(buildSessionTitle(""), "Session");
  assert.equal(buildSessionTitle(null), "Session");
  assert.equal(buildSessionTitle(undefined), "Session");
  assert.equal(buildSessionTitle("   \n  "), "Session");
});

test("buildSessionTitle: strips generic DE/EN prefixes", () => {
  assert.equal(buildSessionTitle("Der Benutzer Gehalt verhandeln"), "Gehalt verhandeln");
  assert.equal(buildSessionTitle("The user salary talk"), "salary talk");
  assert.equal(buildSessionTitle("Conversation about climate"), "climate");
  assert.equal(buildSessionTitle("meeting about Q3 planning"), "Q3 planning");
});

test("buildSessionTitle: NO keyword-based classification (SG-5 regression guard)", () => {
  // Before the SG-5 fix these hardcoded mappings existed:
  //   "salary" → "Salary Negotiation"
  //   "gehalt" → "Gehalt"
  //   "jobrad" → "Jobrad"
  // The audit outlawed keyword classification. Make sure the title reflects
  // the actual input, not a canned enum value.
  assert.notEqual(buildSessionTitle("salary discussion"), "Salary Negotiation");
  assert.notEqual(buildSessionTitle("Gehaltsverhandlung mit Chef"), "Gehalt");
  assert.notEqual(buildSessionTitle("Jobrad-Leasing"), "Jobrad");
  // Output must derive from the input's first clause/sentence.
  assert.equal(buildSessionTitle("Gehaltsverhandlung mit Chef"), "Gehaltsverhandlung mit Chef");
});

test("buildSessionTitle: caps at 40 chars", () => {
  const long = "A very long session title that has way more than forty characters in it";
  const result = buildSessionTitle(long);
  assert.ok(result.length <= 40, `expected ≤40, got ${result.length}`);
  assert.ok(long.startsWith(result.replace(/[.!?,].*$/, "")));
});

test("buildSessionTitle: takes first sentence, not the full paragraph", () => {
  assert.equal(
    buildSessionTitle("Urlaub in Italien. Später andere Themen."),
    "Urlaub in Italien"
  );
  assert.equal(
    buildSessionTitle("Entscheidung treffen! Dann weiterdenken."),
    "Entscheidung treffen"
  );
});

test("buildSessionTitle: splits on first comma", () => {
  assert.equal(buildSessionTitle("Planung Q3, dann Q4 review"), "Planung Q3");
  assert.equal(buildSessionTitle("Idee, Umsetzung, Review"), "Idee");
});

test("buildSessionTitle: trims whitespace in result", () => {
  assert.equal(buildSessionTitle("  Thema  .  Mehr."), "Thema");
});
