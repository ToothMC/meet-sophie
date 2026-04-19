// api/extra-intelligence/accept-privacy.js
// Persistiert die xi-Privacy-Einwilligung in xi_privacy_acceptances.
// Wird von extra-intelligence/index.html aufgerufen, nachdem der User
// die Checkbox im Privacy-Modal bestaetigt hat. /api/session prueft
// danach gegen diese Tabelle, bevor ein xi-Realtime-Token ausgegeben
// wird (XI-2: Nachweisbare Einwilligung, § 201 StGB / § 120 StGB).

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { CURRENT_XI_PRIVACY_VERSION } from "../../lib/xi-constants.js";

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
      return res.status(500).json({ error: "Missing env vars" });
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: "Invalid token" });

    const EXTRA_INTELLIGENCE_ENABLED = String(process.env.EXTRA_INTELLIGENCE_ENABLED || "false").toLowerCase() === "true";
    if (!EXTRA_INTELLIGENCE_ENABLED) {
      return res.status(404).json({ error: "extra_intelligence_not_available" });
    }

    const rawVersion = String(req.body?.version || CURRENT_XI_PRIVACY_VERSION).trim();
    if (rawVersion !== CURRENT_XI_PRIVACY_VERSION) {
      return res.status(409).json({
        error: "xi_privacy_version_mismatch",
        current_version: CURRENT_XI_PRIVACY_VERSION,
      });
    }

    const userAgent = String(req.headers["user-agent"] || "").slice(0, 500) || null;
    const forwardedFor = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const rawIp = forwardedFor || req.socket?.remoteAddress || "";
    const ipHash = rawIp ? createHash("sha256").update(rawIp).digest("hex") : null;

    const { data: inserted, error: insertErr } = await supabase
      .from("xi_privacy_acceptances")
      .insert({
        user_id: user.id,
        version: CURRENT_XI_PRIVACY_VERSION,
        user_agent: userAgent,
        ip_hash: ipHash,
      })
      .select("id, accepted_at, version")
      .single();

    if (insertErr) {
      console.error("[xi accept-privacy] insert failed:", insertErr.message);
      return res.status(500).json({ error: "xi_privacy_persist_failed" });
    }

    return res.status(200).json({
      ok: true,
      id: inserted.id,
      accepted_at: inserted.accepted_at,
      version: inserted.version,
    });
  } catch (err) {
    console.error("[xi accept-privacy] unexpected error:", err?.message || err);
    return res.status(500).json({ error: "xi_privacy_persist_failed" });
  }
}
