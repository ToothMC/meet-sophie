import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing Authorization Bearer token" });

    const { seconds_used } = req.body || {};
    const sec = Math.max(0, Math.min(60 * 60, Number(seconds_used || 0))); // max 1h pro call
    if (!sec) return res.status(200).json({ ok: true, ignored: true });

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars" });
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) return res.status(401).json({ error: "Invalid token" });

    // Premium? Dann nichts abziehen
    const { data: sub } = await supabase
      .from("user_subscriptions")
      .select("is_active, status")
      .eq("user_id", user.id)
      .maybeSingle();

    const isPremium = !!sub?.is_active || sub?.status === "active" || sub?.status === "trialing";
    if (isPremium) return res.status(200).json({ ok: true, premium: true });

    // usage row sicherstellen (falls noch nicht vorhanden)
    const { data: usage } = await supabase
      .from("user_usage")
      .select("free_seconds_total, free_seconds_used")
      .eq("user_id", user.id)
      .maybeSingle();

    const freeTotal = usage?.free_seconds_total ?? 900;
    const freeUsed = usage?.free_seconds_used ?? 0;
    const newUsed = Math.min(freeTotal, freeUsed + sec);

    // upsert/update
    if (!usage) {
      await supabase.from("user_usage").insert({
        user_id: user.id,
        free_seconds_total: freeTotal,
        free_seconds_used: newUsed,
      });
    } else {
      await supabase
        .from("user_usage")
        .update({ free_seconds_used: newUsed })
        .eq("user_id", user.id);
    }

    return res.status(200).json({ ok: true, free_seconds_total: freeTotal, free_seconds_used: newUsed });
  } catch (e) {
    console.error("Usage update error:", e);
    return res.status(500).json({ error: "Usage update failed" });
  }
}
