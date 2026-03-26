// lib/ai/adapters/anthropic.js — Anthropic Adapter (Claude Sonnet, Opus, Haiku)
import { calculateCost } from '../types.js';

export class AnthropicAdapter {
  constructor() {
    this.provider = 'anthropic';
  }

  /**
   * @param {{ messages: Array<{role: string, content: string}>, model?: string, maxTokens?: number, temperature?: number }} req
   */
  async complete(req) {
    const model = req.model || 'claude-sonnet-4-6';
    const start = Date.now();

    // Anthropic format: system is a separate param, not in messages array
    const systemMsgs = req.messages.filter(m => m.role === 'system');
    const chatMsgs = req.messages.filter(m => m.role !== 'system');

    // Ensure messages alternate user/assistant — Anthropic requires it
    const formatted = [];
    for (const m of chatMsgs) {
      if (formatted.length > 0 && formatted[formatted.length - 1].role === m.role) {
        // Merge consecutive same-role messages
        formatted[formatted.length - 1].content += '\n' + m.content;
      } else {
        formatted.push({ role: m.role, content: m.content });
      }
    }
    // Anthropic requires first message to be 'user'
    if (formatted.length > 0 && formatted[0].role !== 'user') {
      formatted.unshift({ role: 'user', content: '...' });
    }

    const body = {
      model,
      max_tokens: req.maxTokens || 1024,
      messages: formatted,
    };
    if (systemMsgs.length > 0) {
      body.system = systemMsgs.map(m => m.content).join('\n\n');
    }
    if (req.temperature !== undefined) {
      body.temperature = req.temperature;
    }

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Anthropic API error ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json();
    const content = data.content?.map(b => b.text).join('') || '';
    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;

    return {
      content,
      model,
      provider: this.provider,
      usage: {
        inputTokens,
        outputTokens,
        costUsd: calculateCost(model, inputTokens, outputTokens),
      },
      latencyMs: Date.now() - start,
    };
  }

  async healthCheck() {
    const start = Date.now();
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 5,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      return { ok: resp.ok, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }
}
