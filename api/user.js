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

    // Atomic deduction via Postgres RPC (prevents race conditions)
    const { data: result, error: rpcErr } = await supabase.rpc("deduct_tokens", {
      p_user_id: user.id,
      p_amount: tokensToCharge,
    });

    if (rpcErr) {
      // If RPC fails (e.g. user has no row), try creating the row first
      if (rpcErr.message?.includes("NOT FOUND") || !result?.length) {
        await supabase.from("user_usage").insert({
          user_id: user.id,
          free_tokens_total: DEFAULT_FREE_TOKENS, free_tokens_used: 0,
          paid_tokens_total: 0, paid_tokens_used: 0, topup_tokens_balance: 0,
        }).catch(() => {});
        return res.status(402).json({ error: "No remaining tokens", remaining_tokens: 0, remaining_seconds: 0 });
      }
      return res.status(500).json({ error: rpcErr.message });
    }

    const r = Array.isArray(result) ? result[0] : result;
    if (!r || r.charged === 0) {
      return res.status(402).json({ error: "No remaining tokens", remaining_tokens: 0, remaining_seconds: 0 });
    }

    // Check if we should suggest eco mode (1× per account lifetime)
    let suggestEco = false;
    const totalTokens = (r.free_tokens_total || 0) + (r.paid_tokens_total || 0) + (r.topup_tokens_balance || 0);
    if (totalTokens > 0 && r.remaining / totalTokens < 0.10) {
      try {
        const { data: prof } = await supabase.from("user_profile")
          .select("eco_mode, eco_hint_shown")
          .eq("user_id", user.id).maybeSingle();
        if (prof && !prof.eco_mode && !prof.eco_hint_shown) {
          suggestEco = true;
          await supabase.from("user_profile")
            .update({ eco_hint_shown: true })
            .eq("user_id", user.id);
        }
      } catch (_) {}
    }

    return res.status(200).json({
      ok: true,
      charged_tokens: r.charged,
      buckets: { free: r.free_charged, paid: r.paid_charged, topup: r.topup_charged },
      remaining_tokens: r.remaining,
      remaining_seconds: r.remaining * SECONDS_PER_TOKEN,
      suggest_eco: suggestEco,
      usage: {
        free_tokens_total: r.free_tokens_total, free_tokens_used: r.free_tokens_used,
        paid_tokens_total: r.paid_tokens_total, paid_tokens_used: r.paid_tokens_used,
        topup_tokens_balance: r.topup_tokens_balance,
      },
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
