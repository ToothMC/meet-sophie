// api/billing.js — Konsolidierter Billing-Endpoint
// ?action=checkout  → create-checkout-session
// ?action=portal    → create-portal-session
// ?action=topup     → create-topup-session
// ?action=confirm   → confirm-checkout

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Helpers (aus confirm-checkout.js)
// ---------------------------------------------------------------------------

const DEFAULT_FREE_SECONDS_TOTAL = 120;

function includedSecondsForPlan(plan) {
  const p = String(plan || "").toLowerCase().trim();
  if (p === "starter") return 15 * 60;
  if (p === "plus") return 25 * 60;
  return 0;
}

function topupSecondsForPack(pack) {
  const k = Number(pack);
  if (k === 5) return 5 * 60;
  if (k === 10) return 10 * 60;
  if (k === 20) return 20 * 60;
  return 0;
}

function planFromPriceId(priceId) {
  const starter = process.env.STRIPE_PRICE_ID_STARTER;
  const plus = process.env.STRIPE_PRICE_ID_PLUS;
  if (starter && priceId === starter) return "starter";
  if (plus && priceId === plus) return "plus";
  return "";
}

async function safeTrack(supabase, userId, event_name, meta = {}) {
  try {
    if (!userId) return;
    await supabase.from("analytics_events").insert({ user_id: userId, event_name, meta });
  } catch (e) {
    console.warn("Analytics insert failed:", e?.message || e);
  }
}

