// api/ai/tts.js — OpenAI TTS: text → MP3 audio stream
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { trackCost } from '../../lib/ai/cost-tracker.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Auth
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing token' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { text, voice } = req.body || {};
  if (!text || text.length < 10) return res.status(400).json({ error: 'Text too short' });
  if (text.length > 5000) return res.status(400).json({ error: 'Text too long (max 5000 chars)' });

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const ttsResp = await client.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice: voice || 'shimmer',
      input: text,
      response_format: 'mp3',
      instructions: 'Speak like a confident keynote speaker. Emphasize key words, vary tempo, pause before important statements. Hook with energy, closing slow and clear.',
    });

    // Estimate cost: gpt-4o-mini-tts ≈ $0.003/1K chars
    const chars = text.length;
    const costUsd = (chars / 1000) * 0.003;
    trackCost({
      userId: user.id,
      provider: 'openai',
      model: 'gpt-4o-mini-tts',
      inputTokens: 0,
      outputTokens: 0,
      costUsd,
      latencyMs: 0,
      routingReason: 'demo-pitch-tts',
    }).catch(err => console.error('[tts] cost tracking error:', err?.message));

    // Stream MP3 back
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');

    const arrayBuffer = await ttsResp.arrayBuffer();
    return res.send(Buffer.from(arrayBuffer));
  } catch (e) {
    console.error('[tts] failed:', e?.message);
    return res.status(500).json({ error: 'TTS generation failed' });
  }
}
