// api/game.js — Game Night Prototyp ("Sophie – Game Night Unleashed") auf GPT-Live-1.
//
// PROTOTYP / TESTZUGANG: nur fuer E-Mails in GAME_TEST_EMAILS (Env, kommagetrennt)
// bzw. den Default-Testaccount. Kein Billing, kein Gedaechtnis, kein Report,
// keine Eintraege in conversation_messages / Knowledge. Nur Kosten-Tracking
// (ai_request_log) und Test-Auswertung (analytics_events "game_test_session").
//
//   POST /api/game?action=start  {sdp, mode, lang, voice}  -> {sdp, session_id}
//   POST /api/game?action=end    {session_id, mode, seconds, backend_usage, transcript, laughs, rating, voice}
//
// GPT-Live hat keinen Ephemeral-Key: der Server leitet das SDP-Offer an
// POST https://api.openai.com/v1/live/sessions weiter; der API-Key bleibt hier.

import { createClient } from "@supabase/supabase-js";
import { trackCost } from "../lib/ai/cost-tracker.js";
import {
  buildGameInstructions,
  BACKEND_INSTRUCTIONS,
  GAME_TOOLS,
  GAME_MODES,
  GAME_VOICES,
  DEFAULT_GAME_VOICE,
} from "../lib/game/prompt.js";

const LIVE_MODEL = "gpt-live-1";
const LIVE_PRICE_PER_MINUTE_USD = 0.05; // developers.openai.com/api/docs/models/gpt-live-1
const BACKEND_MODEL = process.env.GAME_BACKEND_MODEL || "gpt-6-luna";
// Backend-Preise per 1M Tokens (Env, da nicht verifiziert). Ohne Werte wird nur
// die Voice-Zeit als Kosten gebucht und die Token-Zahlen im Detail abgelegt.
const BACKEND_PRICE_IN = Number(process.env.GAME_BACKEND_PRICE_IN_PER_M) || null;
const BACKEND_PRICE_OUT = Number(process.env.GAME_BACKEND_PRICE_OUT_PER_M) || null;

const DEFAULT_TEST_EMAILS = ["michael@mmhammer.org"];
const SESSION_LOCK_TTL_SECONDS = parseInt(process.env.SESSION_LOCK_TTL_SECONDS || "12", 10);
const MAX_SDP_BYTES = 64 * 1024;

function testEmails() {
  const fromEnv = String(process.env.GAME_TEST_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...DEFAULT_TEST_EMAILS, ...fromEnv]);
}

async function authenticate(req, supabase) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return { error: [401, "missing_token"] };
  const { data: { user } = {}, error } = await supabase.auth.getUser(token);
  if (error || !user) return { error: [401, "invalid_token"] };
  if (!testEmails().has(String(user.email || "").toLowerCase())) return { error: [403, "game_night_test_only"] };
  return { user };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "method_not_allowed" });
    }
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "missing_env" });
    }
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const auth = await authenticate(req, supabase);
    if (auth.error) return res.status(auth.error[0]).json({ error: auth.error[1] });
    const { user } = auth;

    const action = String(req.query?.action || "").toLowerCase();
    if (action === "start") return await handleStart(req, res, supabase, user);
    if (action === "end") return await handleEnd(req, res, supabase, user);
    return res.status(400).json({ error: "unknown_action" });
  } catch (e) {
    console.error("[game] unhandled", e?.message || e);
    return res.status(500).json({ error: "internal_error" });
  }
}

async function handleStart(req, res, supabase, user) {
  const body = req.body || {};
  const sdp = typeof body.sdp === "string" ? body.sdp : "";
  if (!sdp || sdp.length > MAX_SDP_BYTES || !sdp.startsWith("v=")) return res.status(400).json({ error: "invalid_sdp" });
  const mode = GAME_MODES.includes(body.mode) ? body.mode : "surprise";
  const lang = ["de", "en", "fr"].includes(body.lang) ? body.lang : "de";
  const voice = GAME_VOICES.includes(body.voice) ? body.voice : DEFAULT_GAME_VOICE;

  // Doppelstart-Schutz (zweiter Tab / Doppel-Tap), gleiche RPC wie /api/session.
  const lockResult = await supabase.rpc("acquire_realtime_lock", { p_user_id: user.id, p_ttl_seconds: SESSION_LOCK_TTL_SECONDS });
  const lockRow = Array.isArray(lockResult.data) ? lockResult.data[0] : null;
  if (lockResult.error || lockRow?.allowed !== true) {
    return res.status(429).json({ error: "busy" });
  }

  const payload = {
    session: {
      model: LIVE_MODEL,
      instructions: buildGameInstructions({ mode, lang }),
      audio: { output: { voice } },
      delegation: {
        type: "responses",
        acknowledgement_delay_ms: 800,
        responses: {
          model: BACKEND_MODEL,
          instructions: BACKEND_INSTRUCTIONS,
          tools: mode === "freeplay" ? GAME_TOOLS.filter((t) => t.name === "update_score" || t.name === "add_players") : GAME_TOOLS,
          tool_choice: "auto",
          parallel_tool_calls: false,
          reasoning: { effort: "minimal" },
          service_tier: "priority",
        },
      },
    },
    transport: { type: "webrtc", sdp },
  };

  const t0 = Date.now();
  const r = await fetch("https://api.openai.com/v1/live/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data?.transport?.sdp) {
    console.error("[game] live session create failed", r.status, JSON.stringify(data?.error || data).slice(0, 500));
    return res.status(502).json({ error: "live_session_failed", status: r.status, detail: data?.error?.message || null });
  }
  console.log("[game] live session", data?.session?.id, "mode", mode, "voice", voice, "ms", Date.now() - t0);
  return res.status(200).json({ sdp: data.transport.sdp, session_id: data?.session?.id || null, mode, voice, lang });
}

