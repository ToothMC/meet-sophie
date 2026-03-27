// api/ai/transcribe.js — Whisper transcription for meeting audio recordings
// Accepts JSON { audio_base64, filename, language } instead of multipart
import { createClient } from '@supabase/supabase-js';

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

    // Deduct usage
    const estimatedSeconds = Math.ceil(audioBuffer.length / 16000);
    try {
      const { data: usage } = await supabase
        .from('user_usage')
        .select('free_seconds_total, free_seconds_used, paid_seconds_total, paid_seconds_used, topup_seconds_balance')
        .eq('user_id', user.id)
        .maybeSingle();

      if (usage) {
        const freeRemaining = Math.max(0, (usage.free_seconds_total || 0) - (usage.free_seconds_used || 0));
        const updates = { updated_at: new Date().toISOString() };
        let toDeduct = estimatedSeconds;

        if (freeRemaining > 0) {
          const fromFree = Math.min(toDeduct, freeRemaining);
          updates.free_seconds_used = (usage.free_seconds_used || 0) + fromFree;
          toDeduct -= fromFree;
        }
        if (toDeduct > 0) {
          updates.paid_seconds_used = (usage.paid_seconds_used || 0) + toDeduct;
        }

        await supabase.from('user_usage').update(updates).eq('user_id', user.id);
        console.log(`[transcribe] Usage: ~${estimatedSeconds}s deducted`);
      }
    } catch (ue) {
      console.error('[transcribe] Usage error:', ue.message);
    }

    return res.status(200).json({ text: result.text || '', seconds_used: estimatedSeconds });
  } catch (e) {
    console.error('[transcribe] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
