// api/user.js — Konsolidierter User-Endpoint
// ?action=track  → track
// ?action=usage  → usage

import { createClient } from "@supabase/supabase-js";
import { DEFAULT_FREE_TOKENS, SECONDS_PER_TOKEN } from "../lib/billing-constants.js";

// ---------------------------------------------------------------------------
// Action: track
// ---------------------------------------------------------------------------

async function handleTrack(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { event_name, meta } = req.body || {};
    if (!event_name) {
      return res.status(400).json({ error: "Missing event_name" });
    }

    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing token" });

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: "Invalid user" });
    }

    await supabase.from("analytics_events").insert({
      user_id: user.id,
      event_name,
      meta: meta || {},
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("user/track error:", err);
    return res.status(500).json({ error: "Tracking failed" });
  }
}

// ---------------------------------------------------------------------------
// Action: usage
// ---------------------------------------------------------------------------

async function handleUsage(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing Authorization Bearer token" });

    const { tokens_used, seconds_used } = req.body || {};
    // Accept tokens_used (primary) or seconds_used (backward compat, convert to tokens)
    let tokensToCharge;
    if (tokens_used != null) {
      tokensToCharge = Math.max(0, Math.min(600, Number(tokens_used || 0)));
    } else {
      const sec = Number(seconds_used || 0);
      tokensToCharge = Math.max(0, Math.min(600, Math.ceil(sec / SECONDS_PER_TOKEN)));
    }
    if (!tokensToCharge) return res.status(200).json({ ok: true, ignored: true });

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars" });
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) return res.status(401).json({ error: "Invalid token" });

    let { data: usage, error: usageErr } = await supabase
      .from("user_usage")
      .select("free_tokens_total, free_tokens_used, paid_tokens_total, paid_tokens_used, topup_tokens_balance")
      .eq("user_id", user.id)
      .maybeSingle();

    if (usageErr) return res.status(500).json({ error: usageErr.message });

    if (!usage) {
      const ins = await supabase.from("user_usage").insert({
        user_id: user.id,
        free_tokens_total: DEFAULT_FREE_TOKENS, free_tokens_used: 0,
        paid_tokens_total: 0, paid_tokens_used: 0, topup_tokens_balance: 0,
      }).select().maybeSingle();
      if (ins.error) return res.status(500).json({ error: ins.error.message });
      usage = ins.data;
    }

    const freeTotal = usage?.free_tokens_total ?? DEFAULT_FREE_TOKENS;
    const freeUsed  = usage?.free_tokens_used  ?? 0;
    const paidTotal = usage?.paid_tokens_total  ?? 0;
    const paidUsed  = usage?.paid_tokens_used   ?? 0;
    const topupBal  = usage?.topup_tokens_balance ?? 0;

    const freeRemaining  = Math.max(0, freeTotal - freeUsed);
    const paidRemaining  = Math.max(0, paidTotal - paidUsed);
    const topupRemaining = Math.max(0, topupBal);
    const totalRemaining = freeRemaining + paidRemaining + topupRemaining;

    if (totalRemaining <= 0) {
      return res.status(402).json({ error: "No remaining time", remaining_tokens: 0, remaining_seconds: 0 });
    }

    let toCharge = tokensToCharge;
    const chargeFree  = Math.min(freeRemaining, toCharge);  toCharge -= chargeFree;
    const chargePaid  = Math.min(paidRemaining, toCharge);  toCharge -= chargePaid;
    const chargeTopup = Math.min(topupRemaining, toCharge); toCharge -= chargeTopup;

    const newFreeUsed = Math.min(freeTotal, freeUsed + chargeFree);
    const newPaidUsed = Math.min(paidTotal, paidUsed + chargePaid);
    const newTopupBal = Math.max(0, topupBal - chargeTopup);

    const upd = await supabase
      .from("user_usage")
      .update({ free_tokens_used: newFreeUsed, paid_tokens_used: newPaidUsed, topup_tokens_balance: newTopupBal })
      .eq("user_id", user.id)
      .select("free_tokens_total, free_tokens_used, paid_tokens_total, paid_tokens_used, topup_tokens_balance")
      .maybeSingle();

    if (upd.error) return res.status(500).json({ error: upd.error.message });

    const u2 = upd.data;
    const rem =
      Math.max(0, (u2.free_tokens_total ?? DEFAULT_FREE_TOKENS) - (u2.free_tokens_used ?? 0)) +
      Math.max(0, (u2.paid_tokens_total ?? 0)   - (u2.paid_tokens_used ?? 0)) +
      Math.max(0, (u2.topup_tokens_balance ?? 0));

    return res.status(200).json({
      ok: true,
      charged_tokens: (tokensToCharge - toCharge),
      buckets: { free: chargeFree, paid: chargePaid, topup: chargeTopup },
      remaining_tokens: rem,
      remaining_seconds: rem * SECONDS_PER_TOKEN,
      usage: u2,
    });
  } catch (e) {
    console.error("user/usage error:", e);
    return res.status(500).json({ error: "Usage update failed" });
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  const action = req.query?.action;
  switch (action) {
    case "track": return handleTrack(req, res);
    case "usage": return handleUsage(req, res);
    default:
      return res.status(400).json({ error: "Missing or invalid ?action. Use: track | usage" });
  }
}
