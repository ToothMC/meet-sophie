import { calculateCost } from "./ai/types.js";
import { trackCost } from "./ai/cost-tracker.js";

// =========================================================
// Memory Recap — core logic
// =========================================================
// Generates a ~150-token structured recap of a finished session
// and persists it to conversation_outputs.recap_text.
//
// Callable from:
//   - api/memory-recap.js (thin HTTP wrapper, auth via Bearer)
//   - api/memory-update.js (direct import after session row is written)
//
// Direct import avoids self-HTTP between serverless functions
// (unreliable across preview vs prod URLs and deployment protection).
// =========================================================

const RECAP_MAX_OUTPUT_TOKENS = 250;   // ~150 tokens target, 250 cap for safety
const TRANSCRIPT_CHAR_BUDGET  = 12000; // ~3000 input tokens cap per call

function buildSystemPrompt(lang) {
  const langLine = lang === "de"
    ? "Antworte auf Deutsch."
    : lang === "fr"
    ? "Réponds en français."
    : "Respond in English.";

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

function buildUserMessage({ transcript, mode, durationSec, sessionDate }) {
  const durationMin = Math.max(1, Math.round((durationSec || 0) / 60));
  const header = `Session mode: ${mode || "talk"} | Duration: ${durationMin} min | Date: ${sessionDate || "unknown"}`;
  let body = transcript.trim();
  if (body.length > TRANSCRIPT_CHAR_BUDGET) {
    body = "[...earlier turns trimmed...]\n" + body.slice(body.length - TRANSCRIPT_CHAR_BUDGET);
  }
  return `${header}\n\nTRANSCRIPT:\n${body}`;
}

function transcriptFromMessages(rows) {
  return rows
    .filter((m) => m && m.text)
    .map((m) => `${m.role === "user" ? "User" : "Sophie"}: ${String(m.text).trim()}`)
    .join("\n");
}

function detectLanguage({ messages, structuredSummary }) {
  if (structuredSummary && typeof structuredSummary === "object" && typeof structuredSummary.language === "string") {
    return structuredSummary.language.toLowerCase();
  }
  const userText = messages.filter(m => m.role === "user").slice(0, 3).map(m => m.text || "").join(" ").toLowerCase();
  if (/\b(und|ich|nicht|habe|werden|können)\b/.test(userText)) return "de";
  if (/\b(et|je|pas|avons|pouvez|serait)\b/.test(userText)) return "fr";
  return "en";
}

async function callOpenAI({ apiKey, systemPrompt, userMsg, userId }) {
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

/**
 * Run recap generation for a session.
 *
 * @param {Object}   params
 * @param {Object}   params.supabase  — authenticated supabase client (user JWT or service role)
 * @param {string}   params.sessionId — user_sessions.id
 * @param {string}   params.userId    — auth.uid() of the owner (for ownership check + cost tracking)
 * @param {boolean}  [params.force]   — regenerate even if recap_text already exists
 * @returns {Promise<{ok:boolean, cached?:boolean, skipped?:string, recap_text?:string, recap_generated_at?:string, error?:string}>}
 */
export async function runRecapForSession({ supabase, sessionId, userId, force = false }) {
  if (!supabase) return { ok: false, error: "supabase client required" };
  if (!sessionId) return { ok: false, error: "sessionId required" };
  if (!userId) return { ok: false, error: "userId required" };

  // Session meta + ownership check
  const { data: sessionRow, error: sessErr } = await supabase
    .from("user_sessions")
    .select("id, user_id, session_mode, session_type, session_date, duration_seconds")
    .eq("id", sessionId)
    .maybeSingle();

  if (sessErr) return { ok: false, error: `session lookup: ${sessErr.message}` };
  if (!sessionRow) return { ok: false, error: "session not found" };
  if (sessionRow.user_id !== userId) return { ok: false, error: "forbidden" };

  // Existing output row (for idempotency + structured_summary.language hint)
  const { data: outputRow, error: outErr } = await supabase
    .from("conversation_outputs")
    .select("id, session_id, recap_text, recap_generated_at, structured_summary")
    .eq("session_id", sessionId)
    .maybeSingle();

  if (outErr) return { ok: false, error: `output lookup: ${outErr.message}` };

  if (outputRow?.recap_text && !force) {
    return {
      ok: true,
      cached: true,
      recap_text: outputRow.recap_text,
      recap_generated_at: outputRow.recap_generated_at,
    };
  }

  // Transcript
  const { data: messages, error: msgErr } = await supabase
    .from("conversation_messages")
    .select("role, text, seq, created_at")
    .eq("session_id", sessionId)
    .order("seq", { ascending: true });

  if (msgErr) return { ok: false, error: `messages lookup: ${msgErr.message}` };
  if (!messages || messages.length === 0) return { ok: true, skipped: "no_messages" };

  const transcript = transcriptFromMessages(messages);
  if (!transcript.trim()) return { ok: true, skipped: "empty_transcript" };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "OPENAI_API_KEY missing" };

  const lang = detectLanguage({ messages, structuredSummary: outputRow?.structured_summary });
  const systemPrompt = buildSystemPrompt(lang);
  const userMsg = buildUserMessage({
    transcript,
    mode: sessionRow.session_mode || sessionRow.session_type,
    durationSec: sessionRow.duration_seconds,
    sessionDate: sessionRow.session_date,
  });

  let recapText = "";
  try {
    recapText = await callOpenAI({ apiKey, systemPrompt, userMsg, userId });
  } catch (e) {
    return { ok: false, error: `generation: ${String(e?.message || e).slice(0, 200)}` };
  }

  if (!recapText) return { ok: true, skipped: "empty_output" };

  const nowIso = new Date().toISOString();

  if (outputRow?.id) {
    const { error: updErr } = await supabase
      .from("conversation_outputs")
      .update({ recap_text: recapText, recap_generated_at: nowIso })
      .eq("id", outputRow.id);
    if (updErr) return { ok: false, error: `persist: ${updErr.message}` };
  } else {
    const { error: insErr } = await supabase
      .from("conversation_outputs")
      .insert({ session_id: sessionId, recap_text: recapText, recap_generated_at: nowIso });
    if (insErr) return { ok: false, error: `persist: ${insErr.message}` };
  }

  return {
    ok: true,
    cached: false,
    recap_text: recapText,
    recap_generated_at: nowIso,
  };
}
