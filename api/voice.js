// api/voice.js — ElevenLabs Pitch Voice Render (Track A)
// Actions: consent | clone | render | delete | status
// Auth: Bearer token only. userId NEVER from req.body.

import { createClient } from "@supabase/supabase-js";
import { TOKEN_COSTS } from "../lib/billing-constants.js";
import { getAdapter } from "../lib/ai/adapters/index.js";
import { trackCost } from "../lib/ai/cost-tracker.js";

// ---------------------------------------------------------------------------
// Pitch optimization prompt
// ---------------------------------------------------------------------------
const OPTIMIZE_PITCH_PROMPT = `Du bist ein professioneller Pitch-Coach. Du hast gerade einen Pitch analysiert und bewertet. Schreibe jetzt eine optimierte Version.

REGELN:
- Schreibe den Pitch so, wie er GESPROCHEN werden soll
- Kurze Sätze. Natürliche Pausen mit "..."
- Behalte Kern und Persönlichkeit des Originals bei
- Behebe die identifizierten Schwächen
- Stärke: Klarheit, Nutzenversprechen, Handlungsimpuls
- Sprache: gleiche Sprache wie das Original
- Länge: ähnlich wie Original (±20%)
- NUR der Pitch-Text. Kein Meta-Text, keine Erklärungen
- Keine Betonungsmarkierungen oder Regieanweisungen

CONTEXT:
Original-Transkript:
{transcript}

Publikum: {audience_type}
Ziel: {goal_type}
Overall Score: {overall_score}/5
Hauptschwächen: {weaknesses}
Verbesserungsprioritäten: {improvement_priorities}`;

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Auth FIRST — before anything else
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing Authorization Bearer token" });

  const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !user) return res.status(401).json({ error: "Invalid token" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const { action } = body;

  try {
    switch (action) {
      case "consent": return await handleConsent(user, body, supabase, res);
      case "clone":   return await handleClone(user, body, supabase, res);
      case "render":  return await handleRender(user, body, supabase, res);
      case "delete":  return await handleDelete(user, supabase, res);
      case "status":  return await handleStatus(user, supabase, res);
      default: return res.status(400).json({ error: "Unknown action. Use: consent | clone | render | delete | status" });
    }
  } catch (err) {
    console.error(`[voice] Unhandled error in action=${action}:`, err?.message);
    return res.status(500).json({ error: "internal_error" });
  }
}

// ---------------------------------------------------------------------------
// ACTION: consent
// ---------------------------------------------------------------------------
async function handleConsent(user, body, supabase, res) {
  const { consentGiven } = body;

  if (!consentGiven) {
    return res.json({ ok: true, status: "declined" });
  }

  const { data, error } = await supabase
    .from("voice_profiles")
    .upsert({
      user_id: user.id,
      user_consent: true,
      consent_at: new Date().toISOString(),
      consent_text_version: "v1",
      clone_status: "pending",
      is_active: true,
    }, { onConflict: "user_id" })
    .select("id")
    .single();

  if (error) {
    console.error("[voice] consent save error:", error.message);
    return res.status(500).json({ error: "consent_save_failed" });
  }

  return res.json({ ok: true, status: "consented", profile_id: data.id });
}

// ---------------------------------------------------------------------------
// ACTION: clone
// ---------------------------------------------------------------------------
async function handleClone(user, body, supabase, res) {
  const { storagePath } = body;

  if (!storagePath) return res.status(400).json({ error: "storage_path_required" });

  // 1. Consent check
  const { data: existing } = await supabase
    .from("voice_profiles")
    .select("id, user_consent, clone_status, elevenlabs_voice_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!existing?.user_consent) {
    return res.status(403).json({ error: "consent_required" });
  }

  // 2. Download audio from Supabase Storage (internal path, not external URL)
  const { data: audioBlob, error: dlErr } = await supabase.storage
    .from("pitch-audio")
    .download(storagePath);

  if (dlErr || !audioBlob) {
    return res.status(404).json({ error: "audio_not_found" });
  }

  const audioBuffer = Buffer.from(await audioBlob.arrayBuffer());

  // 3. Delete old clone if re-cloning
  if (existing?.elevenlabs_voice_id && existing.clone_status !== "deleted") {
    await fetch(`https://api.elevenlabs.io/v1/voices/${existing.elevenlabs_voice_id}`, {
      method: "DELETE",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
    }).catch(() => {}); // best-effort cleanup
  }

  // 4. Set status to pending
  await supabase
    .from("voice_profiles")
    .update({ clone_status: "pending", last_clone_error: null, updated_at: new Date().toISOString() })
    .eq("user_id", user.id);

  // 5. Create ElevenLabs IVC
  const formData = new FormData();
  formData.append("name", `sophie-${user.id.slice(0, 8)}`);
  formData.append("files", new Blob([audioBuffer]), "pitch.webm");
  formData.append("remove_background_noise", "true");
  formData.append("labels", JSON.stringify({ source: "meet-sophie" }));

  try {
    const cloneRes = await fetch("https://api.elevenlabs.io/v1/voices/add", {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
      body: formData,
    });

    if (!cloneRes.ok) {
      const errBody = await cloneRes.text();
      console.error("[voice] ElevenLabs clone error:", errBody.slice(0, 500));
      await supabase
        .from("voice_profiles")
        .update({ clone_status: "failed", last_clone_error: errBody.slice(0, 1000), updated_at: new Date().toISOString() })
        .eq("user_id", user.id);
      return res.status(502).json({ error: "clone_failed" });
    }

    const { voice_id } = await cloneRes.json();

    // 6. Save voice profile
    await supabase
      .from("voice_profiles")
      .update({
        elevenlabs_voice_id: voice_id,
        provider: "elevenlabs",
        provider_voice_version: "ivc_v1",
        clone_type: "instant",
        clone_status: "ready",
        source_audio_path: storagePath,
        last_clone_error: null,
        is_active: true,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", user.id);

    return res.json({ ok: true, voice_id, status: "ready" });

  } catch (err) {
    console.error("[voice] Clone error:", err?.message);
    await supabase
      .from("voice_profiles")
      .update({ clone_status: "failed", last_clone_error: err.message, updated_at: new Date().toISOString() })
      .eq("user_id", user.id);
    return res.status(500).json({ error: "clone_error" });
  }
}

// ---------------------------------------------------------------------------
// ACTION: render
// ---------------------------------------------------------------------------
async function handleRender(user, body, supabase, res) {
  const { sessionId } = body;

  if (!sessionId) return res.status(400).json({ error: "session_id_required" });

  // 1. Idempotency: existing completed render for this session?
  const { data: existingRender } = await supabase
    .from("pitch_renders")
    .select("id, render_status, storage_path")
    .eq("session_id", sessionId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (existingRender?.render_status === "completed" && existingRender.storage_path) {
    const { data: urlData } = await supabase.storage
      .from("pitch-renders")
      .createSignedUrl(existingRender.storage_path, 3600);
    return res.json({
      ok: true,
      status: "completed",
      audio_url: urlData?.signedUrl,
      render_id: existingRender.id,
      cached: true,
    });
  }

  // 2. Load transcript from conversation_messages
  const { data: messages } = await supabase
    .from("conversation_messages")
    .select("role, text")
    .eq("session_id", sessionId)
    .order("seq", { ascending: true });

  const transcript = (messages || [])
    .filter(m => m.role === "user" && m.text)
    .map(m => m.text)
    .join("\n\n");

  if (!transcript || transcript.length < 20) {
    return res.status(422).json({ error: "transcript_too_short" });
  }

  // 3. Load pitch data (optional — extraction can fail silently in report generation)
  const { data: pitchMemory } = await supabase
    .from("sophie_pitch_memory")
    .select("topic, target_audience, goal_type, score, strengths, weaknesses, scores_content, scores_delivery")
    .eq("conversation_id", sessionId)
    .eq("user_id", user.id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  // 4. Voice Profile check
  const { data: voiceProfile } = await supabase
    .from("voice_profiles")
    .select("id, elevenlabs_voice_id, clone_status, is_active")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!voiceProfile || voiceProfile.clone_status !== "ready" || !voiceProfile.is_active) {
    return res.status(422).json({ error: "voice_profile_required" });
  }

  // 5. Token budget check
  const tokenCost = TOKEN_COSTS.pitch_render;
  const { data: budgetResult, error: budgetErr } = await supabase.rpc("deduct_tokens", {
    p_user_id: user.id,
    p_amount: 0, // dry-run: check only (deduct 0 to get remaining)
  });

  // Parse remaining tokens
  const budgetRow = Array.isArray(budgetResult) ? budgetResult[0] : budgetResult;
  const remaining = budgetRow?.remaining ?? 0;

  if (remaining < tokenCost) {
    return res.status(402).json({ error: "insufficient_tokens", needed: tokenCost, available: remaining });
  }

  // 6. Create or reuse render record (pending)
  const estimatedChars = Math.ceil(transcript.length * 1.2);
  let render;

  if (existingRender && existingRender.render_status !== "completed") {
    // Reuse failed/pending render record
    await supabase
      .from("pitch_renders")
      .update({ render_status: "pending", error_message: null, voice_profile_id: voiceProfile.id, estimated_chars: estimatedChars })
      .eq("id", existingRender.id);
    render = { id: existingRender.id };
  } else {
    const { data: newRender, error: renderInsertErr } = await supabase
      .from("pitch_renders")
      .insert({
        user_id: user.id,
        session_id: sessionId,
        voice_profile_id: voiceProfile.id,
        render_status: "pending",
        estimated_chars: estimatedChars,
      })
      .select("id")
      .single();

    if (renderInsertErr) {
      console.error("[voice] render insert error:", renderInsertErr.message);
      return res.status(500).json({ error: "render_init_failed" });
    }
    render = newRender;
  }

  try {
    // 7. Generate optimized pitch text server-side
    const overallScore = pitchMemory?.score
      ? (pitchMemory.score / 20).toFixed(1) // convert 0-100 to 0-5 scale
      : "N/A";

    const weaknesses = Array.isArray(pitchMemory?.weaknesses)
      ? pitchMemory.weaknesses.join(", ")
      : "nicht verfügbar";

    const prompt = OPTIMIZE_PITCH_PROMPT
      .replace("{transcript}", transcript)
      .replace("{audience_type}", pitchMemory?.target_audience || "allgemein")
      .replace("{goal_type}", pitchMemory?.goal_type || "überzeugen")
      .replace("{overall_score}", overallScore)
      .replace("{weaknesses}", weaknesses)
      .replace("{improvement_priorities}", weaknesses); // same as weaknesses for MVP

    const adapter = getAdapter("openai");
    const aiResponse = await adapter.complete({
      messages: [{ role: "user", content: prompt }],
      model: "gpt-4o-mini",
      maxTokens: 3000,
      temperature: 0.3,
    });

    const optimizedText = aiResponse?.content?.trim();
    if (!optimizedText || optimizedText.length < 50) {
      await updateRenderStatus(supabase, render.id, "failed", "Pitch optimization returned empty text");
      return res.status(502).json({ error: "optimization_failed", render_id: render.id });
    }

    // Track AI cost
    trackCost({
      userId: user.id,
      provider: "openai",
      model: "gpt-4o-mini",
      inputTokens: aiResponse?.usage?.inputTokens || 0,
      outputTokens: aiResponse?.usage?.outputTokens || 0,
      costUsd: aiResponse?.usage?.costUsd || 0,
      latencyMs: aiResponse?.latencyMs || 0,
      routingReason: "pitch-optimize",
    }).catch(() => {});

    // 8. ElevenLabs TTS
    const ttsRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceProfile.elevenlabs_voice_id}`, {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: optimizedText,
          model_id: "eleven_multilingual_v2",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.8,
            style: 0.3,
            use_speaker_boost: true,
          },
          output_format: "mp3_44100_128",
        }),
      });

    if (!ttsRes.ok) {
      const errBody = await ttsRes.text().catch(() => "");
      console.error(`[voice] ElevenLabs TTS error ${ttsRes.status}: ${errBody.slice(0, 300)}`);
      await updateRenderStatus(supabase, render.id, "failed", `TTS error: ${ttsRes.status}`);
      return res.status(502).json({ error: "tts_failed", render_id: render.id });
    }

    // Track ElevenLabs cost
    const elCostUsd = (optimizedText.length / 1000) * 0.12;
    trackCost({
      userId: user.id,
      provider: "elevenlabs",
      model: "eleven_multilingual_v2",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: elCostUsd,
      latencyMs: 0,
      routingReason: "pitch-voice-render",
    }).catch(() => {});

    // 9. Save audio to Storage
    const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
    const storagePath = `${user.id}/${sessionId}.mp3`;

    const { error: uploadErr } = await supabase.storage
      .from("pitch-renders")
      .upload(storagePath, audioBuffer, {
        contentType: "audio/mpeg",
        upsert: true,
      });

    if (uploadErr) {
      console.error("[voice] storage upload error:", uploadErr.message);
      await updateRenderStatus(supabase, render.id, "failed", uploadErr.message);
      return res.status(500).json({ error: "storage_failed", render_id: render.id });
    }

    // 10. Deduct tokens AFTER success
    const { data: deductResult, error: deductErr } = await supabase.rpc("deduct_tokens", {
      p_user_id: user.id,
      p_amount: tokenCost,
    });

    if (deductErr) {
      console.error("[voice] token deduction error:", deductErr.message);
      // Non-fatal: audio is already rendered and saved
    }

    const deductRow = Array.isArray(deductResult) ? deductResult[0] : deductResult;

    // 11. Update render record
    const actualChars = optimizedText.length;
    await supabase
      .from("pitch_renders")
      .update({
        render_status: "completed",
        storage_path: storagePath,
        optimized_text: optimizedText,
        actual_chars: actualChars,
        tokens_charged: tokenCost,
        file_size_bytes: audioBuffer.length,
        billing_type: "elevenlabs_tts",
        billing_metadata: {
          provider: "elevenlabs",
          model: "eleven_multilingual_v2",
          cost_usd: elCostUsd,
          ai_cost_usd: aiResponse?.usage?.costUsd || 0,
          bucket_breakdown: deductRow
            ? { free: deductRow.free_charged || 0, paid: deductRow.paid_charged || 0, topup: deductRow.topup_charged || 0 }
            : null,
        },
        completed_at: new Date().toISOString(),
      })
      .eq("id", render.id);

    // 12. Increment voice usage stats
    await supabase.rpc("increment_voice_usage", {
      p_user_id: user.id,
      p_chars: actualChars,
    }).catch(err => console.error("[voice] usage increment error:", err?.message));

    // 13. Signed URL
    const { data: urlData } = await supabase.storage
      .from("pitch-renders")
      .createSignedUrl(storagePath, 3600);

    return res.json({
      ok: true,
      status: "completed",
      audio_url: urlData?.signedUrl,
      optimized_text: optimizedText,
      render_id: render.id,
      chars_billed: actualChars,
      tokens_charged: tokenCost,
    });

  } catch (err) {
    console.error("[voice] render error:", err?.message);
    await updateRenderStatus(supabase, render.id, "failed", err.message);
    return res.status(500).json({ error: "render_error", render_id: render.id });
  }
}

// ---------------------------------------------------------------------------
// ACTION: delete
// ---------------------------------------------------------------------------
async function handleDelete(user, supabase, res) {
  const { data: profile } = await supabase
    .from("voice_profiles")
    .select("elevenlabs_voice_id, clone_status")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!profile) {
    return res.json({ ok: true, status: "no_profile" });
  }

  // Delete at ElevenLabs (best-effort)
  if (profile.elevenlabs_voice_id && profile.clone_status !== "deleted") {
    await fetch(`https://api.elevenlabs.io/v1/voices/${profile.elevenlabs_voice_id}`, {
      method: "DELETE",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
    }).catch(() => {});
  }

  // Soft-delete in DB
  await supabase
    .from("voice_profiles")
    .update({
      is_active: false,
      clone_status: "deleted",
      deleted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", user.id);

  return res.json({ ok: true, status: "deleted" });
}

// ---------------------------------------------------------------------------
// ACTION: status
// ---------------------------------------------------------------------------
async function handleStatus(user, supabase, res) {
  const { data: profile } = await supabase
    .from("voice_profiles")
    .select("id, clone_status, is_active, user_consent, total_generations, last_used_at, created_at")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!profile) {
    return res.json({
      ok: true,
      has_voice_profile: false,
      has_consent: false,
      clone_status: null,
    });
  }

  return res.json({
    ok: true,
    has_voice_profile: true,
    has_consent: profile.user_consent,
    clone_status: profile.clone_status,
    is_active: profile.is_active,
    total_generations: profile.total_generations,
    last_used_at: profile.last_used_at,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function updateRenderStatus(supabase, renderId, status, errorMessage) {
  await supabase
    .from("pitch_renders")
    .update({
      render_status: status,
      error_message: errorMessage?.slice(0, 2000),
      ...(status === "completed" ? { completed_at: new Date().toISOString() } : {}),
    })
    .eq("id", renderId);
}
