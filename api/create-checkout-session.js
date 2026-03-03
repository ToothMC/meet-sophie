export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    // --- Body robust lesen (Vercel kann String liefern) ---
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

    // User validieren
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
    if (!userId) return res.status(401).json({ error: "User not found" });

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });

    const { plan, legal } = bodyJson || {};
    const p = String(plan || "").toLowerCase().trim();

    const priceId =
      p === "starter"
        ? process.env.STRIPE_PRICE_ID_STARTER
        : p === "plus"
        ? process.env.STRIPE_PRICE_ID_PLUS
        : null;

    if (!priceId) {
      return res.status(400).json({ error: "Missing/invalid plan. Use { plan: 'starter' | 'plus' }" });
    }

    // --- LEGAL ENFORCEMENT (server-side) ---
    // Versions: keep these in sync with your legal pages
    const TERMS_VERSION = "2026-03-03";
    const PRIVACY_VERSION = "2026-03-03";
    const WAIVER_VERSION = "2026-03-03";

    const termsAccepted = !!legal?.termsAccepted;
    const privacyAccepted = !!legal?.privacyAccepted;
    const waiverAccepted = !!legal?.waiverAccepted;
    const lang = typeof legal?.lang === "string" ? legal.lang.slice(0, 2).toLowerCase() : null;

    if (!termsAccepted || !privacyAccepted) {
      return res.status(400).json({ error: "Legal acceptance required: terms/privacy" });
    }
    if (!waiverAccepted) {
      return res.status(400).json({ error: "Legal acceptance required: withdrawal waiver" });
    }

    // Robust origin (works on Vercel prod + preview)
    const proto = (req.headers["x-forwarded-proto"] || "https").toString();
    const host = (req.headers["x-forwarded-host"] || req.headers.host || "meet-sophie.com").toString();
    const origin = `${proto}://${host}`;

    // --- Log acceptance in Supabase (minimal proof) ---
    // Optional: store IP/UA (you can remove if you want even less data)
    const ip =
      (req.headers["x-forwarded-for"] || "")
        .toString()
        .split(",")[0]
        .trim() || null;
    const userAgent = (req.headers["user-agent"] || "").toString().slice(0, 300) || null;

    const acceptInsert = {
      user_id: userId,
      event: "checkout_start",
      plan: p,
      lang,
      terms_version: TERMS_VERSION,
      privacy_version: PRIVACY_VERSION,
      waiver_version: WAIVER_VERSION,
      terms_accepted: true,
      privacy_accepted: true,
      waiver_accepted: true,
      origin,
      user_agent: userAgent,
      ip,
    };

    const supaInsertResp = await fetch(`${supabaseUrl}/rest/v1/legal_acceptances`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(acceptInsert),
    });

    if (!supaInsertResp.ok) {
      const t = await supaInsertResp.text();
      return res.status(500).json({ error: "Failed to store legal acceptance", detail: t });
    }

    // Empfehlenswert: direkt zurück in Talk
    const successUrl = `${origin}/talk/?paid=1`;
    const cancelUrl = `${origin}/pricing/?canceled=1`;

    const stripeBody = new URLSearchParams();
    stripeBody.append("mode", "subscription");
    stripeBody.append("success_url", successUrl);
    stripeBody.append("cancel_url", cancelUrl);

    stripeBody.append("line_items[0][price]", priceId);
    stripeBody.append("line_items[0][quantity]", "1");

    // Hilft beim Matching ohne metadata parsing
    stripeBody.append("client_reference_id", userId);

    // Metadata (include versions to aid later disputes)
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
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
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
    console.error("create-checkout-session error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
