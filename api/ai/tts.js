// api/ai/tts.js — OpenAI TTS: pitch text → MP3 audio (emotionale Keynote-Performance)
// Uses fetch() directly — no 'openai' package (not in dependencies)
import { createClient } from '@supabase/supabase-js';
import { trackCost } from '../../lib/ai/cost-tracker.js';

export const config = { maxDuration: 30 };

const DELIVERY_INSTRUCTIONS = `You are a world-class keynote speaker delivering the pitch of your life.
This is NOT a monotone reading — this is a PASSIONATE PERFORMANCE.

ENERGY: Start with fire and conviction. Your opening hook must grab attention instantly.
TEMPO: Vary dramatically — rush through supporting details, then SLOW DOWN before every key claim. Let important numbers and names land with weight.
PAUSES: Use dramatic pauses before revelations, after rhetorical questions, and before your call-to-action. Silence is power.
VOLUME: Build intensity through sections. Whisper for intimacy, project for authority.
EMPHASIS: Stress product names, competitive advantages, and emotional trigger words.
EMOTION: Show genuine excitement about the solution. Let your voice convey belief.
CLOSING: The final call-to-action must be delivered slowly, clearly, with absolute conviction — like you're looking the audience in the eyes.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing token' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { text } = req.body || {};
  if (!text || text.length < 10) return res.status(400).json({ error: 'Text too short' });
  if (text.length > 5000) return res.status(400).json({ error: 'Text too long (max 5000 chars)' });

  try {
    const ttsResp = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        voice: 'shimmer',
        input: text,
        response_format: 'mp3',
        instructions: DELIVERY_INSTRUCTIONS,
      }),
    });

    if (!ttsResp.ok) {
      const errText = await ttsResp.text().catch(() => '');
      console.error(`[tts] OpenAI API error ${ttsResp.status}: ${errText.slice(0, 300)}`);
      return res.status(502).json({ error: 'TTS API error' });
    }

    // Cost: gpt-4o-mini-tts ~$0.006/1K chars
    const costUsd = (text.length / 1000) * 0.006;
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

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    const arrayBuffer = await ttsResp.arrayBuffer();
    return res.send(Buffer.from(arrayBuffer));
  } catch (e) {
    console.error('[tts] failed:', e?.message);
    return res.status(500).json({ error: 'TTS generation failed' });
  }
}
