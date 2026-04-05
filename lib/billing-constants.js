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
// Calibrated for ~60% gross margin on Premium tier ($0.0088 API cost per token)
export const TOKEN_COSTS = {
  chat_message: 1,
  chat_file_upload: 2, // message with file attachment (image/document)
  voice_minute: 20,    // = 1 token per 3 seconds (~$0.17/min realtime cost)
  voice_minute_eco: 8, // Eco: gpt-realtime-mini (~$0.07/min) → 2.5× more talk time
  compare: 1,
  challenge: 1,
  pitch_render: 25,    // ElevenLabs TTS (~$0.24 per 2k-char pitch, flat rate)
};

// Default free allocation for new users
export const DEFAULT_FREE_TOKENS = 50;

// Seconds per token for voice timer conversion
export const SECONDS_PER_TOKEN = 3;       // Normal: 20 tokens/min
export const SECONDS_PER_TOKEN_ECO = 7.5; // Eco: 8 tokens/min

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
