// lib/billing-constants.js — Central token/billing configuration
// Single source of truth for all plan definitions, token amounts, and costs.

// Token allocations per subscription plan
export const PLAN_TOKENS = {
  free: 50,
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
export const TOKEN_COSTS = {
  chat_message: 1,
  chat_file_upload: 2, // message with file attachment (image/document)
  voice_minute: 10,    // = 1 token per 6 seconds
  compare: 4,
  challenge: 2,
};

// Default free allocation for new users
export const DEFAULT_FREE_TOKENS = 50;

// Seconds per token for voice timer conversion (10 tokens/min = 6 seconds/token)
export const SECONDS_PER_TOKEN = 6;

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
