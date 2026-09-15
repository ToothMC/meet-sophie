// Smoke tests for lib/ai/fact-check.js — post-hoc verification of Sophie's answers.
// Pure parsing plus the orchestration with injected search/provider stubs.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaims, parseVerdict, verifyAnswer, MAX_CLAIMS, LIMITS } from "../../lib/ai/fact-check.js";

test("parseClaims accepts the shape the detector is asked for", () => {
  const out = parseClaims(JSON.stringify({ claims: [{ claim: "Der Satz ist 19%", query: "Mehrwertsteuer Zypern" }] }));
  assert.equal(out.length, 1);
  assert.equal(out[0].claim, "Der Satz ist 19%");
  assert.equal(out[0].query, "Mehrwertsteuer Zypern");
});

test("parseClaims tolerates plain strings and derives a query", () => {
  const out = parseClaims(JSON.stringify({ claims: ["Der Satz ist 19%"] }));
  assert.equal(out.length, 1);
  assert.ok(out[0].query.length > 0, "a claim without a query still has to be searchable");
});

test("parseClaims returns nothing for an answer without checkable claims", () => {
  assert.deepEqual(parseClaims(JSON.stringify({ claims: [] })), []);
  assert.deepEqual(parseClaims("das war nur eine Meinung"), []);
  assert.deepEqual(parseClaims(""), []);
  assert.deepEqual(parseClaims(null), []);
});

test("parseClaims caps how much gets checked", () => {
  const many = { claims: Array.from({ length: 10 }, (_, i) => ({ claim: `c${i}`, query: `q${i}` })) };
  assert.equal(parseClaims(JSON.stringify(many)).length, MAX_CLAIMS);
  const long = { claims: [{ claim: "x".repeat(2000), query: "y".repeat(2000) }] };
  const out = parseClaims(JSON.stringify(long));
  assert.equal(out[0].claim.length, LIMITS.claim);
  assert.equal(out[0].query.length, LIMITS.query);
});

test("parseVerdict: only a contradiction with a usable correction counts", () => {
  const good = parseVerdict(JSON.stringify({ verdict: "contradicted", correction: "Der Satz liegt bei 19%." }));
  assert.equal(good.verdict, "contradicted");
  assert.equal(good.correction, "Der Satz liegt bei 19%.");

  // A contradiction nobody can act on must not interrupt the conversation.
  const empty = parseVerdict(JSON.stringify({ verdict: "contradicted", correction: "" }));
  assert.equal(empty.verdict, "unverifiable");
});

test("parseVerdict falls back to silence on anything unclear", () => {
  for (const raw of ["", "kaputt", JSON.stringify({ verdict: "maybe" }), JSON.stringify({}), null]) {
    assert.equal(parseVerdict(raw).verdict, "unverifiable", `"${raw}" must stay silent`);
  }
  assert.equal(parseVerdict(JSON.stringify({ verdict: "SUPPORTED" })).verdict, "supported");
});

// ── Orchestration: detect → search → verify → filter ───────────────────────
function stub({ claims = [], verdicts = {} } = {}) {
  const seen = { prompts: [], searches: [] };
  const complete = async (messages, _timeout, role) => {
    seen.prompts.push(messages.map(m => m.content).join("\n"));
    if (role === "detect") return { content: JSON.stringify({ claims }) };
    const claim = messages[1].content.match(/BEHAUPTUNG:\n(.*)/)?.[1] || "";
    const v = verdicts[claim] || { verdict: "unverifiable", correction: "" };
    return { content: JSON.stringify(v) };
  };
  const search = async q => { seen.searches.push(q); return { text: "Belege zu " + q, sources: [{ url: "https://example.org" }] }; };
  return { complete, search, seen };
}

test("an answer without checkable claims triggers no search at all", async () => {
  const { complete, search, seen } = stub({ claims: [] });
  const r = await verifyAnswer({ question: "Wie geht es dir?", answer: "Ganz gut, danke.", search, complete });
  assert.deepEqual(r, { checked: 0, corrections: [], verdicts: [] });
  assert.equal(seen.searches.length, 0, "no claims must mean no search cost");
});

test("only contradictions reach the user, supported and unverifiable stay silent", async () => {
  const claims = [
    { claim: "A ist wahr", query: "qA" },
    { claim: "B ist unklar", query: "qB" },
    { claim: "C ist falsch", query: "qC" },
  ];
  const { complete, search, seen } = stub({
    claims,
    verdicts: {
      "A ist wahr": { verdict: "supported", correction: "" },
      "B ist unklar": { verdict: "unverifiable", correction: "" },
      "C ist falsch": { verdict: "contradicted", correction: "Richtig ist D." },
    },
  });
  const r = await verifyAnswer({ question: "F", answer: "A ist wahr, B ist unklar, C ist falsch.", search, complete });
  assert.equal(r.checked, 3);
  assert.deepEqual(seen.searches, ["qA", "qB", "qC"]);
  assert.equal(r.corrections.length, 1);
  assert.equal(r.corrections[0].claim, "C ist falsch");
  assert.equal(r.corrections[0].correction, "Richtig ist D.");
  assert.ok(r.corrections[0].sources.length > 0, "a correction must carry its source");
});

test("a claim the search cannot back up is never turned into a correction", async () => {
  const { complete } = stub({
    claims: [{ claim: "X gilt seit 2026", query: "qX" }],
    verdicts: { "X gilt seit 2026": { verdict: "contradicted", correction: "nein" } },
  });
  const emptySearch = async () => ({ text: "", sources: [] });
  const r = await verifyAnswer({ question: "F", answer: "X gilt seit 2026.", search: emptySearch, complete });
  assert.equal(r.corrections.length, 0, "without evidence there is nothing to contradict with");
  assert.deepEqual(r.verdicts, ["unverifiable"]);
});

test("secrets in the answer never reach the checking model", async () => {
  const { complete, search, seen } = stub({ claims: [] });
  await verifyAnswer({
    question: "Passwort: Sommer2026!",
    answer: "Dein Key sk-abcdefghijklmnopqrstuvwxyz123456 ist hinterlegt.",
    search, complete,
  });
  const all = seen.prompts.join(" ");
  assert.ok(!all.includes("sk-abcdefghijklmnopqrstuvwxyz123456"), "API key must be redacted");
  assert.ok(!all.includes("Sommer2026!"), "password must be redacted");
});

test("works without the user's question — the claims are in her answer", async () => {
  // Regression: the voice client required the user transcript, which arrives
  // asynchronously and lags, so the first turn of a session was never checked.
  const { complete, search, seen } = stub({
    claims: [{ claim: "Die DSGVO gilt seit 2016", query: "DSGVO Inkrafttreten" }],
    verdicts: { "Die DSGVO gilt seit 2016": { verdict: "contradicted", correction: "Sie gilt seit 25. Mai 2018." } },
  });
  const r = await verifyAnswer({ question: "", answer: "Die DSGVO gilt seit 2016.", search, complete });
  assert.equal(r.corrections.length, 1);
  assert.ok(!seen.prompts[0].includes("FRAGE DES NUTZERS"), "no empty question block in the prompt");
});

test("a failing detector degrades to silence, not to an error", async () => {
  const boom = async () => { throw new Error("provider down"); };
  const r = await verifyAnswer({ question: "F", answer: "Irgendeine Aussage.", search: async () => ({ text: "x" }), complete: boom });
  assert.deepEqual(r, { checked: 0, corrections: [], verdicts: [] });
});
