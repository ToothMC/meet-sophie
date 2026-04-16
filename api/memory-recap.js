import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { runRecapForSession } from "../lib/memory-recap-core.js";

// =========================================================
// api/memory-recap
// =========================================================
// Thin HTTP wrapper around lib/memory-recap-core.js for external callers.
// Direct server-side callers should import runRecapForSession() instead
// to avoid self-HTTP between Vercel functions.
// =========================================================

function hashIp(ip) {
  if (!ip) return "none";
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

export default async function handler(req, res) {
  try {
    // --- CORS / Preflight ---
    const ALLOWED_ORIGINS = new Set([
      "https://meet-sophie.com",
      "https://www.meet-sophie.com",
      "https://meet-sophie.ai",
      "https://www.meet-sophie.ai",
    ]);
    const origin = (req.headers.origin || "").toString();

    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      if (!origin || !ALLOWED_ORIGINS.has(origin)) {
        try {
          const logSupabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
          await logSupabase.from("analytics_events").insert({
            event_name: "security_cors_rejected_origin",
            meta: {
              route: "/api/memory-recap",
              origin: origin || "none",
              ip_hash: hashIp(req.headers["x-forwarded-for"] || req.socket?.remoteAddress),
            },
          });
        } catch { /* non-fatal */ }
        return res.status(403).end();
      }
      return res.status(204).end();
    }

    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    // --- Body ---
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body && typeof body === "object" ? body : {};

    const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : "";
    const force = body.force === true || body.force === 1 || body.force === "1";

    if (!sessionId) return res.status(400).json({ error: "session_id required" });

    // --- Auth ---
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing Authorization Bearer token" });

    if (!process.env.SUPABASE_URL) return res.status(500).json({ error: "Missing SUPABASE_URL" });
    if (!process.env.SUPABASE_ANON_KEY) return res.status(500).json({ error: "Missing SUPABASE_ANON_KEY" });
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr || !user) return res.status(401).json({ error: "Invalid token" });

    const result = await runRecapForSession({
      supabase,
      sessionId,
      userId: user.id,
      force,
    });

    if (!result.ok) {
      const status =
        result.error === "session not found" ? 404 :
        result.error === "forbidden" ? 403 :
        result.error?.startsWith?.("generation:") ? 502 : 500;
      return res.status(status).json({ error: result.error });
    }

    return res.status(200).json(result);
  } catch (e) {
    console.error("[memory-recap] unhandled:", e?.message || e);
    return res.status(500).json({ error: "internal", detail: String(e?.message || e).slice(0, 200) });
  }
}
