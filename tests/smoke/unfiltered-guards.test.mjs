// Smoke tests for lib/unfiltered/guards.js
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { filterByGuards, _internals } from "../../lib/unfiltered/guards.js";

function s(props) {
  return { source: "reddit", publisher: "r/test", headline: "", text: "", ...props };
}

test("KID_PATTERNS: 15-jährige Tochter wird rausgefiltert", () => {
  const out = filterByGuards([
    s({ headline: "Tochter (15) von Promi" }),
    s({ headline: "harmlose meldung über kollegen" }),
  ]);
  assert.equal(out.length, 1);
  assert.match(out[0].headline, /harmlose/);
});

test("KID_PATTERNS: 'teen pregnancy' wird rausgefiltert", () => {
  const out = filterByGuards([
    s({ headline: "Star bestätigt teen pregnancy gerücht" }),
  ]);
  assert.equal(out.length, 0);
});

test("SENSITIVE: 'schwanger' aus boulevard wird gefiltert", () => {
  const out = filterByGuards([
    s({ source: "reddit", headline: "Promi X angeblich schwanger" }),
    s({ source: "rss", publisher: "Promiflash", headline: "Star Y trägt weite Kleider" }),
  ]);
  assert.equal(out.length, 1, "boulevard pregnancy claims out");
  assert.match(out[0].headline, /weite Kleider/);
});

test("SENSITIVE: 'schwanger' aus News-Whitelist (Reuters) bleibt drin", () => {
  const out = filterByGuards([
    s({ source: "reuters.com", publisher: "Reuters", headline: "Premier bestätigt schwanger" }),
  ]);
  assert.equal(out.length, 1, "trusted news source survives");
});

test("SENSITIVE: 'Krebs' aus BBC bleibt, aus Reddit raus", () => {
  const out = filterByGuards([
    s({ source: "bbc.com", publisher: "BBC", headline: "PM cancer diagnosis confirmed" }),
    s({ source: "reddit", publisher: "r/gossip", headline: "everyone thinks X hat krebs" }),
  ]);
  assert.equal(out.length, 1);
  assert.match(out[0].publisher, /BBC/);
});

test("SENSITIVE: 'Suizid' wird aus Reddit gefiltert (gefährliches Thema)", () => {
  const out = filterByGuards([
    s({ source: "reddit", headline: "rumor about suicide attempt" }),
  ]);
  assert.equal(out.length, 0);
});

test("avoid_topics: User-Blocklist case-insensitive", () => {
  const out = filterByGuards([
    s({ headline: "Politik-Streit eskaliert" }),
    s({ headline: "Reality-TV drama" }),
  ], { avoid_topics: ["politik"] });
  assert.equal(out.length, 1);
  assert.match(out[0].headline, /Reality/);
});

test("isTrustedNews matched via publisher substring", () => {
  const { isTrustedNews } = _internals;
  assert.equal(isTrustedNews({ source: "rss", publisher: "Spiegel Online" }), true);
  assert.equal(isTrustedNews({ source: "rss", publisher: "TMZ" }), false);
  assert.equal(isTrustedNews({ source: "news" }), true);
});

test("Defensive: malformed inputs do not crash", () => {
  assert.deepEqual(filterByGuards(null), []);
  assert.deepEqual(filterByGuards(undefined), []);
  assert.deepEqual(filterByGuards("not an array"), []);
  const out = filterByGuards([null, undefined, "string", { /* no fields */ }, s({ headline: "ok" })]);
  assert.equal(out.length, 1);
});

test("Empty avoid_topics array does not filter anything", () => {
  const sig = [s({ headline: "anything" })];
  assert.equal(filterByGuards(sig, { avoid_topics: [] }).length, 1);
  assert.equal(filterByGuards(sig, {}).length, 1);
});

test("KID_PATTERNS: 'kinderstar' wird rausgefiltert auch ohne weitere Zahl", () => {
  const out = filterByGuards([
    s({ headline: "Bekannter kinderstar in Drama" }),
  ]);
  assert.equal(out.length, 0);
});
