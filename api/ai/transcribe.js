// api/ai/transcribe.js — Whisper transcription for meeting audio recordings
// Accepts JSON { audio_base64, filename, language } instead of multipart
import { createClient } from '@supabase/supabase-js';
import { SECONDS_PER_TOKEN } from '../../lib/billing-constants.js';
import { trackCost } from '../../lib/ai/cost-tracker.js';

export const config = { maxDuration: 60, api: { bodyParser: { sizeLimit: '25mb' } } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

    const { audio_base64, filename, language } = body;
    if (!audio_base64) return res.status(400).json({ error: 'Missing audio_base64' });

    const audioBuffer = Buffer.from(audio_base64, 'base64');
    if (audioBuffer.length < 1000) return res.status(400).json({ error: 'Audio too short' });

    console.log(`[transcribe] ${user.id}: ${(audioBuffer.length / 1024).toFixed(0)}KB, file=${filename || 'audio.webm'}`);

    // Pre-check token balance before expensive Whisper API call
    const { data: usagePre } = await supabase
      .from('user_usage')
      .select('free_tokens_total, free_tokens_used, paid_tokens_total, paid_tokens_used, topup_tokens_balance')
      .eq('user_id', user.id)
      .maybeSingle();
    if (usagePre) {
      const totalRem = Math.max(0, (usagePre.free_tokens_total || 0) - (usagePre.free_tokens_used || 0))
        + Math.max(0, (usagePre.paid_tokens_total || 0) - (usagePre.paid_tokens_used || 0))
        + Math.max(0, usagePre.topup_tokens_balance || 0);
      if (totalRem <= 0) {
        return res.status(402).json({ error: 'No tokens remaining' });
      }
    }

    // Build multipart form for OpenAI Whisper
    const boundary = '----WhisperBoundary' + Date.now();
    const fname = filename || 'audio.webm';
    const mimeType = fname.endsWith('.mp4') ? 'audio/mp4' : 'audio/webm';

    const parts = [];
    // File part
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fname}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
    parts.push(audioBuffer);
    parts.push('\r\n');
    // Model part
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`);
    // Response format: verbose_json to get duration
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n`);
    // Language part
    if (language) {
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}\r\n`);
    }
    parts.push(`--${boundary}--\r\n`);

    const multipartBody = Buffer.concat(parts.map(p => typeof p === 'string' ? Buffer.from(p) : p));

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
      console.error('[transcribe] Whisper error:', whisperRes.status, errText);
      return res.status(whisperRes.status).json({ error: 'Transcription failed', detail: errText });
    }

    const result = await whisperRes.json();
    console.log(`[transcribe] OK: ${(result.text || '').slice(0, 100)}...`);

    // Deduct usage in tokens — use Whisper's reported duration, fallback to file size estimate
    const actualDuration = result.duration || null;
    const estimatedSeconds = actualDuration ? Math.ceil(actualDuration) : Math.max(1, Math.ceil(audioBuffer.length / 16000));
    const tokensToDeduct = Math.ceil(estimatedSeconds / SECONDS_PER_TOKEN);
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

        // Track USD cost — Whisper-1 costs $0.006/min
        const whisperCostUsd = (estimatedSeconds / 60) * 0.006;
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
