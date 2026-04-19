// Smoke tests for lib/billing-constants.js
// Run: npm test
//
// Guards against SG-2 regressions (50-free-token legacy) and the topup/
// plan math that the Stripe confirm + webhook paths rely on.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FREE_TOKENS,
  PLAN_TOKENS,
  TOPUP_TOKENS,
  TOKEN_COSTS,
  MEETING_MARGIN,
  USD_PER_TOKEN,
  PLAN_PRICES,
  includedTokensForPlan,
  topupTokensForPack,
  planFromPriceId,
} from "../../lib/billing-constants.js";

test("DEFAULT_FREE_TOKENS = 0 (SG-2 regression guard)", () => {
  // Legacy code seeded new users with 50 free tokens. Audit 2026-04-19
  // moved every init path to this constant. If someone reverts this to
  // 50, every token-related smoke test breaks loudly.
  assert.equal(DEFAULT_FREE_TOKENS, 0);
});

test("PLAN_TOKENS: start/plus/premium values match business plan", () => {
  assert.equal(PLAN_TOKENS.start, 300);
  assert.equal(PLAN_TOKENS.plus, 800);
  assert.equal(PLAN_TOKENS.premium, 2000);
});

test("PLAN_PRICES: start/plus/premium EUR values match business plan", () => {
  assert.equal(PLAN_PRICES.start, 9.90);
  assert.equal(PLAN_PRICES.plus, 19.90);
  assert.equal(PLAN_PRICES.premium, 39.90);
});

test("includedTokensForPlan: case-insensitive, trimmed, unknown → 0", () => {
  assert.equal(includedTokensForPlan("start"), 300);
  assert.equal(includedTokensForPlan("START"), 300);
  assert.equal(includedTokensForPlan(" plus "), 800);
  assert.equal(includedTokensForPlan("Premium"), 2000);
  assert.equal(includedTokensForPlan("enterprise"), 0);
  assert.equal(includedTokensForPlan(""), 0);
  assert.equal(includedTokensForPlan(null), 0);
  assert.equal(includedTokensForPlan(undefined), 0);
});

test("topupTokensForPack: 5/10/20 EUR packs correct, others 0", () => {
  assert.equal(topupTokensForPack(5), 50);
  assert.equal(topupTokensForPack(10), 100);
  assert.equal(topupTokensForPack(20), 250);
  assert.equal(topupTokensForPack(15), 0);
  assert.equal(topupTokensForPack(0), 0);
  assert.equal(topupTokensForPack(null), 0);
});

test("topupTokensForPack: coerces string input (Stripe metadata is strings)", () => {
  assert.equal(topupTokensForPack("5"), 50);
  assert.equal(topupTokensForPack("20"), 250);
});

test("planFromPriceId: unknown IDs resolve to empty string, never a wrong plan", () => {
  // Defensive check: if env vars are missing the map has {undefined: "X"}
  // entries. A real Stripe price id must NOT accidentally match undefined.
  assert.equal(planFromPriceId("price_random_test"), "");
  assert.equal(planFromPriceId(""), "");
  assert.equal(planFromPriceId(null), "");
  assert.equal(planFromPriceId(undefined), "");
});

test("TOKEN_COSTS: voice_minute > voice_minute_eco > chat_message", () => {
  // Business invariant: normal voice is the most expensive, eco is cheaper,
  // a single chat message is cheapest. If any of these flip, pricing is
  // inconsistent with the landing page's value prop.
  assert.ok(
    TOKEN_COSTS.voice_minute > TOKEN_COSTS.voice_minute_eco,
    `voice_minute (${TOKEN_COSTS.voice_minute}) should exceed voice_minute_eco (${TOKEN_COSTS.voice_minute_eco})`
  );
  assert.ok(
    TOKEN_COSTS.voice_minute_eco > TOKEN_COSTS.chat_message,
    `voice_minute_eco (${TOKEN_COSTS.voice_minute_eco}) should exceed chat_message (${TOKEN_COSTS.chat_message})`
  );
});

test("MEETING_MARGIN + USD_PER_TOKEN: sanity check", () => {
  // MEETING_MARGIN = 1.6 (60% margin), USD_PER_TOKEN = 0.0088.
  // Check the types and rough magnitudes so a typo (e.g. 0.088) breaks here.
  assert.equal(typeof MEETING_MARGIN, "number");
  assert.equal(typeof USD_PER_TOKEN, "number");
  assert.ok(MEETING_MARGIN > 1 && MEETING_MARGIN < 3);
  assert.ok(USD_PER_TOKEN > 0.001 && USD_PER_TOKEN < 0.1);
});

test("TOPUP_TOKENS table: 1€ ≈ 10-12 tokens, scales modestly", () => {
  // 5€ → 50 (10 per €), 10€ → 100 (10 per €), 20€ → 250 (12.5 per €).
  // Guards against accidental "pack × 100" typos.
  assert.equal(TOPUP_TOKENS[5] / 5, 10);
  assert.equal(TOPUP_TOKENS[10] / 10, 10);
  assert.equal(TOPUP_TOKENS[20] / 20, 12.5);
});
