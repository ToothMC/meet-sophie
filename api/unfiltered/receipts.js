// api/unfiltered/receipts.js — Subtext-Analyse von Screenshot oder Text.
//
// Sophie ruft im Unfiltered-Substate das Tool analyze_receipt(purpose),
// das Frontend öffnet einen Upload-Dialog, der User schickt Bild und/
// oder Text hier her, wir liefern strukturierte JSON-Analyse zurück.
//
// POST /api/unfiltered/receipts
//   Body: {
//     text?:           string,        // Nachrichten-Text (optional)
//     image_base64?:   string,        // base64 Foto/Screenshot (optional)
//     image_mime?:     string,        // default "image/jpeg"
//     purpose?:        string,        // was geprüft werden soll
//     language?:       "de"|"en"
//   }
//
// Response:
//   {
//     shady_score: 0-10,
//     passive_aggressive_score: 0-10,
//     drama_risk: 0-10,
//     worth_replying: "yes"|"no"|"maybe",
//     key_observation: string,
//     sophie_take: string,
//     possible_innocent_reading: string,
//     suggested_reply: string|null
//   }

import { createClient } from "@supabase/supabase-js";

const VISION_MODEL = "gpt-4o";   // Vision-fähig, günstiger als gpt-5.1 für dieses Schema
const MAX_TEXT_LENGTH  = 4000;
const MAX_IMAGE_BYTES  = 7 * 1024 * 1024;   // ~5 MB raw → ~7 MB base64

function buildSystem(language) {
  const isEN = language === "en";
  return isEN
    ? `You are Sophie analyzing a private message or screenshot for subtext.
Be honest. If the message is harmless, say so. If it's a jab, name it.
Never invent facts about the sender. Stay in your Unfiltered tone but
keep the JSON contract — no prose outside the JSON object.`
    : `Du bist Sophie und analysierst eine private Nachricht oder einen
Screenshot auf Subtext. Sei ehrlich. Wenn die Nachricht harmlos ist,
sag es. Wenn sie ein Seitenhieb ist, benenne es. Erfinde keine Fakten
über den Absender. Bleib im Unfiltered-Ton — aber halte das JSON-
Schema strikt ein, kein Prosa ausserhalb des JSON-Objekts.`;
}

function buildSchemaPrompt(language, purpose) {
  const isEN = language === "en";
  const purposeLine = purpose
    ? (isEN ? `\nWhat the user wants checked: ${purpose}` : `\nWas der User geprüft wissen will: ${purpose}`)
    : "";

  return isEN
    ? `Return ONLY this JSON shape:
{
  "shady_score":              0-10,
  "passive_aggressive_score": 0-10,
  "drama_risk":               0-10,
  "worth_replying":           "yes" | "no" | "maybe",
  "key_observation":          "one short sentence — what's really in there",
  "sophie_take":              "your honest read, sharp but fair, 2-4 sentences",
  "possible_innocent_reading":"the kindlier explanation, if any exists; '' if none",
  "suggested_reply":          "short reply suggestion if worth_replying != 'no', otherwise null"
}${purposeLine}`
    : `Liefere AUSSCHLIESSLICH dieses JSON:
{
  "shady_score":              0-10,
  "passive_aggressive_score": 0-10,
  "drama_risk":               0-10,
  "worth_replying":           "yes" | "no" | "maybe",
  "key_observation":          "ein kurzer Satz — was wirklich drinsteckt",
  "sophie_take":              "deine ehrliche Lesart, scharf aber fair, 2-4 Sätze",
  "possible_innocent_reading":"die freundlichere Erklärung, falls existent; '' wenn keine",
  "suggested_reply":          "kurzer Antwortvorschlag wenn worth_replying != 'no', sonst null"
}${purposeLine}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing Authorization Bearer token" });
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "Missing env vars" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: "Invalid token" });

    const body = req.body || {};
    const text     = typeof body.text === "string" ? body.text.slice(0, MAX_TEXT_LENGTH) : "";
    const image64  = typeof body.image_base64 === "string" ? body.image_base64 : "";
    const mime     = typeof body.image_mime === "string" && /^image\/(jpeg|png|webp|gif)$/i.test(body.image_mime)
                       ? body.image_mime : "image/jpeg";
    const purpose  = typeof body.purpose === "string" ? body.purpose.slice(0, 400) : "";
    const language = body.language === "en" ? "en" : "de";

    if (!text && !image64) {
      return res.status(400).json({ error: "text or image_base64 required" });
    }
    if (image64.length > MAX_IMAGE_BYTES) {
      return res.status(413).json({ error: "image too large (max 5MB)" });
    }

    // OpenAI Vision messages
    const content = [];
    if (text) content.push({ type: "text", text: (language === "en" ? "Message: " : "Nachricht: ") + text });
    if (image64) {
      // Falls Client schon eine dataURL geliefert hat, nicht doppelt prefixen
      const url = image64.startsWith("data:") ? image64 : `data:${mime};base64,${image64}`;
      content.push({ type: "image_url", image_url: { url, detail: "low" } });
    }
    content.push({ type: "text", text: buildSchemaPrompt(language, purpose) });

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        response_format: { type: "json_object" },
        temperature: 0.4,
        messages: [
          { role: "system", content: buildSystem(language) },
          { role: "user",   content },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.warn("[unf/receipts] vision failed:", r.status, errText.slice(0, 200));
      return res.status(502).json({ error: "vision_failed" });
    }

    const j = await r.json();
    let analysis;
    try { analysis = JSON.parse(j.choices?.[0]?.message?.content || "{}"); }
    catch (e) {
      console.warn("[unf/receipts] JSON parse failed:", e.message);
      return res.status(502).json({ error: "invalid_json" });
    }

    // Defensives Schema-Squashing
    const clamp = (v) => Math.max(0, Math.min(10, Math.round(Number(v) || 0)));
    const wr = ["yes", "no", "maybe"].includes(analysis.worth_replying) ? analysis.worth_replying : "maybe";

    return res.status(200).json({
      shady_score:                clamp(analysis.shady_score),
      passive_aggressive_score:   clamp(analysis.passive_aggressive_score),
      drama_risk:                 clamp(analysis.drama_risk),
      worth_replying:             wr,
      key_observation:            String(analysis.key_observation || "").slice(0, 400),
      sophie_take:                String(analysis.sophie_take || "").slice(0, 1200),
      possible_innocent_reading:  String(analysis.possible_innocent_reading || "").slice(0, 400),
      suggested_reply:            wr === "no" ? null : (analysis.suggested_reply ? String(analysis.suggested_reply).slice(0, 600) : null),
      model: VISION_MODEL,
    });
  } catch (err) {
    console.error("[unf/receipts] error:", err);
    return res.status(500).json({ error: err?.message || "internal_error" });
  }
}
