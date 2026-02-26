const Stripe = require("stripe");
const { buffer } = require("micro");
const { createClient } = require("@supabase/supabase-js");

module.exports.config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function includedSecondsForPlan(plan) {
  const p = String(plan || "").toLowerCase();
  if (p === "starter") return 120 * 60; // 120 min
  if (p === "plus") return 300 * 60;    // 300 min
  return 0;
}

function topupSecondsForPack(pack) {
  const k = Number(pack);
  if (k === 5) return 60 * 60;        // 60 min
  if (k === 10) return 140 * 60;      // 140 min
  if (k === 20) return 320 * 60;      // 320 min
  return 0;
}

async function safeTrack(supabase, userId, event_name, meta = {}) {
  try {
    if (!userId) return;
    await supabase.from("analytics_events").insert({ user_id: userId, event_name, meta });
  } catch (e) {
    console.warn("Analytics insert failed:", e?.message || e);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(500).send("Missing STRIPE_WEBHOOK_SECRET");

  let event;
  try {
    const rawBody = await buffer(req);
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error("Missing Supabase env vars", { supabaseUrl: !!supabaseUrl, serviceKey: !!serviceKey });
    return res.status(500).send("Missing Supabase server env vars");
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    // 1) Checkout completed
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const userId = session?.metadata?.user_id;
      if (!userId) {
        console.warn("checkout.session.completed without metadata.user_id");
        return res.status(200).json({ received: true });
      }

      const mode = session.mode; // "subscription" | "payment"
      const stripeCustomerId = session.customer || null;

      // A) Subscription
      if (mode === "subscription") {
        const stripeSubscriptionId = session.subscription || null;

        // ✅ plan robust holen (Session metadata -> Subscription metadata fallback)
        let plan = String(session?.metadata?.plan || "").toLowerCase().trim();

        if (!plan && stripeSubscriptionId) {
          try {
            const subObj = await stripe.subscriptions.retrieve(stripeSubscriptionId);
            plan = String(subObj?.metadata?.plan || "").toLowerCase().trim();
          } catch (e) {
            console.warn("Could not retrieve subscription for plan fallback:", e?.message || e);
          }
        }

        const includedSeconds = includedSecondsForPlan(plan);

        const { error: subErr } = await supabase
          .from("user_subscriptions")
          .upsert({
            user_id: userId,
            stripe_customer_id: stripeCustomerId,
            stripe_subscription_id: stripeSubscriptionId,
            status: "active",
            is_active: true,
            plan: plan || null,
            current_period_end: null,
          });

        if (subErr) throw subErr;

        // Usage row sicherstellen + Monatskontingent setzen & used reset
        const { data: usage } = await supabase
          .from("user_usage")
          .select("user_id")
          .eq("user_id", userId)
          .maybeSingle();

        if (!usage) {
          const { error: uInsErr } = await supabase.from("user_usage").insert({
            user_id: userId,
            free_seconds_total: 600,
            free_seconds_used: 0,
            paid_seconds_total: includedSeconds,
            paid_seconds_used: 0,
            topup_seconds_balance: 0,
          });
          if (uInsErr) throw uInsErr;
        } else {
          const { error: uUpdErr } = await supabase
            .from("user_usage")
            .update({
              paid_seconds_total: includedSeconds,
              paid_seconds_used: 0,
            })
            .eq("user_id", userId);
          if (uUpdErr) throw uUpdErr;
        }

        await safeTrack(supabase, userId, "subscription_activated", {
          plan: plan || null,
          stripe_subscription_id: stripeSubscriptionId,
          stripe_customer_id: stripeCustomerId,
          included_seconds: includedSeconds,
        });

        return res.status(200).json({ received: true });
      }

      // B) Top-up
      if (mode === "payment") {
        const pack = session?.metadata?.topup_pack;
        const addSeconds = topupSecondsForPack(pack);

        if (addSeconds <= 0) {
          console.warn("Top-up payment without valid topup_pack:", pack);
          await safeTrack(supabase, userId, "topup_invalid_pack", { pack });
          return res.status(200).json({ received: true });
        }

        const { data: usage, error: uSelErr } = await supabase
          .from("user_usage")
          .select("topup_seconds_balance")
          .eq("user_id", userId)
          .maybeSingle();

        if (uSelErr) throw uSelErr;

        if (!usage) {
          const { error: uInsErr } = await supabase.from("user_usage").insert({
            user_id: userId,
            free_seconds_total: 600,
            free_seconds_used: 0,
            paid_seconds_total: 0,
            paid_seconds_used: 0,
            topup_seconds_balance: addSeconds,
          });
          if (uInsErr) throw uInsErr;
        } else {
          const newBal = (usage.topup_seconds_balance || 0) + addSeconds;
          const { error: uUpdErr } = await supabase
            .from("user_usage")
            .update({ topup_seconds_balance: newBal })
            .eq("user_id", userId);
          if (uUpdErr) throw uUpdErr;
        }

        await safeTrack(supabase, userId, "topup_completed", {
          pack: Number(pack),
          added_seconds: addSeconds,
          stripe_customer_id: stripeCustomerId,
        });

        return res.status(200).json({ received: true });
      }

      console.warn("checkout.session.completed unknown mode:", mode);
      await safeTrack(supabase, userId, "checkout_unknown_mode", { mode });
      return res.status(200).json({ received: true });
    }

    // 2) Subscription Updated
    if (event.type === "customer.subscription.updated") {
      const sub = event.data.object;
      const stripeSubscriptionId = sub.id;
      const stripeCustomerId = sub.customer || null;
      const status = sub.status || null;
      const isActive = status === "active" || status === "trialing";
      const currentPeriodEnd = sub.current_period_end
        ? new Date(sub.current_period_end * 1000).toISOString()
        : null;

      const { data: row, error: findErr } = await supabase
        .from("user_subscriptions")
        .select("user_id, plan")
        .eq("stripe_subscription_id", stripeSubscriptionId)
        .maybeSingle();

      if (findErr) throw findErr;

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

      if (updErr) throw updErr;

      await safeTrack(supabase, userId, "subscription_updated", {
        status,
        is_active: isActive,
        current_period_end: currentPeriodEnd,
        stripe_subscription_id: stripeSubscriptionId,
      });

      return res.status(200).json({ received: true });
    }

    // 3) Subscription Deleted
    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      const stripeSubscriptionId = sub.id;

      const { data: row, error: findErr } = await supabase
        .from("user_subscriptions")
        .select("user_id")
        .eq("stripe_subscription_id", stripeSubscriptionId)
        .maybeSingle();

      if (findErr) throw findErr;

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

      if (updErr) throw updErr;

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
};
