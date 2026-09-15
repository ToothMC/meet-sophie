// Smoke tests for the admin exemption from the per-user daily cost cap.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { isBudgetExempt } from "../../lib/ai/cost-tracker.js";

const ADMIN = "c3b78ed1-0000-4000-8000-000000000001";
const OTHER = "11111111-0000-4000-8000-000000000002";

test("exempts exactly the configured admin ids", () => {
  const env = { ADMIN_USER_IDS: ADMIN };
  assert.equal(isBudgetExempt(ADMIN, env), true);
  assert.equal(isBudgetExempt(OTHER, env), false, "a customer must never be exempt");
});

test("handles the list format the admin endpoint already uses", () => {
  const env = { ADMIN_USER_IDS: ` ${OTHER} , ${ADMIN} ,, ` };
  assert.equal(isBudgetExempt(ADMIN, env), true, "spaces and empty entries must not break matching");
  assert.equal(isBudgetExempt(OTHER, env), true);
});

test("fails closed when nothing is configured", () => {
  // An unset variable must not exempt everyone — that would remove the cap entirely.
  for (const env of [{}, { ADMIN_USER_IDS: "" }, { ADMIN_USER_IDS: "   " }, { ADMIN_USER_IDS: ",," }]) {
    assert.equal(isBudgetExempt(ADMIN, env), false, `unset config must not exempt: ${JSON.stringify(env)}`);
    assert.equal(isBudgetExempt(OTHER, env), false);
  }
});

test("an anonymous or missing user is never exempt", () => {
  const env = { ADMIN_USER_IDS: ADMIN };
  for (const id of [null, undefined, "", 0]) {
    assert.equal(isBudgetExempt(id, env), false, `"${id}" must not be exempt`);
  }
});

test("no partial or substring matches", () => {
  const env = { ADMIN_USER_IDS: ADMIN };
  assert.equal(isBudgetExempt(ADMIN.slice(0, 10), env), false, "a prefix must not match");
  assert.equal(isBudgetExempt(ADMIN + "x", env), false, "a longer id must not match");
});
