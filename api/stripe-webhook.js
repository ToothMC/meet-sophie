import Stripe from "stripe";
import { buffer } from "micro";
import { createClient } from "@supabase/supabase-js";

export const config = { api: { bodyParser: false } };

// ✅ Free = 120 Sekunden (2 Minuten)
const DEFAULT_FREE_SECONDS_TOTAL = 120;

function includedSecondsForPlan(plan) {
  const p = String(plan || "").toLowerCase().trim();
  if (p === "starter") return 120 * 60; // Companion: 120 min
  if (p === "plus") return 300 * 60;    // Best Friend: 300 min
  return 0;
}

function topupSecondsForPack(pack) {
  const k = Number(pack);
  if (k === 5) return 60 * 60;     // 60 min
  if (k === 10) return 140 * 60;   // 140 min
  if (k === 20) return 320 * 60;   // 320 min
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!webhookSecret) return res.status(500).send("Missing STRIPE_WEBHOOK_SECRET");
  if (!stripeKey) return res.status(500).send("Missing STRIPE_SECRET_KEY");

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).send("Missing Supabase server env vars");

  const stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20" });
  const supabase = createClient(supabaseUrl, serviceKey);

  let event;
  try {
    const rawBody = await buffer(req);
    const sig = req.headers["stripe-signature"];
    if (!sig) return res.status(400).send("Missing stripe-signature header");
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err?.message || err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    console.log("✅ Stripe event received:", { type: event.type, id: event.id });

    // 1) Checkout completed
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const userId = session?.metadata?.user_id;
      if (!userId) {
        console.warn("checkout.session.completed without metadata.user_id");
        return res.status(200).json({ received: true });
      }

      const mode = session?.mode; // "subscription" | "payment"
      const stripeCustomerId = session?.customer || null;

      // A) Subscription
      if (mode === "subscription") {
        const stripeSubscriptionId = session?.subscription || null;

        let plan = String(session?.metadata?.plan || "").toLowerCase().trim();

        if ((!plan || plan === "0") && stripeSubscriptionId) {
          try {
            const subObj = await stripe.subscriptions.retrieve(stripeSubscriptionId);
            plan = String(subObj?.metadata?.plan || "").toLowerCase().trim();

            if (!plan || plan === "0") {
              const item = subObj?.items?.data?.[0];
              const priceId = item?.price?.id || "";
              plan = planFromPriceId(priceId);
            }
          } catch (e) {
            console.warn("Plan fallback failed:", e?.message || e);
          }
        }

        const includedSeconds = includedSecondsForPlan(plan);

        if (!includedSeconds) {
          console.error("No included seconds resolved - refusing activation", {
            userId,
            plan,
            stripeSubscriptionId,
          });
          await safeTrack(supabase, userId, "subscription_activation_failed", {
            plan: plan || null,
            stripe_subscription_id: stripeSubscriptionId,
            reason: "no_included_seconds",
          });
          return res.status(500).send("No included seconds resolved");
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
          console.error("Supabase upsert user_subscriptions failed:", subErr);
          return res.status(500).send("Supabase write failed (user_subscriptions)");
        }

        // usage row upsert-ish
        const { data: usage, error: uFindErr } = await supabase
          .from("user_usage")
          .select("user_id")
          .eq("user_id", userId)
          .maybeSingle();

        if (uFindErr) {
          console.error("Supabase select user_usage failed:", uFindErr);
          return res.status(500).send("Supabase read failed (user_usage)");
        }

        if (!usage) {
          const { error: uInsErr } = await supabase.from("user_usage").insert({
            user_id: userId,
            free_seconds_total: DEFAULT_FREE_SECONDS_TOTAL,
            free_seconds_used: DEFAULT_FREE_SECONDS_TOTAL, // ✅ freetime ist abgelaufen im Upgrade-Moment
            paid_seconds_total: includedSeconds,
            paid_seconds_used: 0,
            topup_seconds_balance: 0,
          });
          if (uInsErr) {
            console.error("Supabase insert user_usage failed:", uInsErr);
            return res.status(500).send("Supabase write failed (user_usage insert)");
          }
        } else {
          const { error: uUpdErr } = await supabase
            .from("user_usage")
            .update({
              paid_seconds_total: includedSeconds,
              paid_seconds_used: 0,
            })
            .eq("user_id", userId);

          if (uUpdErr) {
            console.error("Supabase update user_usage failed:", uUpdErr);
            return res.status(500).send("Supabase write failed (user_usage update)");
          }
        }

        await safeTrack(supabase, userId, "subscription_activated", {
          plan: plan || null,
          stripe_subscription_id: stripeSubscriptionId,
          stripe_customer_id: stripeCustomerId,
          included_seconds: includedSeconds,
        });

        return res.status(200).json({ received: true });
      }

      // B) Top-up payment
      if (mode === "payment") {
        const pack = session?.metadata?.topup_pack;
        const addSeconds = topupSecondsForPack(pack);

        if (addSeconds <= 0) {
          await safeTrack(supabase, userId, "topup_invalid_pack", { pack });
          return res.status(200).json({ received: true });
        }

        const { data: usage, error: uSelErr } = await supabase
          .from("user_usage")
          .select("topup_seconds_balance")
          .eq("user_id", userId)
          .maybeSingle();

        if (uSelErr) return res.status(500).send("Supabase read failed (user_usage)");

        if (!usage) {
          const { error: uInsErr } = await supabase.from("user_usage").insert({
            user_id: userId,
            free_seconds_total: DEFAULT_FREE_SECONDS_TOTAL,
            free_seconds_used: DEFAULT_FREE_SECONDS_TOTAL,
            paid_seconds_total: 0,
            paid_seconds_used: 0,
            topup_seconds_balance: addSeconds,
          });
          if (uInsErr) return res.status(500).send("Supabase write failed (user_usage insert)");
        } else {
          const newBal = (usage.topup_seconds_balance || 0) + addSeconds;
          const { error: uUpdErr } = await supabase
            .from("user_usage")
            .update({ topup_seconds_balance: newBal })
            .eq("user_id", userId);

          if (uUpdErr) return res.status(500).send("Supabase write failed (user_usage update)");
        }

        await safeTrack(supabase, userId, "topup_completed", {
          pack: Number(pack),
          added_seconds: addSeconds,
          stripe_customer_id: stripeCustomerId,
        });

        return res.status(200).json({ received: true });
      }

      return res.status(200).json({ received: true });
    }

    // 2) Subscription Updated -> status/period_end sync
    if (event.type === "customer.subscription.updated") {
      const sub = event.data.object;
      const stripeSubscriptionId = sub.id;
      const status = sub.status || null;
      const isActive = status === "active" || status === "trialing";
      const currentPeriodEnd = sub.current_period_end
        ? new Date(sub.current_period_end * 1000).toISOString()
        : null;

      const { data: row, error: findErr } = await supabase
        .from("user_subscriptions")
        .select("user_id")
        .eq("stripe_subscription_id", stripeSubscriptionId)
        .maybeSingle();

      if (findErr) return res.status(500).send("Supabase read failed (user_subscriptions)");
      if (!row?.user_id) return res.status(200).json({ received: true });

      const userId = row.user_id;

      const { error: updErr } = await supabase
        .from("user_subscriptions")
        .update({
          status,
          is_active: isActive,
          current_period_end: currentPeriodEnd,
        })
        .eq("user_id", userId);

      if (updErr) return res.status(500).send("Supabase write failed (user_subscriptions)");

      await safeTrack(supabase, userId, "subscription_updated", {
        status,
        is_active: isActive,
        current_period_end: currentPeriodEnd,
        stripe_subscription_id: stripeSubscriptionId,
      });

      return res.status(200).json({ received: true });
    }

    // 3) Monthly renew -> reset seconds (THIS is crucial)
    if (event.type === "invoice.paid") {
      const invoice = event.data.object;

      // only for subscription renewals
      if (invoice?.billing_reason !== "subscription_cycle") {
        return res.status(200).json({ received: true });
      }

      const stripeSubscriptionId = invoice?.subscription || null;
      if (!stripeSubscriptionId) return res.status(200).json({ received: true });

      const { data: row, error: findErr } = await supabase
        .from("user_subscriptions")
        .select("user_id, plan, is_active")
        .eq("stripe_subscription_id", stripeSubscriptionId)
        .maybeSingle();

      if (findErr) return res.status(500).send("Supabase read failed (user_subscriptions)");
      if (!row?.user_id) return res.status(200).json({ received: true });
      if (!row.is_active) return res.status(200).json({ received: true });

      const userId = row.user_id;
      const includedSeconds = includedSecondsForPlan(row.plan);

      if (!includedSeconds) return res.status(200).json({ received: true });

      const { error: uUpdErr } = await supabase
        .from("user_usage")
        .update({
          paid_seconds_total: includedSeconds,
          paid_seconds_used: 0,
        })
        .eq("user_id", userId);

      if (uUpdErr) return res.status(500).send("Supabase write failed (user_usage reset)");

      await safeTrack(supabase, userId, "subscription_renewed", {
        stripe_subscription_id: stripeSubscriptionId,
        included_seconds: includedSeconds,
      });

      return res.status(200).json({ received: true });
    }

    // 4) Subscription Deleted -> deactivate (+ optional zero seconds)
    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      const stripeSubscriptionId = sub.id;

      const { data: row, error: findErr } = await supabase
        .from("user_subscriptions")
        .select("user_id")
        .eq("stripe_subscription_id", stripeSubscriptionId)
        .maybeSingle();

      if (findErr) return res.status(500).send("Supabase read failed (user_subscriptions)");
      if (!row?.user_id) return res.status(200).json({ received: true });

      const userId = row.user_id;

      const { error: updErr } = await supabase
        .from("user_subscriptions")
        .update({
          status: "canceled",
          is_active: false,
          current_period_end: null,
        })
        .eq("user_id", userId);

      if (updErr) return res.status(500).send("Supabase write failed (user_subscriptions)");

      // optional: take away paid seconds immediately (depends on your gating)
      await supabase.from("user_usage").update({
        paid_seconds_total: 0,
      }).eq("user_id", userId);

      await safeTrack(supabase, userId, "subscription_deleted", {
        stripe_subscription_id: stripeSubscriptionId,
      });

      return res.status(200).json({ received: true });
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook handling error:", err);
    return res.status(500).send("Webhook handler failed");
  }
}
