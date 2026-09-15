// Smoke tests for lib/token-deduct.js — waterfall free → paid → topup.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTokenDeduction } from "../../lib/token-deduct.js";

test("deducts from free first", () => {
  const r = computeTokenDeduction({ free_tokens_total: 5, free_tokens_used: 2, paid_tokens_total: 10, paid_tokens_used: 0, topup_tokens_balance: 0 }, 1);
  assert.equal(r.ok, true);
  assert.deepEqual(r.updates, { free_tokens_used: 3 });
  assert.equal(r.remaining, 12);
  assert.equal(r.exhausted, false);
});

test("spills over free → paid → topup", () => {
  const r = computeTokenDeduction({ free_tokens_total: 1, free_tokens_used: 0, paid_tokens_total: 1, paid_tokens_used: 0, topup_tokens_balance: 3 }, 4);
  assert.deepEqual(r.updates, { free_tokens_used: 1, paid_tokens_used: 1, topup_tokens_balance: 1 });
  assert.equal(r.remaining, 1);
  assert.equal(r.uncovered, 0);
});

test("exhausted when nothing left", () => {
  const r = computeTokenDeduction({ free_tokens_total: 0, free_tokens_used: 0, paid_tokens_total: 3, paid_tokens_used: 3, topup_tokens_balance: 0 }, 1);
  assert.equal(r.ok, false);
  assert.equal(r.exhausted, true);
  assert.equal(r.updates, null);
});

test("partial coverage reports exhausted and uncovered", () => {
  const r = computeTokenDeduction({ free_tokens_total: 0, free_tokens_used: 0, paid_tokens_total: 0, paid_tokens_used: 0, topup_tokens_balance: 1 }, 2);
  assert.equal(r.ok, true);
  assert.deepEqual(r.updates, { topup_tokens_balance: 0 });
  assert.equal(r.remaining, 0);
  assert.equal(r.exhausted, true);
  assert.equal(r.uncovered, 1);
});

test("last token deducted marks exhausted", () => {
  const r = computeTokenDeduction({ free_tokens_total: 0, free_tokens_used: 0, paid_tokens_total: 1, paid_tokens_used: 0, topup_tokens_balance: 0 }, 1);
  assert.equal(r.remaining, 0);
  assert.equal(r.exhausted, true);
});

test("tolerates missing fields", () => {
  const r = computeTokenDeduction({ topup_tokens_balance: 2 }, 1);
  assert.deepEqual(r.updates, { topup_tokens_balance: 1 });
  assert.equal(r.remaining, 1);
});
