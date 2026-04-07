// api/track.js — Public Event-Tracking Endpoint
// Akzeptiert anonyme + authentifizierte Events
// Dedupliziert via event_id (UNIQUE constraint)
// Rate-Limited: 50 Events/Min pro IP

import { createClient } from "@supabase/supabase-js";

// Simple in-memory rate limiter (resets on cold start — acceptable for Phase 1)
const ipCounts = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 50;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = ipCounts.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    ipCounts.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
    if (isRateLimited(ip)) {
      return res.status(429).json({ error: "Too many events" });
    }

    const { event_id, event_name, meta, anonymous_id, session_id, page, device } = req.body || {};
    if (!event_name) {
      return res.status(400).json({ error: "event_name required" });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Optional auth — extract user_id if Bearer token present
    let user_id = null;
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (token) {
      try {
        const { data: { user } } = await supabase.auth.getUser(token);
        user_id = user?.id || null;
      } catch { /* anonymous is fine */ }
    }

    const source = meta?.utm_source || meta?.referrer_host || null;

    // INSERT with ON CONFLICT DO NOTHING for deduplication
    const row = {
      event_name,
      meta: meta || {},
      user_id,
      anonymous_id: anonymous_id || null,
      session_id: session_id || null,
      page: page || null,
      device: device || null,
      source,
    };
    if (event_id) row.event_id = event_id;

    await supabase.from("analytics_events").upsert(row, {
      onConflict: "event_id",
      ignoreDuplicates: true,
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[track] error:", err?.message || err);
    return res.status(500).json({ error: "Tracking failed" });
  }
}
