// api/ai/transcribe.js — Whisper transcription for meeting audio recordings
// Accepts JSON { audio_base64, filename, language } instead of multipart
// Meeting mode: meeting_id + segment_index → stores in meeting_segments, skips token deduction
import { createClient } from '@supabase/supabase-js';
import { SECONDS_PER_TOKEN, SECONDS_PER_TOKEN_ECO, DEFAULT_FREE_TOKENS } from '../../lib/billing-constants.js';
import { trackCost } from '../../lib/ai/cost-tracker.js';

// Disable body parser — we handle both JSON and multipart manually
export const config = { maxDuration: 60, api: { bodyParser: false } };

// Parse raw body from request
function getRawBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Parse multipart form data (simple parser for file + fields)
function parseMultipart(buffer, boundary) {
  const parts = {};
  const boundaryBuf = Buffer.from('--' + boundary);
  let pos = 0;

  while (pos < buffer.length) {
    const start = buffer.indexOf(boundaryBuf, pos);
    if (start === -1) break;
    const nextStart = buffer.indexOf(boundaryBuf, start + boundaryBuf.length);
    if (nextStart === -1) break;

    const partBuf = buffer.slice(start + boundaryBuf.length, nextStart);
    const headerEnd = partBuf.indexOf('\r\n\r\n');
    if (headerEnd === -1) { pos = nextStart; continue; }

    const headers = partBuf.slice(0, headerEnd).toString();
    // Strip trailing \r\n from body
    let body = partBuf.slice(headerEnd + 4);
    if (body.length >= 2 && body[body.length - 2] === 13 && body[body.length - 1] === 10) {
      body = body.slice(0, body.length - 2);
    }

    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);
    if (nameMatch) {
      parts[nameMatch[1]] = filenameMatch ? { buffer: body, filename: filenameMatch[1] } : body.toString();
    }
    pos = nextStart;
  }
  return parts;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  try {
    const contentType = req.headers['content-type'] || '';
    const rawBody = await getRawBody(req);
    let audioBuffer, filename, language, meetingId, segmentIndex;

    if (contentType.includes('multipart/form-data')) {
      // FormData upload (from mobile — no base64 overhead)
      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (!boundaryMatch) return res.status(400).json({ error: 'Missing boundary' });
      const parts = parseMultipart(rawBody, boundaryMatch[1].trim());
      if (!parts.file?.buffer) return res.status(400).json({ error: 'Missing file' });
      audioBuffer = parts.file.buffer;
      filename = parts.file.filename || 'audio.webm';
      language = parts.language || '';
      meetingId = parts.meeting_id || '';
      segmentIndex = parts.segment_index != null ? parseInt(parts.segment_index, 10) : null;
    } else {
      // JSON with base64 (legacy)
      let body;
      try { body = JSON.parse(rawBody.toString()); } catch { body = {}; }
      if (!body.audio_base64) return res.status(400).json({ error: 'Missing audio_base64' });
      audioBuffer = Buffer.from(body.audio_base64, 'base64');
      filename = body.filename;
      language = body.language;
    }

    if (audioBuffer.length < 1000) {
      console.warn(`[transcribe] Audio too short: ${audioBuffer.length} bytes, file=${filename || 'audio.webm'}, user=${user.id}${meetingId ? ` meeting=${meetingId} seg=${segmentIndex}` : ''}`);
      return res.status(400).json({ error: 'Audio too short', bytes: audioBuffer.length });
    }

    const isMeetingMode = !!(meetingId && segmentIndex != null && !isNaN(segmentIndex));

    console.log(`[transcribe] ${user.id}: ${(audioBuffer.length / 1024).toFixed(0)}KB, file=${filename || 'audio.webm'}${isMeetingMode ? ` meeting=${meetingId} seg=${segmentIndex}` : ''}`);

    // ── Meeting mode: validate meeting ownership + phase ────────────────────
    if (isMeetingMode) {
      const { data: meeting, error: meetErr } = await supabase
        .from('meetings')
        .select('id, user_id, phase, billing_status')
        .eq('id', meetingId)
        .maybeSingle();

      if (meetErr || !meeting) {
        return res.status(404).json({ error: 'Meeting not found' });
      }
      if (meeting.user_id !== user.id) {
        return res.status(403).json({ error: 'Not your meeting' });
      }
      if (meeting.phase !== 'live' && meeting.phase !== 'post') {
        return res.status(409).json({ error: 'Meeting not in live/post phase' });
      }
      if (meeting.billing_status === 'finalized') {
        return res.status(409).json({ error: 'Meeting billing already finalized' });
      }
    }

    // ── Pre-check token balance (both modes) ────────────────────────────────
    let usagePre = (await supabase
      .from('user_usage')
      .select('free_tokens_total, free_tokens_used, paid_tokens_total, paid_tokens_used, topup_tokens_balance')
      .eq('user_id', user.id)
      .maybeSingle()).data;
    if (!usagePre) {
      const { data: created } = await supabase
        .from('user_usage')
        .upsert({
          user_id: user.id,
          free_tokens_total: DEFAULT_FREE_TOKENS, free_tokens_used: 0,
          paid_tokens_total: 0, paid_tokens_used: 0, topup_tokens_balance: 0,
        }, { onConflict: 'user_id' })
        .select('free_tokens_total, free_tokens_used, paid_tokens_total, paid_tokens_used, topup_tokens_balance')
        .single();
      if (created) usagePre = created;
    }
    if (usagePre) {
      const totalRem = Math.max(0, (usagePre.free_tokens_total || 0) - (usagePre.free_tokens_used || 0))
        + Math.max(0, (usagePre.paid_tokens_total || 0) - (usagePre.paid_tokens_used || 0))
        + Math.max(0, usagePre.topup_tokens_balance || 0);
      if (totalRem <= 0) {
        return res.status(402).json({ error: 'No tokens remaining' });
      }
    }

    // ── Whisper API call ────────────────────────────────────────────────────
    const boundary = '----WhisperBoundary' + Date.now();
    const fname = filename || 'audio.webm';
    const mimeType = fname.endsWith('.mp4') ? 'audio/mp4' : 'audio/webm';

    const formParts = [];
    formParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fname}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
    formParts.push(audioBuffer);
    formParts.push('\r\n');
    formParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`);
    formParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n`);
    if (language) {
      formParts.push(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}\r\n`);
    }
    formParts.push(`--${boundary}--\r\n`);

    const multipartBody = Buffer.concat(formParts.map(p => typeof p === 'string' ? Buffer.from(p) : p));

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: multipartBody,
    });

    if (!whisperRes.ok) {
      const errText = await whisperRes.text();
      console.error(`[transcribe] Whisper error: ${whisperRes.status} | ${audioBuffer.length} bytes | file=${fname} | user=${user.id}${isMeetingMode ? ` meeting=${meetingId} seg=${segmentIndex}` : ''} | detail: ${errText}`);
      // Return 502 for upstream Whisper failures (not our 400) so frontend can distinguish
      const mappedStatus = whisperRes.status >= 400 && whisperRes.status < 500 ? 502 : whisperRes.status;
      return res.status(mappedStatus).json({ error: 'Transcription failed', whisper_status: whisperRes.status, detail: errText });
    }

    const result = await whisperRes.json();
    // Filter known Whisper end-of-audio hallucination artifacts
    if (result.text) {
      const ARTIFACTS = ["Untertitel der Amara.org-Community","Untertitel von der Amara.org-Community","Vielen Dank fürs Zuschauen","Vielen Dank für's Zuschauen","Thanks for watching","Thank you for watching","Sous-titres réalisés par la communauté d'Amara.org","Merci d'avoir regardé"];
      for (const a of ARTIFACTS) {
        if (result.text.trim().endsWith(a)) {
          console.log(`[transcribe] Whisper artifact removed: "${a}"`);
          result.text = result.text.trim().slice(0, -a.length).trim();
        }
      }
    }
    console.log(`[transcribe] OK: ${(result.text || '').slice(0, 100)}...`);

    const actualDuration = result.duration || null;
    const estimatedSeconds = actualDuration ? Math.ceil(actualDuration) : Math.max(1, Math.ceil(audioBuffer.length / 16000));
    const whisperCostUsd = (estimatedSeconds / 60) * 0.006;

    // ── Meeting mode: store segment, skip token deduction ───────────────────
    if (isMeetingMode) {
      // UPSERT with cost protection: only count cost on real insert (xmax=0)
      const { data: upsertResult, error: upsertErr } = await supabase.rpc('meeting_segment_upsert', {
        p_meeting_id: meetingId,
        p_user_id: user.id,
        p_segment_index: segmentIndex,
        p_duration_seconds: estimatedSeconds,
        p_transcript: result.text || '',
        p_whisper_cost_usd: whisperCostUsd,
      });

      if (upsertErr) {
        console.error('[transcribe] Segment upsert RPC error:', upsertErr.message);
        // Fallback: direct insert (without cost-safe upsert)
        await supabase.from('meeting_segments').upsert({
          meeting_id: meetingId,
          user_id: user.id,
          segment_index: segmentIndex,
          duration_seconds: estimatedSeconds,
          transcript: result.text || '',
          whisper_cost_usd: whisperCostUsd,
        }, { onConflict: 'meeting_id,segment_index' });

        // Increment cost via RPC (fallback path — may double-count on retry, acceptable for MVP)
        try {
          await supabase.rpc('increment_meeting_cost', {
            p_meeting_id: meetingId,
            p_cost_field: 'listen_cost_usd',
            p_amount: whisperCostUsd,
          });
        } catch (costErr) {
          console.error('[transcribe] Fallback cost increment failed:', costErr.message);
        }
      }

      // Track USD cost (internal tracking, not user-facing billing)
      trackCost({
        userId: user.id,
        provider: 'openai',
        model: 'whisper-1',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: whisperCostUsd,
        latencyMs: 0,
        routingReason: 'meeting_transcription',
      }).catch(err => console.error("Transcribe cost tracking error:", err?.message));

      // Incremental billing checkpoint every 5 segments
      let billingResult = null;
      if (segmentIndex > 0 && segmentIndex % 5 === 0) {
        try {
          const { data: checkpointData } = await supabase.rpc('meeting_billing_checkpoint', {
            p_meeting_id: meetingId,
            p_user_id: user.id,
          });
          billingResult = Array.isArray(checkpointData) ? checkpointData[0] : checkpointData;
          console.log(`[transcribe] Billing checkpoint seg=${segmentIndex}:`, billingResult);

          if (billingResult?.action === 'insufficient_tokens') {
            return res.status(402).json({
              error: 'No tokens remaining',
              text: result.text || '',
              seconds_used: estimatedSeconds,
              billing: billingResult,
            });
          }
        } catch (billingErr) {
          console.error('[transcribe] Billing checkpoint error:', billingErr.message);
        }
      }

      return res.status(200).json({
        text: result.text || '',
        seconds_used: estimatedSeconds,
        meeting_mode: true,
        segment_index: segmentIndex,
        billing: billingResult,
      });
    }

    // ── Standard mode: deduct tokens directly ──────────────────────────────
    let secPerToken = SECONDS_PER_TOKEN;
    try {
      const { data: prof } = await supabase.from('user_profile').select('eco_mode').eq('user_id', user.id).maybeSingle();
      if (prof?.eco_mode) secPerToken = SECONDS_PER_TOKEN_ECO;
    } catch (_) {}
    const tokensToDeduct = Math.ceil(estimatedSeconds / secPerToken);
    try {
      const { data: usage } = await supabase
        .from('user_usage')
        .select('free_tokens_total, free_tokens_used, paid_tokens_total, paid_tokens_used, topup_tokens_balance')
        .eq('user_id', user.id)
        .maybeSingle();

      if (usage) {
        const freeRemaining = Math.max(0, (usage.free_tokens_total || 0) - (usage.free_tokens_used || 0));
        const paidRemaining = Math.max(0, (usage.paid_tokens_total || 0) - (usage.paid_tokens_used || 0));
        const topupRemaining = Math.max(0, usage.topup_tokens_balance || 0);
        const updates = { updated_at: new Date().toISOString() };
        let toDeduct = tokensToDeduct;

        // Waterfall: free → paid → topup
        if (toDeduct > 0 && freeRemaining > 0) {
          const fromFree = Math.min(toDeduct, freeRemaining);
          updates.free_tokens_used = (usage.free_tokens_used || 0) + fromFree;
          toDeduct -= fromFree;
        }
        if (toDeduct > 0 && paidRemaining > 0) {
          const fromPaid = Math.min(toDeduct, paidRemaining);
          updates.paid_tokens_used = (usage.paid_tokens_used || 0) + fromPaid;
          toDeduct -= fromPaid;
        }
        if (toDeduct > 0 && topupRemaining > 0) {
          const fromTopup = Math.min(toDeduct, topupRemaining);
          updates.topup_tokens_balance = (usage.topup_tokens_balance || 0) - fromTopup;
          toDeduct -= fromTopup;
        }

        await supabase.from('user_usage').update(updates).eq('user_id', user.id);
        console.log(`[transcribe] Usage: ~${estimatedSeconds}s = ${tokensToDeduct} tokens deducted`);

        trackCost({
          userId: user.id,
          provider: 'openai',
          model: 'whisper-1',
          inputTokens: 0,
          outputTokens: 0,
          costUsd: whisperCostUsd,
          latencyMs: 0,
          routingReason: 'transcription',
        }).catch(err => console.error("Transcribe cost tracking error:", err?.message));
      }
    } catch (ue) {
      console.error('[transcribe] Usage error:', ue.message);
    }

    return res.status(200).json({ text: result.text || '', seconds_used: estimatedSeconds, tokens_used: tokensToDeduct });
  } catch (e) {
    console.error('[transcribe] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
