export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    // --- Bearer Token prüfen ---
    const authHeader = req.headers.authorization || "";
    const accessToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (!accessToken) {
      return res.status(401).json({ error: "Missing Authorization Bearer token" });
    }

    // --- Supabase Server Env ---
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      return res.status(500).json({ error: "Missing Supabase server env vars" });
    }

    // --- User via Supabase Auth API holen ---
    const userResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: serviceRoleKey,
      },
    });

    if (!userResp.ok) {
      const t = await userResp.text();
      return res.status(401).json({ error: "Invalid token", detail: t });
    }

    const user = await userResp.json();
    const userId = user?.id;

    if (!userId) {
      return res.status(401).json({ error: "User not found" });
    }

    // --- Stripe Key ---
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });

    // --- plan aus Body ---
    const { plan } = req.body || {};
    const p = String(plan || "").toLowerCase().trim();

    const priceId =
      p === "starter"
        ? process.env.STRIPE_PRICE_ID_STARTER
        : p === "plus"
        ? process.env.STRIPE_PRICE_ID_PLUS
        : null;

    if (!priceId) {
      return res.status(400).json({
        error: "Missing/invalid plan. Use { plan: 'starter' | 'plus' }",
      });
    }

    // --- URLs (immer mit Slash) ---
    const origin = req.headers.origin || "https://meet-sophie.com";
    const successUrl = `${origin}/success/`;
    const cancelUrl = `${origin}/pricing/`;

    // --- Stripe Checkout Session erstellen ---
    const body = new URLSearchParams();
    body.append("mode", "subscription");
    body.append("success_url", successUrl);
    body.append("cancel_url", cancelUrl);

    body.append("line_items[0][price]", priceId);
    body.append("line_items[0][quantity]", "1");

    // ✅ Session Metadata (kommt in checkout.session.completed)
    body.append("metadata[user_id]", userId);
    body.append("metadata[plan]", p);

    // ✅ Subscription Metadata (robuster; kann per subscriptions.retrieve geholt werden)
    body.append("subscription_data[metadata][user_id]", userId);
    body.append("subscription_data[metadata][plan]", p);

    if (user?.email) body.append("customer_email", user.email);

    const stripeResp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const stripeJson = await stripeResp.json();

    if (!stripeResp.ok) {
      return res.status(500).json({ error: "Stripe error", detail: stripeJson });
    }

    return res.status(200).json({ url: stripeJson.url });
  } catch (err) {
    console.error("create-checkout-session error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