async function alreadyProcessed(supabase, sessionId) {
  const { data, error } = await supabase
    .from("analytics_events")
    .select("id")
    .eq("event_name", "checkout_confirmed")
    .contains("meta", { checkout_session_id: sessionId })
    .limit(1);
  if (error) {
    console.warn("Idempotency lookup failed:", error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

// ---------------------------------------------------------------------------
// Action: checkout (create-checkout-session)
// ---------------------------------------------------------------------------

async function handleCheckout(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    let bodyJson = req.body;
    if (typeof bodyJson === "string") {
      try { bodyJson = JSON.parse(bodyJson); } catch { bodyJson = {}; }
    }
    bodyJson = bodyJson && typeof bodyJson === "object" ? bodyJson : {};

    const authHeader = req.headers.authorization || "";
    const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!accessToken) return res.status(401).json({ error: "Missing Authorization Bearer token" });

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) {
      return res.status(500).json({ error: "Missing Supabase server env vars" });
    }

    const userResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${accessToken}`, apikey: serviceRoleKey },
    });
    if (!userResp.ok) {
      const t = await userResp.text();
      return res.status(401).json({ error: "Invalid token", detail: t });
    }
    const user = await userResp.json();
    const userId = user?.id;
    if (!userId) return res.status(401).json({ error: "User not found" });

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });

    const { plan, legal } = bodyJson || {};
    const p = String(plan || "").toLowerCase().trim();

    const priceId =
      p === "starter" ? process.env.STRIPE_PRICE_ID_STARTER :
      p === "plus"    ? process.env.STRIPE_PRICE_ID_PLUS :
      null;

    if (!priceId) {
      return res.status(400).json({ error: "Missing/invalid plan. Use { plan: 'starter' | 'plus' }" });
    }

    const TERMS_VERSION   = "2026-03-03";
    const PRIVACY_VERSION = "2026-03-03";
    const WAIVER_VERSION  = "2026-03-03";

    const termsAccepted   = !!legal?.termsAccepted;
    const privacyAccepted = !!legal?.privacyAccepted;
    const waiverAccepted  = !!legal?.waiverAccepted;
    const lang = typeof legal?.lang === "string" ? legal.lang.slice(0, 2).toLowerCase() : null;

    if (!termsAccepted || !privacyAccepted) {
      return res.status(400).json({ error: "Legal acceptance required: terms/privacy" });
    }
    if (!waiverAccepted) {
      return res.status(400).json({ error: "Legal acceptance required: withdrawal waiver" });
    }

    const origin = (process.env.APP_BASE_URL || `https://${process.env.VERCEL_URL || "www.meet-sophie.com"}`).replace(/\/+$/, "");

    const ip = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() || null;
    const userAgent = (req.headers["user-agent"] || "").toString().slice(0, 300) || null;

    const acceptInsert = {
      user_id: userId, event: "checkout_start", plan: p, lang,
      terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION, waiver_version: WAIVER_VERSION,
      terms_accepted: true, privacy_accepted: true, waiver_accepted: true,
      origin, user_agent: userAgent, ip,
    };

    const supaInsertResp = await fetch(
      `${supabaseUrl}/rest/v1/legal_acceptances?on_conflict=user_id,event,terms_version,privacy_version,waiver_version,plan`,
      {
        method: "POST",
        headers: {
          apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(acceptInsert),
      }
    );
    if (!supaInsertResp.ok) {
      const t = await supaInsertResp.text();
      return res.status(500).json({ error: "Failed to store legal acceptance", detail: t });
    }

    const successUrl = `${origin}/success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl  = `${origin}/pricing?canceled=1`;

    const stripeBody = new URLSearchParams();
    stripeBody.append("mode", "subscription");
    stripeBody.append("success_url", successUrl);
    stripeBody.append("cancel_url", cancelUrl);
    stripeBody.append("line_items[0][price]", priceId);
    stripeBody.append("line_items[0][quantity]", "1");
    stripeBody.append("client_reference_id", userId);
    stripeBody.append("metadata[user_id]", userId);
    stripeBody.append("metadata[plan]", p);
    stripeBody.append("metadata[terms_version]", TERMS_VERSION);
    stripeBody.append("metadata[privacy_version]", PRIVACY_VERSION);
    stripeBody.append("metadata[waiver_version]", WAIVER_VERSION);
    stripeBody.append("subscription_data[metadata][user_id]", userId);
    stripeBody.append("subscription_data[metadata][plan]", p);
    stripeBody.append("subscription_data[metadata][terms_version]", TERMS_VERSION);
    stripeBody.append("subscription_data[metadata][privacy_version]", PRIVACY_VERSION);
    stripeBody.append("subscription_data[metadata][waiver_version]", WAIVER_VERSION);
    if (user?.email) stripeBody.append("customer_email", user.email);

    const stripeResp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${stripeKey}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: stripeBody,
    });
    const stripeJson = await stripeResp.json();
    if (!stripeResp.ok) {
      return res.status(stripeResp.status).json({ error: "Stripe error", detail: stripeJson });
    }
    if (!stripeJson?.url) {
      return res.status(500).json({ error: "Stripe error: missing checkout url", detail: stripeJson });
    }
    return res.status(200).json({ url: stripeJson.url });
  } catch (err) {
    console.error("billing/checkout error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ---------------------------------------------------------------------------
// Action: portal (create-portal-session)
// ---------------------------------------------------------------------------

async function handlePortal(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing Authorization Bearer token" });

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" });
    }
    if (!process.env.SUPABASE_ANON_KEY) {
      return res.status(500).json({ error: "Missing SUPABASE_ANON_KEY" });
    }
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-01-28.clover" });

    const supabaseUser = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: userData, error: userErr } = await supabaseUser.auth.getUser();
    if (userErr || !userData?.user?.id) return res.status(401).json({ error: "Invalid token" });
    const user_id = userData.user.id;

    const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: sub, error: subErr } = await supabaseAdmin
      .from("user_subscriptions")
      .select("stripe_customer_id, status, plan")
      .eq("user_id", user_id)
      .maybeSingle();
    if (subErr) return res.status(500).json({ error: "DB error", detail: subErr.message });
    if (!sub?.stripe_customer_id) {
      return res.status(404).json({ error: "No subscription customer" });
    }

    const baseUrl    = (process.env.APP_BASE_URL || `https://${process.env.VERCEL_URL || "www.meet-sophie.com"}`).replace(/\/+$/, "");
    const return_url = `${baseUrl}/talk/`;

    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url,
    });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    return res.status(500).json({ error: "Stripe portal error", detail: String(e?.message || e) });
  }
}

// ---------------------------------------------------------------------------
// Action: topup (create-topup-session)
// ---------------------------------------------------------------------------

