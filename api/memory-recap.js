import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { calculateCost } from "../lib/ai/types.js";
import { trackCost } from "../lib/ai/cost-tracker.js";

// =========================================================
// api/memory-recap
// =========================================================
// Generates a ~150-token structured recap of a finished
// session and persists it in conversation_outputs.recap_text.
//
// The recap is the source of truth for Tier N ("Jetzt") memory
// in the next session — injected verbatim into the system prompt
// instead of truncated transcript snippets.
//
// Called by /api/memory-update after transcript is persisted.
// Idempotent: returns existing recap if already generated,
// unless ?force=1 is passed.
// =========================================================

const RECAP_MAX_OUTPUT_TOKENS = 250;  // ~150 tokens target, 250 cap for safety
const TRANSCRIPT_CHAR_BUDGET = 12000; // ~3000 input tokens cap per call

function hashIp(ip) {
  if (!ip) return "none";
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

function buildRecapSystemPrompt(lang) {
  const langLine = lang === "de"
    ? "Antworte auf Deutsch."
    : lang === "fr"
    ? "Réponds en français."
    : "Respond in English.";

  // Strict schema — Sophie's next session reads this verbatim
  return [
    "You are generating a compact recap of a finished Sophie session.",
    "This recap will be injected into the system prompt of the NEXT session so Sophie can pick up naturally.",
    "",
    "HARD RULES:",
    "- Output ONLY the filled-in template below. No commentary, no markdown fences, no preamble.",
    "- Max 150 tokens total. Be terse.",
    "- " + langLine,
    "- If a field has no content, write a single dash (-).",
    "- Never invent facts. Only what the transcript supports.",
    "",
    "TEMPLATE (fill in between angle brackets, keep labels):",
    "Thema: <one short phrase>",
    "User-Position: <user's stance or goal in one line>",
    "Kernpunkte:",
    "  • <bullet 1>",
    "  • <bullet 2>",
    "  • <bullet 3 if relevant>",
    "Offen: <open thread or pending decision, or ->",
    "Ton: <emotional tone in 1-2 words>",
  ].join("\n");
}

function buildRecapUserMessage({ transcript, mode, durationSec, sessionDate }) {
  const durationMin = Math.max(1, Math.round((durationSec || 0) / 60));
  const header = `Session mode: ${mode || "talk"} | Duration: ${durationMin} min | Date: ${sessionDate || "unknown"}`;
  let body = transcript.trim();
  if (body.length > TRANSCRIPT_CHAR_BUDGET) {
    // Keep the end of the conversation — most relevant for "was ist offen"
    body = "[...earlier turns trimmed...]\n" + body.slice(body.length - TRANSCRIPT_CHAR_BUDGET);
  }
  return `${header}\n\nTRANSCRIPT:\n${body}`;
}

function transcriptFromMessages(rows) {
  // rows: [{ role, text, seq, created_at }]
  return rows
    .filter((m) => m && m.text)
    .map((m) => `${m.role === "user" ? "User" : "Sophie"}: ${String(m.text).trim()}`)
    .join("\n");
}

async function generateRecap({ apiKey, systemPrompt, userMsg, userId }) {
  const model = process.env.MEMORY_MODEL || "gpt-4o-mini";

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMsg },
      ],
      temperature: 0.2,
      max_output_tokens: RECAP_MAX_OUTPUT_TOKENS,
      truncation: "auto",
    }),
  });

  if (!r.ok) {
    const errTxt = await r.text().catch(() => "");
    throw new Error(`recap API ${r.status}: ${errTxt.slice(0, 200)}`);
  }

  const out = await r.json();
  const text =
    out?.output_text ||
    out?.output?.[0]?.content?.find?.((c) => c.type === "output_text")?.text ||
    "";

  // Cost tracking (non-fatal if it fails)
  if (out?.usage) {
    try {
      const cost = calculateCost(model, out.usage.input_tokens || 0, out.usage.output_tokens || 0);
      trackCost({
        userId: userId || null,
        provider: "openai",
        model,
        inputTokens: out.usage.input_tokens || 0,
        outputTokens: out.usage.output_tokens || 0,
        costUsd: cost,
        latencyMs: 0,
        routingReason: "memory-recap",
      }).catch(() => {});
    } catch { /* non-fatal */ }
  }

  return text.trim();
}

