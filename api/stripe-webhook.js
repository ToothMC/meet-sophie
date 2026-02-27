// api/stripe-webhook.js
// Vercel Serverless Function (Node/CommonJS)
// Handles Stripe webhooks and writes subscription/usage into Supabase.

const Stripe = require("stripe");
const { buffer } = require("micro");
const { createClient } = require("@supabase/supabase-js");

module.exports.config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2026-01-28.clover",
});

// ✅ Free = 120 Sekunden (2 Minuten)
const DEFAULT_FREE_SECONDS_TOTAL = 120;

function includedSecondsForPlan(plan) {
  const p = String(plan || "").toLowerCase().trim();
  if (p === "starter") return 120 * 60; // 120 min
  if (p === "plus") return 300 * 60;    // 300 min
  return 0;
}

function topupSecondsForPack(pack) {
  const k = Number(pack);
  // Conversion-first: großzügig. Später kannst du das enger machen.
  if (k === 5) return 60 * 60;     // 60 min
  if (k === 10) return 140 * 60;   // 140 min
  if (k === 20) return 320 * 60;   // 320 min
  return 0;
}

// ✅ Fallback: Plan aus Price-ID ableiten
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

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  // Basic env validation (fails loudly)
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(500).send("Missing STRIPE_WEBHOOK_SECRET");

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error("Missing Supabase env vars", {
      hasSupabaseUrl: !!supabaseUrl,
      hasServiceKey: !!serviceKey,
    });
    return res.status(500).send("Missing Supabase server env vars");
  }

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

  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    // Helpful log for debugging (keeps secrets out)
    console.log("✅ Stripe event received:", { type: event.type, id: event.id });

    // 1) Checkout completed (Subscription oder Top-up Payment)
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const userId = session?.metadata?.user_id;
      if (!userId) {
        console.warn("checkout.session.completed without metadata.user_id");
        // return 200 so Stripe doesn't retry forever on missing metadata
        return res.status(200).json({ received: true });
      }

      const mode = session?.mode; // "subscription" | "payment"
      const stripeCustomerId = session?.customer || null;

      // A) Subscription Checkout
      if (mode === "subscription") {
        const stripeSubscriptionId = session?.subscription || null;

        // ✅ Plan robust ermitteln:
        // 1) Session metadata
        let plan = String(session?.metadata?.plan || "").toLowerCase().trim();

        // 2) Subscription metadata oder Price-ID fallback
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

        // ✅ Wichtig: wenn wir keinen Plan/Seconds sicher haben, NICHT still 200 geben.
        // Dann sieht Stripe "Failed" und retried — und du siehst den Fehler.
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

        // Subscription status setzen (UPSERt on user_id)
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
              current_period_end: null, // wird per subscription.updated nachgezogen
            },
            { onConflict: "user_id" }
          );

        if (subErr) {
          console.error("Supabase upsert user_subscriptions failed:", subErr);
          return res.status(500).send("Supabase write failed (user_subscriptions)");
        }

        // Usage-Row sicherstellen + Monatskontingent setzen & used reset
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
            free_seconds_used: 0,
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

      // B) Top-up Payment Checkout
      if (mode === "payment") {
        const pack = session?.metadata?.topup_pack;
        const addSeconds = topupSecondsForPack(pack);

        if (addSeconds <= 0) {
          console.warn("Top-up payment without valid topup_pack:", pack);
          await safeTrack(supabase, userId, "topup_invalid_pack", { pack });
          return res.status(200).json({ received: true });
        }

        // Ensure usage row exists, then add to balance
        const { data: usage, error: uSelErr } = await supabase
          .from("user_usage")
          .select("topup_seconds_balance")
          .eq("user_id", userId)
          .maybeSingle();

        if (uSelErr) {
          console.error("Supabase select user_usage failed:", uSelErr);
          return res.status(500).send("Supabase read failed (user_usage)");
        }

        if (!usage) {
          const { error: uInsErr } = await supabase.from("user_usage").insert({
            user_id: userId,
            free_seconds_total: DEFAULT_FREE_SECONDS_TOTAL,
            free_seconds_used: 0,
            paid_seconds_total: 0,
            paid_seconds_used: 0,
            topup_seconds_balance: addSeconds,
          });
          if (uInsErr) {
            console.error("Supabase insert user_usage failed:", uInsErr);
            return res.status(500).send("Supabase write failed (user_usage insert)");
          }
        } else {
          const newBal = (usage.topup_seconds_balance || 0) + addSeconds;
          const { error: uUpdErr } = await supabase
            .from("user_usage")
            .update({ topup_seconds_balance: newBal })
            .eq("user_id", userId);

          if (uUpdErr) {
            console.error("Supabase update user_usage failed:", uUpdErr);
            return res.status(500).send("Supabase write failed (user_usage update)");
          }
        }

        await safeTrack(supabase, userId, "topup_completed", {
          pack: Number(pack),
          added_seconds: addSeconds,
          stripe_customer_id: stripeCustomerId,
        });

        return res.status(200).json({ received: true });
      }

      // Unknown mode
      console.warn("checkout.session.completed unknown mode:", mode);
      await safeTrack(supabase, userId, "checkout_unknown_mode", { mode });
      return res.status(200).json({ received: true });
    }

    // 2) Subscription Updated -> Status / Period End sync
    if (event.type === "customer.subscription.updated") {
      const sub = event.data.object;
      const stripeSubscriptionId = sub.id;
      const stripeCustomerId = sub.customer || null;
      const status = sub.status || null; // active, trialing, past_due, canceled, unpaid...
      const isActive = status === "active" || status === "trialing";
      const currentPeriodEnd = sub.current_period_end
        ? new Date(sub.current_period_end * 1000).toISOString()
        : null;

      // Find user by stripe_subscription_id
      const { data: row, error: findErr } = await supabase
        .from("user_subscriptions")
        .select("user_id, plan")
        .eq("stripe_subscription_id", stripeSubscriptionId)
        .maybeSingle();

      if (findErr) {
        console.error("Supabase find subscription failed:", findErr);
        return res.status(500).send("Supabase read failed (user_subscriptions)");
      }

      if (!row?.user_id) {
        console.warn("subscription.updated: no user found for subscription", stripeSubscriptionId);
        return res.status(200).json({ received: true });
      }

      const userId = row.user_id;

      const { error: updErr } = await supabase
        .from("user_subscriptions")
        .update({
          stripe_customer_id: stripeCustomerId,
          status: status,
          is_active: isActive,
          current_period_end: currentPeriodEnd,
        })
        .eq("user_id", userId);

      if (updErr) {
        console.error("Supabase update subscription failed:", updErr);
        return res.status(500).send("Supabase write failed (user_subscriptions)");
      }

      await safeTrack(supabase, userId, "subscription_updated", {
        status,
        is_active: isActive,
        current_period_end: currentPeriodEnd,
        stripe_subscription_id: stripeSubscriptionId,
      });

      return res.status(200).json({ received: true });
    }

    // 3) Subscription Deleted -> Deactivate
    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      const stripeSubscriptionId = sub.id;

      const { data: row, error: findErr } = await supabase
        .from("user_subscriptions")
        .select("user_id")
        .eq("stripe_subscription_id", stripeSubscriptionId)
        .maybeSingle();

      if (findErr) {
        console.error("Supabase find subscription failed:", findErr);
        return res.status(500).send("Supabase read failed (user_subscriptions)");
      }

      if (!row?.user_id) {
        console.warn("subscription.deleted: no user found for subscription", stripeSubscriptionId);
        return res.status(200).json({ received: true });
      }

      const userId = row.user_id;

      const { error: updErr } = await supabase
        .from("user_subscriptions")
        .update({
          status: "canceled",
          is_active: false,
          current_period_end: null,
        })
        .eq("user_id", userId);

      if (updErr) {
        console.error("Supabase update subscription failed:", updErr);
        return res.status(500).send("Supabase write failed (user_subscriptions)");
      }

      await safeTrack(supabase, userId, "subscription_deleted", {
        stripe_subscription_id: stripeSubscriptionId,
      });

      return res.status(200).json({ received: true });
    }

    // MVP: Rest ignorieren
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook handling error:", err);
    return res.status(500).send("Webhook handler failed");
  }
};
