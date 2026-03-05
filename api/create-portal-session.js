// /api/create-portal-session.js
// Creates a Stripe Billing Portal session for the logged-in user.
// If user has no active Stripe customer/subscription, return 404 so UI can hide the link.

const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

module.exports = async function handler(req, res) {
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

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2026-01-28.clover",
    });

    // 1) Identify user from JWT
    const supabaseUser = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data: userData, error: userErr } = await supabaseUser.auth.getUser();
    if (userErr || !userData?.user?.id) return res.status(401).json({ error: "Invalid token" });
    const user_id = userData.user.id;

    // 2) Read Stripe customer id from DB (service role)
    const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: sub, error: subErr } = await supabaseAdmin
      .from("user_subscriptions")
      .select("stripe_customer_id, status, plan")
      .eq("user_id", user_id)
      .maybeSingle();

    if (subErr) return res.status(500).json({ error: "DB error", detail: subErr.message });

    // prepaid-only (or no subscription yet) -> hide link in UI
    if (!sub?.stripe_customer_id) {
      return res.status(404).json({ error: "No subscription customer" });
    }

    // 3) Return URL back to Talk by default
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host;
    const return_url = `${proto}://${host}/talk/`;

    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url,
    });

    return res.status(200).json({ url: session.url });
  } catch (e) {
    return res.status(500).json({ error: "Stripe portal error", detail: String(e?.message || e) });
  }
};
