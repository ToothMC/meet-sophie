import Stripe from "stripe";
import { buffer } from "micro";

export const config = {
  api: {
    bodyParser: false, // WICHTIG: raw body für Signaturprüfung
  },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return res.status(500).send("Missing STRIPE_WEBHOOK_SECRET");
  }

  let event;
  try {
    const rawBody = await buffer(req);
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // --- Supabase REST (ohne supabase-js) mit Service Role ---
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  async function upsertSubscriptionRow(payload) {
    const r = await fetch(`${supabaseUrl}/rest/v1/user_subscriptions`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const t = await r.text();
      throw new Error(`Supabase upsert failed: ${t}`);
    }
  }

  async function markSubscriptionInactive(userId, status) {
    const r = await fetch(`${supabaseUrl}/rest/v1/user_subscriptions?user_id=eq.${userId}`, {
      method: "PATCH",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: status || "inactive",
        is_active: false,
      }),
    });

    if (!r.ok) {
      const t = await r.text();
      throw new Error(`Supabase patch failed: ${t}`);
    }
  }

  try {
    // 1) Checkout fertig -> Subscription aktiv setzen
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      // user_id kommt aus metadata (haben wir beim Checkout gesetzt)
      const userId = session?.metadata?.user_id;
      if (!userId) {
        console.warn("checkout.session.completed without metadata.user_id");
        return res.status(200).json({ received: true });
      }

      // Bei Subscriptions ist session.subscription gesetzt
      const stripeCustomerId = session.customer || null;
      const stripeSubscriptionId = session.subscription || null;

      await upsertSubscriptionRow([{
        user_id: userId,
        stripe_customer_id: stripeCustomerId,
        stripe_subscription_id: stripeSubscriptionId,
        status: "active",
        is_active: true,
        current_period_end: null
      }]);

      return res.status(200).json({ received: true });
    }

    // 2) Subscription Updates (verlängert, pausiert, past_due etc.)
    if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.created") {
      const sub = event.data.object;

      // Wir mappen über stripe_subscription_id -> user_id aus DB wäre besser,
      // aber MVP: Stripe sendet hier kein user_id. Deshalb: wir updaten über subscription_id nicht direkt.
      // => Lösung: Wir speichern bei checkout.session.completed stripe_subscription_id + user_id.
      // Hier holen wir user_id anhand subscription_id aus Supabase.
      const subId = sub.id;

      const lookup = await fetch(
        `${supabaseUrl}/rest/v1/user_subscriptions?stripe_subscription_id=eq.${subId}&select=user_id`,
        {
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
          },
        }
      );

      if (!lookup.ok) {
        const t = await lookup.text();
        throw new Error(`Supabase lookup failed: ${t}`);
      }

      const rows = await lookup.json();
      const userId = rows?.[0]?.user_id;
      if (!userId) return res.status(200).json({ received: true });

      const status = sub.status; // active, trialing, past_due, canceled, unpaid...
      const isActive = status === "active" || status === "trialing";
      const currentPeriodEnd = sub.current_period_end
        ? new Date(sub.current_period_end * 1000).toISOString()
        : null;

      // patch über user_id
      const patch = await fetch(`${supabaseUrl}/rest/v1/user_subscriptions?user_id=eq.${userId}`, {
        method: "PATCH",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          status,
          is_active: isActive,
          current_period_end: currentPeriodEnd,
        }),
      });

      if (!patch.ok) {
        const t = await patch.text();
        throw new Error(`Supabase patch failed: ${t}`);
      }

      return res.status(200).json({ received: true });
    }

    // 3) Kündigung / gelöscht
    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      const subId = sub.id;

      const lookup = await fetch(
        `${supabaseUrl}/rest/v1/user_subscriptions?stripe_subscription_id=eq.${subId}&select=user_id`,
        {
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
          },
        }
      );

      if (!lookup.ok) {
        const t = await lookup.text();
        throw new Error(`Supabase lookup failed: ${t}`);
      }

      const rows = await lookup.json();
      const userId = rows?.[0]?.user_id;
      if (userId) await markSubscriptionInactive(userId, "canceled");

      return res.status(200).json({ received: true });
    }

    // Alles andere ignorieren (ok)
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook handling error:", err);
    return res.status(500).send("Webhook handler failed");
  }
}
2) Supabase Tabelle muss existieren (falls noch nicht gemacht)

In Supabase SQL Editor:

create table if not exists public.user_subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text,
  status text,
  current_period_end timestamptz,
  is_active boolean default false,
  created_at timestamptz default now()
);

alter table public.user_subscriptions enable row level security;

create policy "sub_select_own"
on public.user_subscriptions for select
using (auth.uid() = user_id);
