import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: "Missing Authorization Bearer token" });
    }

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars" });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser(token);

    if (userErr || !user) {
      return res.status(401).json({ error: "Invalid token" });
    }

    const { data: usage, error: usageErr } = await supabase
      .from("user_usage")
      .select("free_seconds_total, free_seconds_used, paid_seconds_total, paid_seconds_used, topup_seconds_balance")
      .eq("user_id", user.id)
      .maybeSingle();

    if (usageErr) {
      return res.status(500).json({ error: usageErr.message });
    }

    if (!usage) {
      return res.status(200).json({
        ok: true,
        finalized: false,
        reason: "no_usage_row",
      });
    }

    const freeTotal = usage.free_seconds_total ?? 120;
    const freeUsed = usage.free_seconds_used ?? 0;
    const paidTotal = usage.paid_seconds_total ?? 0;
    const paidUsed = usage.paid_seconds_used ?? 0;
    const topupBal = usage.topup_seconds_balance ?? 0;

    const freeRemaining = Math.max(0, freeTotal - freeUsed);
    const paidRemaining = Math.max(0, paidTotal - paidUsed);
    const topupRemaining = Math.max(0, topupBal);

    const totalRemaining = freeRemaining + paidRemaining + topupRemaining;

    // Nur finalisieren, wenn wirklich nichts Sinnvolles mehr übrig ist.
    // Kleine Reste <= 3 Sekunden werden hart geschlossen.
    if (totalRemaining > 3) {
      return res.status(200).json({
        ok: true,
        finalized: false,
        reason: "still_time_left",
        remaining_seconds: totalRemaining,
      });
    }

    const patch = {
      free_seconds_used: freeRemaining > 0 ? freeTotal : freeUsed,
      paid_seconds_used: paidRemaining > 0 ? paidTotal : paidUsed,
      topup_seconds_balance: topupRemaining > 0 ? 0 : topupBal,
    };

    const { data: updated, error: updErr } = await supabase
      .from("user_usage")
      .update(patch)
      .eq("user_id", user.id)
      .select("free_seconds_total, free_seconds_used, paid_seconds_total, paid_seconds_used, topup_seconds_balance")
      .maybeSingle();

    if (updErr) {
      return res.status(500).json({ error: updErr.message });
    }

    const finalRemaining =
      Math.max(0, (updated?.free_seconds_total ?? 120) - (updated?.free_seconds_used ?? 0)) +
      Math.max(0, (updated?.paid_seconds_total ?? 0) - (updated?.paid_seconds_used ?? 0)) +
      Math.max(0, (updated?.topup_seconds_balance ?? 0));

    return res.status(200).json({
      ok: true,
      finalized: true,
      remaining_seconds: finalRemaining,
      usage: updated,
    });
  } catch (error) {
    console.error("finalize-session error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