function clampStr(s, n) {
  return String(s ?? "").slice(0, n);
}

async function handleEnd(req, res, supabase, user) {
  const body = req.body || {};
  const sessionId = clampStr(body.session_id, 120) || null;
  const mode = GAME_MODES.includes(body.mode) ? body.mode : null;
  const seconds = Math.min(3 * 3600, Math.max(0, Number(body.seconds) || 0));
  const bu = body.backend_usage && typeof body.backend_usage === "object" ? body.backend_usage : {};
  const backend = {
    input_tokens: Math.max(0, Number(bu.input_tokens) || 0),
    output_tokens: Math.max(0, Number(bu.output_tokens) || 0),
    cached_tokens: Math.max(0, Number(bu.cached_tokens) || 0),
    reasoning_tokens: Math.max(0, Number(bu.reasoning_tokens) || 0),
    responses: Math.max(0, Number(bu.responses) || 0),
  };

  const voiceCost = (seconds / 60) * LIVE_PRICE_PER_MINUTE_USD;
  const backendCost = BACKEND_PRICE_IN && BACKEND_PRICE_OUT
    ? (backend.input_tokens / 1e6) * BACKEND_PRICE_IN + (backend.output_tokens / 1e6) * BACKEND_PRICE_OUT
    : 0;
  const costUsd = Math.round((voiceCost + backendCost) * 1e6) / 1e6;

  try {
    await trackCost({
      userId: user.id,
      provider: "openai",
      model: LIVE_MODEL,
      inputTokens: backend.input_tokens,
      outputTokens: backend.output_tokens,
      costUsd,
      providerCost: costUsd,
      billedValue: 0, // Prototyp: nichts abgerechnet
      latencyMs: 0,
      routingReason: `game-night-${mode || "unknown"}`,
      hasRealUsage: seconds > 0,
      realtimeUsageDetail: {
        engine: LIVE_MODEL,
        session_id: sessionId,
        seconds,
        voice_cost_usd: voiceCost,
        backend_model: BACKEND_MODEL,
        backend,
        backend_cost_known: !!(BACKEND_PRICE_IN && BACKEND_PRICE_OUT),
      },
    });
  } catch (e) {
    console.warn("[game] trackCost failed", e?.message || e);
  }

  // Test-Auswertung (Humor-Test): Transkript, Lacher, Bewertung.
  try {
    const transcript = (Array.isArray(body.transcript) ? body.transcript : [])
      .slice(-200)
      .map((t) => ({ role: t?.role === "user" ? "user" : "assistant", text: clampStr(t?.text, 600), t: Number(t?.t) || null }));
    const laughs = (Array.isArray(body.laughs) ? body.laughs : [])
      .slice(-200)
      .map((l) => ({ t: Number(l?.t) || null, last_sophie: clampStr(l?.last_sophie, 400) }));
    const rating = Number.isInteger(body.rating) && body.rating >= 1 && body.rating <= 5 ? body.rating : null;
    await supabase.from("analytics_events").insert({
      user_id: user.id,
      event_name: "game_test_session",
      session_id: sessionId,
      meta: {
        mode,
        voice: clampStr(body.voice, 30) || null,
        seconds,
        cost_usd: costUsd,
        rating,
        laugh_count: laughs.length,
        laughs,
        game: body.game && typeof body.game === "object" ? { name: clampStr(body.game.name, 80), rounds: Number(body.game.rounds) || 0 } : null,
        scores: body.scores && typeof body.scores === "object" ? Object.fromEntries(Object.entries(body.scores).slice(0, 20).map(([k, v]) => [clampStr(k, 40), Number(v) || 0])) : null,
        turns: transcript,
      },
    });
  } catch (e) {
    console.warn("[game] analytics insert failed", e?.message || e);
  }

  return res.status(200).json({ ok: true, cost_usd: costUsd });
}
