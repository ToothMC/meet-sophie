const Stripe = require("stripe");
const { buffer } = require("micro");
const { createClient } = require("@supabase/supabase-js");

module.exports.config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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
    console.error("Missing Supabase env vars", {
      supabaseUrl: !!supabaseUrl,
      serviceKey: !!serviceKey,
    });
    return res.status(500).send("Missing Supabase server env vars");
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userId = session?.metadata?.user_id;

      if (!userId) {
        console.warn("checkout.session.completed without metadata.user_id");
        return res.status(200).json({ received: true });
      }

      const stripeCustomerId = session.customer || null;
      const stripeSubscriptionId = session.subscription || null;

      // 1) Subscription aktiv setzen
      const { error } = await supabase
        .from("user_subscriptions")
        .upsert({
          user_id: userId,
          stripe_customer_id: stripeCustomerId,
          stripe_subscription_id: stripeSubscriptionId,
          status: "active",
          is_active: true,
          current_period_end: null,
        });

      if (error) throw error;

      // 2) ✅ Analytics Event: subscription_activated
      const { error: aErr } = await supabase
        .from("analytics_events")
        .insert({
          user_id: userId,
          event_name: "subscription_activated",
          meta: {
            stripe_subscription_id: stripeSubscriptionId,
            stripe_customer_id: stripeCustomerId,
          },
        });

      if (aErr) {
        // Tracking darf niemals Premium-Freischaltung blockieren
        console.warn("Analytics insert failed:", aErr.message);
      }

      return res.status(200).json({ received: true });
    }

    // MVP: Rest ignorieren
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook handling error:", err);
    return res.status(500).send("Webhook handler failed");
  }
};
