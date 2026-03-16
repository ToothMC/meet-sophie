import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

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
    await supabase.from("analytics_events").insert({
      user_id: userId,
      event_name,
      meta,
    });
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

export default async function handler(req, res) {
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!stripeKey) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });
    if (!supabaseUrl || !serviceKey) {
      return res.status(500).json({ error: "Missing Supabase env vars" });
    }

    const stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20" });
    const supabase = createClient(supabaseUrl, serviceKey);

    const sessionId =
      req.query?.session_id ||
      req.body?.session_id ||
      null;

    if (!sessionId) {
      return res.status(400).json({ error: "Missing session_id" });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription", "line_items.data.price.product"],
    });

    if (!session) {
      return res.status(404).json({ error: "Checkout session not found" });
    }

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

    const mode = session.mode;
    const stripeCustomerId = session.customer || null;

    const wasProcessed = await alreadyProcessed(supabase, sessionId);
    if (wasProcessed) {
      return res.status(200).json({
        ok: true,
        already_processed: true,
        mode,
        session_id: sessionId,
      });
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
          const item = subObj?.items?.data?.[0];
          const priceId = item?.price?.id || "";
          plan = planFromPriceId(priceId);
        }
      }

      const includedSeconds = includedSecondsForPlan(plan);
      if (!includedSeconds) {
        return res.status(400).json({
          error: "Could not resolve included seconds for subscription",
          plan,
        });
      }

      const { error: subErr } = await supabase
        .from("user_subscriptions")
        .upsert(
          {
            user_id: userId,
            stripe_customer_id: stripeCustomerId,
            stripe_subscription_id: stripeSubscriptionId,
            status: "active",
            is_active: true,
            plan: plan || null,
            current_period_end: null,
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
          user_id: userId,
          free_seconds_total: DEFAULT_FREE_SECONDS_TOTAL,
          free_seconds_used: DEFAULT_FREE_SECONDS_TOTAL,
          paid_seconds_total: includedSeconds,
          paid_seconds_used: 0,
          topup_seconds_balance: 0,
        });

        if (insErr) {
          console.error("user_usage insert failed:", insErr);
          return res.status(500).json({ error: "Failed to insert user_usage" });
        }
      } else {
        const { error: updErr } = await supabase
          .from("user_usage")
          .update({
            free_seconds_used: DEFAULT_FREE_SECONDS_TOTAL,
            paid_seconds_total: includedSeconds,
            paid_seconds_used: 0,
          })
          .eq("user_id", userId);

        if (updErr) {
          console.error("user_usage update failed:", updErr);
          return res.status(500).json({ error: "Failed to update user_usage" });
        }
      }

      await safeTrack(supabase, userId, "checkout_confirmed", {
        checkout_session_id: sessionId,
        mode,
        plan,
        stripe_subscription_id: stripeSubscriptionId,
        stripe_customer_id: stripeCustomerId,
      });

      await safeTrack(supabase, userId, "subscription_confirmed_via_return", {
        checkout_session_id: sessionId,
        plan,
        included_seconds: includedSeconds,
      });

      return res.status(200).json({
        ok: true,
        mode,
        plan,
        session_id: sessionId,
      });
    }

    if (mode === "payment") {
      const pack = session?.metadata?.topup_pack;
      const addSeconds = topupSecondsForPack(pack);

      if (addSeconds <= 0) {
        return res.status(400).json({
          error: "Invalid topup pack",
          pack,
        });
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
          user_id: userId,
          free_seconds_total: DEFAULT_FREE_SECONDS_TOTAL,
          free_seconds_used: DEFAULT_FREE_SECONDS_TOTAL,
          paid_seconds_total: 0,
          paid_seconds_used: 0,
          topup_seconds_balance: addSeconds,
        });

        if (insErr) {
          console.error("user_usage insert failed:", insErr);
          return res.status(500).json({ error: "Failed to insert user_usage" });
        }
      } else {
        const newBal = (usage.topup_seconds_balance || 0) + addSeconds;

        const { error: updErr } = await supabase
          .from("user_usage")
          .update({
            free_seconds_used: DEFAULT_FREE_SECONDS_TOTAL,
            topup_seconds_balance: newBal,
          })
          .eq("user_id", userId);

        if (updErr) {
          console.error("user_usage update failed:", updErr);
          return res.status(500).json({ error: "Failed to update user_usage" });
        }
      }

      await safeTrack(supabase, userId, "checkout_confirmed", {
        checkout_session_id: sessionId,
        mode,
        topup_pack: Number(pack),
        stripe_customer_id: stripeCustomerId,
      });

      await safeTrack(supabase, userId, "topup_confirmed_via_return", {
        checkout_session_id: sessionId,
        pack: Number(pack),
        added_seconds: addSeconds,
      });

      return res.status(200).json({
        ok: true,
        mode,
        pack: Number(pack),
        added_seconds: addSeconds,
        session_id: sessionId,
      });
    }

    return res.status(400).json({
      error: "Unsupported checkout mode",
      mode,
    });
  } catch (err) {
    console.error("confirm-checkout error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