async function handleTopup(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    const authHeader  = req.headers.authorization || "";
    const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!accessToken) return res.status(401).json({ error: "Missing Authorization Bearer token" });

    const supabaseUrl    = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) {
      return res.status(500).json({ error: "Missing Supabase server env vars" });
    }

    const userResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${accessToken}`, apikey: serviceRoleKey },
    });
    if (!userResp.ok) {
      const t = await userResp.text();
      return res.status(401).json({ error: "Invalid token", detail: t });
    }
    const user   = await userResp.json();
    const userId = user?.id;
    if (!userId) return res.status(401).json({ error: "User not found" });

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });

    let bodyJson = req.body;
    if (typeof bodyJson === "string") {
      try { bodyJson = JSON.parse(bodyJson); } catch { bodyJson = {}; }
    }
    const { pack } = bodyJson || {};
    const k = Number(pack);

    const priceId =
      k === 5  ? process.env.STRIPE_PRICE_ID_TOPUP_5  :
      k === 10 ? process.env.STRIPE_PRICE_ID_TOPUP_10 :
      k === 20 ? process.env.STRIPE_PRICE_ID_TOPUP_20 :
      null;

    if (!priceId) {
      return res.status(400).json({ error: "Invalid pack. Use { pack: 5 | 10 | 20 }" });
    }

    const origin     = req.headers.origin || "https://meet-sophie.com";
    const successUrl = `${origin}/success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl  = `${origin}/pricing`;

    const body = new URLSearchParams();
    body.append("mode", "payment");
    body.append("success_url", successUrl);
    body.append("cancel_url", cancelUrl);
    body.append("line_items[0][price]", priceId);
    body.append("line_items[0][quantity]", "1");
    body.append("metadata[user_id]", userId);
    body.append("metadata[topup_pack]", String(k));
    if (user?.email) body.append("customer_email", user.email);

    const stripeResp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${stripeKey}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const stripeJson = await stripeResp.json();
    if (!stripeResp.ok) {
      return res.status(500).json({ error: "Stripe error", detail: stripeJson });
    }
    return res.status(200).json({ url: stripeJson.url });
  } catch (err) {
    console.error("billing/topup error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ---------------------------------------------------------------------------
// Action: confirm (confirm-checkout)
// ---------------------------------------------------------------------------

async function handleConfirm(req, res) {
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const stripeKey    = process.env.STRIPE_SECRET_KEY;
    const supabaseUrl  = process.env.SUPABASE_URL;
    const serviceKey   = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!stripeKey) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });
    if (!supabaseUrl || !serviceKey) {
      return res.status(500).json({ error: "Missing Supabase env vars" });
    }

    const stripe   = new Stripe(stripeKey, { apiVersion: "2024-06-20" });
    const supabase = createClient(supabaseUrl, serviceKey);

    const sessionId = req.query?.session_id || req.body?.session_id || null;
    if (!sessionId) return res.status(400).json({ error: "Missing session_id" });

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription", "line_items.data.price.product"],
    });
    if (!session) return res.status(404).json({ error: "Checkout session not found" });

    const isComplete = session.status === "complete";
    const isPaid =
      session.payment_status === "paid" ||
      session.payment_status === "no_payment_required";

    if (!isComplete || !isPaid) {
      return res.status(409).json({
        error: "Checkout not completed/paid yet",
        status: session.status,
        payment_status: session.payment_status,
      });
    }

    const userId = session?.metadata?.user_id || session?.client_reference_id || null;
    if (!userId) {
      return res.status(400).json({ error: "Missing metadata.user_id / client_reference_id" });
    }

    const mode             = session.mode;
    const stripeCustomerId = session.customer || null;

    const wasProcessed = await alreadyProcessed(supabase, sessionId);
    if (wasProcessed) {
      return res.status(200).json({ ok: true, already_processed: true, mode, session_id: sessionId });
    }

    if (mode === "subscription") {
      const stripeSubscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id || null;

      let plan = String(session?.metadata?.plan || "").toLowerCase().trim();

      if ((!plan || plan === "0") && session.subscription) {
        const subObj =
          typeof session.subscription === "string"
            ? await stripe.subscriptions.retrieve(session.subscription)
            : session.subscription;

        plan = String(subObj?.metadata?.plan || "").toLowerCase().trim();

        if (!plan || plan === "0") {
          const item    = subObj?.items?.data?.[0];
          const priceId = item?.price?.id || "";
          plan = planFromPriceId(priceId);
        }
      }

      const includedSeconds = includedSecondsForPlan(plan);
      if (!includedSeconds) {
        return res.status(400).json({ error: "Could not resolve included seconds for subscription", plan });
      }

      const { error: subErr } = await supabase
        .from("user_subscriptions")
        .upsert(
          {
            user_id: userId, stripe_customer_id: stripeCustomerId,
            stripe_subscription_id: stripeSubscriptionId,
            status: "active", is_active: true, plan: plan || null, current_period_end: null,
          },
          { onConflict: "user_id" }
        );
      if (subErr) {
        console.error("user_subscriptions upsert failed:", subErr);
        return res.status(500).json({ error: "Failed to update user_subscriptions" });
      }

      const { data: usage, error: usageFindErr } = await supabase
        .from("user_usage")
        .select("user_id, topup_seconds_balance")
        .eq("user_id", userId)
        .maybeSingle();
      if (usageFindErr) {
        console.error("user_usage lookup failed:", usageFindErr);
        return res.status(500).json({ error: "Failed to read user_usage" });
      }

      if (!usage) {
        const { error: insErr } = await supabase.from("user_usage").insert({
          user_id: userId, free_seconds_total: DEFAULT_FREE_SECONDS_TOTAL,
          free_seconds_used: DEFAULT_FREE_SECONDS_TOTAL,
          paid_seconds_total: includedSeconds, paid_seconds_used: 0, topup_seconds_balance: 0,
        });
        if (insErr) {
          console.error("user_usage insert failed:", insErr);
          return res.status(500).json({ error: "Failed to insert user_usage" });
        }
      } else {
        const { error: updErr } = await supabase
          .from("user_usage")
          .update({ free_seconds_used: DEFAULT_FREE_SECONDS_TOTAL, paid_seconds_total: includedSeconds, paid_seconds_used: 0 })
          .eq("user_id", userId);
        if (updErr) {
          console.error("user_usage update failed:", updErr);
          return res.status(500).json({ error: "Failed to update user_usage" });
        }
      }

      await safeTrack(supabase, userId, "checkout_confirmed", {
        checkout_session_id: sessionId, mode, plan,
        stripe_subscription_id: stripeSubscriptionId, stripe_customer_id: stripeCustomerId,
      });
      await safeTrack(supabase, userId, "subscription_confirmed_via_return", {
        checkout_session_id: sessionId, plan, included_seconds: includedSeconds,
      });
      return res.status(200).json({ ok: true, mode, plan, session_id: sessionId });
    }

    if (mode === "payment") {
      const pack       = session?.metadata?.topup_pack;
      const addSeconds = topupSecondsForPack(pack);

      if (addSeconds <= 0) {
        return res.status(400).json({ error: "Invalid topup pack", pack });
      }

      const { data: usage, error: usageFindErr } = await supabase
        .from("user_usage")
        .select("user_id, topup_seconds_balance")
        .eq("user_id", userId)
        .maybeSingle();
      if (usageFindErr) {
        console.error("user_usage lookup failed:", usageFindErr);
        return res.status(500).json({ error: "Failed to read user_usage" });
      }

      if (!usage) {
        const { error: insErr } = await supabase.from("user_usage").insert({
          user_id: userId, free_seconds_total: DEFAULT_FREE_SECONDS_TOTAL,
          free_seconds_used: DEFAULT_FREE_SECONDS_TOTAL,
          paid_seconds_total: 0, paid_seconds_used: 0, topup_seconds_balance: addSeconds,
        });
        if (insErr) {
          console.error("user_usage insert failed:", insErr);
          return res.status(500).json({ error: "Failed to insert user_usage" });
        }
      } else {
        const newBal = (usage.topup_seconds_balance || 0) + addSeconds;
        const { error: updErr } = await supabase
          .from("user_usage")
          .update({ free_seconds_used: DEFAULT_FREE_SECONDS_TOTAL, topup_seconds_balance: newBal })
          .eq("user_id", userId);
        if (updErr) {
          console.error("user_usage update failed:", updErr);
          return res.status(500).json({ error: "Failed to update user_usage" });
        }
      }

      await safeTrack(supabase, userId, "checkout_confirmed", {
        checkout_session_id: sessionId, mode, topup_pack: Number(pack), stripe_customer_id: stripeCustomerId,
      });
      await safeTrack(supabase, userId, "topup_confirmed_via_return", {
        checkout_session_id: sessionId, pack: Number(pack), added_seconds: addSeconds,
      });
      return res.status(200).json({ ok: true, mode, pack: Number(pack), added_seconds: addSeconds, session_id: sessionId });
    }

    return res.status(400).json({ error: "Unsupported checkout mode", mode });
  } catch (err) {
    console.error("billing/confirm error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  const action = req.query?.action;
  switch (action) {
    case "checkout": return handleCheckout(req, res);
    case "portal":   return handlePortal(req, res);
    case "topup":    return handleTopup(req, res);
    case "confirm":  return handleConfirm(req, res);
    default:
      return res.status(400).json({ error: "Missing or invalid ?action. Use: checkout | portal | topup | confirm" });
  }
}
