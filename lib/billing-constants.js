// lib/billing-constants.js — Central token/billing configuration
// Single source of truth for all plan definitions, token amounts, and costs.

// Token allocations per subscription plan
export const PLAN_TOKENS = {
  start: 300,
  plus: 800,
  premium: 2000,
};

// Top-up token amounts (key = EUR price)
export const TOPUP_TOKENS = {
  5: 50,
  10: 100,
  20: 250,
};

// Token costs per action
// Calibrated for ~60% gross margin on Premium tier ($0.0088 API cost per token)
export const TOKEN_COSTS = {
  chat_message: 1,
  chat_file_upload: 2, // message with file attachment (image/document)
  voice_minute: 20,    // = 1 token per 3 seconds (~$0.17/min realtime cost)
  voice_minute_eco: 8, // Eco: gpt-realtime-mini (~$0.07/min) → 2.5× more talk time
  compare: 1,
  challenge: 1,
  meeting_start: 1,    // Entry cost per meeting creation (atomically deducted)
};

// Default free allocation for new users (legacy: was 50, now 0 — free plan removed)
export const DEFAULT_FREE_TOKENS = 0;

// Seconds per token for voice timer conversion
export const SECONDS_PER_TOKEN = 3;       // Normal: 20 tokens/min
export const SECONDS_PER_TOKEN_ECO = 7.5; // Eco: 8 tokens/min

// Meeting listening — UI estimation only, NOT billing truth
// Real billing uses server-measured costs via meeting_billing_checkpoint RPC
export const SECONDS_PER_TOKEN_MEETING_LISTEN = 300; // 1 Token / 5 min (conservative)

// Meeting margin multiplier: cost USD → token conversion
export const MEETING_MARGIN = 1.6; // 60% margin, same as other modes

// USD per token (inverse of TOKEN_COSTS calibration)
export const USD_PER_TOKEN = 0.0088;

// Plan prices in EUR (for admin/revenue calculations)
export const PLAN_PRICES = {
  start: 9.90,
  plus: 19.90,
  premium: 39.90,
};

// Map Stripe price ID → plan name
export function planFromPriceId(priceId) {
  if (!priceId) return "";
  const map = {
    [process.env.STRIPE_PRICE_ID_START]: "start",
    [process.env.STRIPE_PRICE_ID_PLUS_V2 || process.env.STRIPE_PRICE_ID_PLUS]: "plus",
    [process.env.STRIPE_PRICE_ID_PREMIUM]: "premium",
    // Backward compat: old price IDs
    [process.env.STRIPE_PRICE_ID_STARTER]: "start",
  };
  return map[priceId] || "";
}

// Included tokens for a plan (monthly reset amount)
export function includedTokensForPlan(plan) {
  const p = String(plan || "").toLowerCase().trim();
  return PLAN_TOKENS[p] || 0;
}

// Tokens granted for a top-up pack (by EUR amount)
export function topupTokensForPack(pack) {
  const k = Number(pack);
  return TOPUP_TOKENS[k] || 0;
}

// Single source of truth for "is this subscription premium right now?".
//
// Bug fix (2026-08-20): `user_subscriptions.is_active` is a snapshot written by the
// Stripe webhook (checkout / subscription.updated) and never re-checked afterwards.
// If Stripe transitions a subscription out of "trialing" (trial ends, card charged
// or declined) but the `customer.subscription.updated` webhook never arrives — e.g.
// endpoint not subscribed to that event — `is_active` stays stuck `true` forever and
// every `is_active || status === "active"` check across the app kept granting free
// premium access past the trial. This helper adds an explicit trial-expiry check that
// overrides a stale `is_active` flag; it does NOT change behavior for any other status.
//
// Expects a row with at least { status, is_active, trial_end }.
export function isSubscriptionActive(sub) {
  if (!sub) return false;
  const status = sub.status || null;
  if (status === "trialing") {
    // Expired trial overrides a stale is_active flag — this is the actual fix.
    if (sub.trial_end && new Date(sub.trial_end).getTime() <= Date.now()) return false;
    return true;
  }
  if (status === "active") return true;
  // Any other/legacy status (canceled, past_due, incomplete_expired, null, ...):
  // fall back to the stored flag, unchanged from previous behavior.
  return !!sub.is_active;
}
