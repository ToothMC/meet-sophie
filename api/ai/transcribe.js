// api/ai/transcribe.js — Whisper transcription for meeting audio recordings
import { createClient } from '@supabase/supabase-js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth check
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  try {
    // Forward the multipart form data to OpenAI Whisper
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({ error: 'Expected multipart/form-data' });
    }

    // Parse multipart using raw body
    const { default: Busboy } = await import('busboy');

    return new Promise((resolve) => {
      const bb = Busboy({ headers: req.headers });
      const fields = {};
      let fileBuffer = null;
      let fileName = 'audio.webm';

      bb.on('file', (name, file, info) => {
        fileName = info.filename || 'audio.webm';
        const chunks = [];
        file.on('data', (d) => chunks.push(d));
        file.on('end', () => { fileBuffer = Buffer.concat(chunks); });
      });

      bb.on('field', (name, val) => { fields[name] = val; });

      bb.on('close', async () => {
        if (!fileBuffer || fileBuffer.length < 1000) {
          res.status(400).json({ error: 'Audio too short or missing' });
          return resolve();
        }

        try {
          // Build FormData for OpenAI
          const FormData = (await import('form-data')).default;
          const form = new FormData();
          form.append('file', fileBuffer, { filename: fileName, contentType: 'audio/webm' });
          form.append('model', fields.model || 'whisper-1');
          if (fields.language) form.append('language', fields.language);

          const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
              ...form.getHeaders(),
            },
            body: form.getBuffer(),
          });

          if (!whisperRes.ok) {
            const errText = await whisperRes.text();
            console.error('[transcribe] Whisper error:', whisperRes.status, errText);
            res.status(whisperRes.status).json({ error: 'Transcription failed' });
            return resolve();
          }

          const result = await whisperRes.json();
          console.log(`[transcribe] OK: ${(result.text || '').slice(0, 80)}...`);
          res.status(200).json({ text: result.text || '' });
          resolve();
        } catch (e) {
          console.error('[transcribe] Error:', e.message);
          res.status(500).json({ error: e.message });
          resolve();
        }
      });

      req.pipe(bb);
    });
  } catch (e) {
    console.error('[transcribe] Handler error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
