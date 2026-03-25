// api/tts.js — Text-to-Speech via OpenAI
// Uses the SAME Sophie voice (shimmer) and speaking style as Talk mode
// POST { text } → audio/mpeg stream

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const text = (body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "Missing text" });
  if (text.length > 2000) return res.status(400).json({ error: "Text too long (max 2000 chars)" });

  try {
    const resp = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: "shimmer", // Same voice as Talk mode (api/session.js)
        input: text,
        instructions: "You are Sophie. Speak warmly, naturally, and conversationally — like a trusted colleague in a meeting. Not robotic or overly formal. Calm, clear, slightly playful. Same personality as in a voice call.",
        response_format: "mp3",
        speed: 1.0,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error("TTS API error:", resp.status, errText.slice(0, 200));
      return res.status(resp.status).json({ error: "TTS API error" });
    }

    // Stream audio back to client
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-cache");

    const buffer = await resp.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (e) {
    console.error("TTS error:", e?.message);
    return res.status(502).json({ error: "TTS unavailable" });
  }
}
