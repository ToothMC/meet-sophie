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

    // usage row holen (oder anlegen)
    let { data: usage, error: usageErr } = await supabase
      .from("user_usage")
      .select("free_seconds_total, free_seconds_used, paid_seconds_total, paid_seconds_used, topup_seconds_balance")
      .eq("user_id", user.id)
      .maybeSingle();

    if (usageErr) return res.status(500).json({ error: usageErr.message });

    if (!usage) {
      const ins = await supabase.from("user_usage").insert({
        user_id: user.id,
        free_seconds_total: 120,
        free_seconds_used: 0,
        paid_seconds_total: 0,
        paid_seconds_used: 0,
        topup_seconds_balance: 0,
      }).select().maybeSingle();

      if (ins.error) return res.status(500).json({ error: ins.error.message });
      usage = ins.data;
    }

    const freeTotal = usage?.free_seconds_total ?? 120;
    const freeUsed  = usage?.free_seconds_used ?? 0;
    const paidTotal = usage?.paid_seconds_total ?? 0;
    const paidUsed  = usage?.paid_seconds_used ?? 0;
    const topupBal  = usage?.topup_seconds_balance ?? 0;

    const freeRemaining  = Math.max(0, freeTotal - freeUsed);
    const paidRemaining  = Math.max(0, paidTotal - paidUsed);
    const topupRemaining = Math.max(0, topupBal);

    const totalRemaining = freeRemaining + paidRemaining + topupRemaining;
    if (totalRemaining <= 0) {
      return res.status(402).json({ error: "No remaining time", remaining_seconds: 0 });
    }

    // Abbuchung: free -> paid -> topup
    let toCharge = sec;

    const chargeFree = Math.min(freeRemaining, toCharge);
    toCharge -= chargeFree;

    const chargePaid = Math.min(paidRemaining, toCharge);
    toCharge -= chargePaid;

    const chargeTopup = Math.min(topupRemaining, toCharge);
    toCharge -= chargeTopup;

    // Wenn mehr reported wurde als verfügbar: wir kappen hart auf verfügbar
    // (kein negativer Balance, kein Overdraw)
    const newFreeUsed = Math.min(freeTotal, freeUsed + chargeFree);
    const newPaidUsed = Math.min(paidTotal, paidUsed + chargePaid);
    const newTopupBal = Math.max(0, topupBal - chargeTopup);

    const upd = await supabase
      .from("user_usage")
      .update({
        free_seconds_used: newFreeUsed,
        paid_seconds_used: newPaidUsed,
        topup_seconds_balance: newTopupBal,
      })
      .eq("user_id", user.id)
      .select("free_seconds_total, free_seconds_used, paid_seconds_total, paid_seconds_used, topup_seconds_balance")
      .maybeSingle();

    if (upd.error) return res.status(500).json({ error: upd.error.message });

    const u2 = upd.data;
    const rem =
      Math.max(0, (u2.free_seconds_total ?? 120) - (u2.free_seconds_used ?? 0)) +
      Math.max(0, (u2.paid_seconds_total ?? 0) - (u2.paid_seconds_used ?? 0)) +
      Math.max(0, (u2.topup_seconds_balance ?? 0));

    return res.status(200).json({
      ok: true,
      charged_seconds: (sec - toCharge),
      buckets: {
        free: chargeFree,
        paid: chargePaid,
        topup: chargeTopup,
      },
      remaining_seconds: rem,
      usage: u2,
    });
  } catch (e) {
    console.error("Usage update error:", e);
    return res.status(500).json({ error: "Usage update failed" });
  }
}
