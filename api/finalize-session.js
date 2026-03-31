import { createClient } from "@supabase/supabase-js";
import { DEFAULT_FREE_TOKENS } from "../lib/billing-constants.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing Authorization Bearer token" });

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars" });
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) return res.status(401).json({ error: "Invalid token" });

    const { reason } = req.body || {};
    const forceFinalize = reason === "time_limit_reached";

    // Read current balance
    const { data: usage, error: usageErr } = await supabase
      .from("user_usage")
      .select("free_tokens_total, free_tokens_used, paid_tokens_total, paid_tokens_used, topup_tokens_balance")
      .eq("user_id", user.id)
      .maybeSingle();

    if (usageErr) return res.status(500).json({ error: usageErr.message });
    if (!usage) return res.status(200).json({ ok: true, finalized: false, reason: "no_usage_row" });

    const freeRem = Math.max(0, (usage.free_tokens_total ?? DEFAULT_FREE_TOKENS) - (usage.free_tokens_used ?? 0));
    const paidRem = Math.max(0, (usage.paid_tokens_total ?? 0) - (usage.paid_tokens_used ?? 0));
    const topupRem = Math.max(0, usage.topup_tokens_balance ?? 0);
    const totalRemaining = freeRem + paidRem + topupRem;

    if (!forceFinalize && totalRemaining > 1) {
      return res.status(200).json({ ok: true, finalized: false, reason: "still_tokens_left", remaining_tokens: totalRemaining });
    }

    // Use atomic RPC to deduct ALL remaining tokens (prevents race with user.js)
    const { data: result, error: rpcErr } = await supabase.rpc("deduct_tokens", {
      p_user_id: user.id,
      p_amount: 999999, // deduct everything — RPC caps at actual remaining
    });

    if (rpcErr) {
      console.error("finalize deduct_tokens RPC error:", rpcErr);
      return res.status(500).json({ error: rpcErr.message });
    }

    const r = Array.isArray(result) ? result[0] : result;

    return res.status(200).json({
      ok: true,
      finalized: true,
      forced: forceFinalize,
      remaining_tokens: r?.remaining ?? 0,
      charged_tokens: r?.charged ?? 0,
    });
  } catch (error) {
    console.error("finalize-session error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