export default async function handler(req, res) {
  try {
    // --- CORS / Preflight (same allowlist as memory-update) ---
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

    // Supabase client with user JWT (so RLS enforces ownership)
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr || !user) return res.status(401).json({ error: "Invalid token" });

    // --- Load session meta + existing output row (RLS scopes this to the user) ---
    const { data: sessionRow, error: sessErr } = await supabase
      .from("user_sessions")
      .select("id, user_id, session_type, session_date, duration_sec")
      .eq("id", sessionId)
      .maybeSingle();

    if (sessErr) {
      console.error("[memory-recap] session lookup failed:", sessErr.message);
      return res.status(500).json({ error: "session lookup failed" });
    }
    if (!sessionRow) return res.status(404).json({ error: "session not found" });
    if (sessionRow.user_id !== user.id) return res.status(403).json({ error: "forbidden" });

    const { data: outputRow, error: outErr } = await supabase
      .from("conversation_outputs")
      .select("id, session_id, recap_text, recap_generated_at, structured_summary")
      .eq("session_id", sessionId)
      .maybeSingle();

    if (outErr) {
      console.error("[memory-recap] output lookup failed:", outErr.message);
      return res.status(500).json({ error: "output lookup failed" });
    }

    // Idempotency: return existing unless forced
    if (outputRow?.recap_text && !force) {
      return res.status(200).json({
        ok: true,
        cached: true,
        recap_text: outputRow.recap_text,
        recap_generated_at: outputRow.recap_generated_at,
      });
    }

    // --- Load transcript ---
    const { data: messages, error: msgErr } = await supabase
      .from("conversation_messages")
      .select("role, text, seq, created_at")
      .eq("session_id", sessionId)
      .order("seq", { ascending: true });

    if (msgErr) {
      console.error("[memory-recap] messages lookup failed:", msgErr.message);
      return res.status(500).json({ error: "messages lookup failed" });
    }

    if (!messages || messages.length === 0) {
      return res.status(200).json({ ok: true, skipped: "no_messages" });
    }

    const transcript = transcriptFromMessages(messages);
    if (!transcript.trim()) {
      return res.status(200).json({ ok: true, skipped: "empty_transcript" });
    }

    // --- Detect language from user messages (simple heuristic via existing short_summary lang marker if present) ---
    // Fallback: use German for DACH-heavy user base. Prompt asks model to match anyway.
    const lang = (() => {
      const ss = outputRow?.structured_summary;
      if (ss && typeof ss === "object" && typeof ss.language === "string") return ss.language.toLowerCase();
      // Simple heuristic: look at first 3 user turns
      const userText = messages.filter(m => m.role === "user").slice(0, 3).map(m => m.text || "").join(" ").toLowerCase();
      if (/\b(und|ich|nicht|habe|werden|können)\b/.test(userText)) return "de";
      if (/\b(et|je|pas|avons|pouvez|serait)\b/.test(userText)) return "fr";
      return "en";
    })();

    // --- Generate recap ---
    const systemPrompt = buildRecapSystemPrompt(lang);
    const userMsg = buildRecapUserMessage({
      transcript,
      mode: sessionRow.session_type,
      durationSec: sessionRow.duration_sec,
      sessionDate: sessionRow.session_date,
    });

    let recapText = "";
    try {
      recapText = await generateRecap({
        apiKey: process.env.OPENAI_API_KEY,
        systemPrompt,
        userMsg,
        userId: user.id,
      });
    } catch (e) {
      console.error("[memory-recap] generation failed:", e?.message || e);
      return res.status(502).json({ error: "recap generation failed", detail: String(e?.message || e).slice(0, 200) });
    }

    if (!recapText) {
      return res.status(200).json({ ok: true, skipped: "empty_output" });
    }

    // --- Persist ---
    const nowIso = new Date().toISOString();

    if (outputRow?.id) {
      const { error: updErr } = await supabase
        .from("conversation_outputs")
        .update({ recap_text: recapText, recap_generated_at: nowIso })
        .eq("id", outputRow.id);

      if (updErr) {
        console.error("[memory-recap] update failed:", updErr.message);
        return res.status(500).json({ error: "persist failed" });
      }
    } else {
      // No output row yet — create minimal one. memory-update will fill the rest later.
      const { error: insErr } = await supabase
        .from("conversation_outputs")
        .insert({
          session_id: sessionId,
          recap_text: recapText,
          recap_generated_at: nowIso,
        });

      if (insErr) {
        console.error("[memory-recap] insert failed:", insErr.message);
        return res.status(500).json({ error: "persist failed" });
      }
    }

    return res.status(200).json({
      ok: true,
      cached: false,
      recap_text: recapText,
      recap_generated_at: nowIso,
    });
  } catch (e) {
    console.error("[memory-recap] unhandled:", e?.message || e);
    return res.status(500).json({ error: "internal", detail: String(e?.message || e).slice(0, 200) });
  }
}
