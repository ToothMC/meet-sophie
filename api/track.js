import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
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
      meta: meta || {}
    });

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("Track error:", err);
    return res.status(500).json({ error: "Tracking failed" });
  }
}
