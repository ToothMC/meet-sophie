// lib/ai/adapters/openai.js — OpenAI Adapter (GPT-4o-mini, GPT-4o)
import { calculateCost } from '../types.js';

export class OpenAIAdapter {
  constructor() {
    this.provider = 'openai';
  }

  /**
   * @param {{ messages: Array<{role: string, content: string}>, model?: string, maxTokens?: number, temperature?: number }} req
   * @returns {Promise<import('../types.js').AIResponse>}
   */
  async complete(req) {
    const model = req.model || 'gpt-4o-mini';
    const start = Date.now();

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: req.messages,
        max_tokens: req.maxTokens || 1024,
        temperature: req.temperature ?? 0.85,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`OpenAI API error ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json();
    const choice = data.choices?.[0];
    const usage = data.usage || {};

    const inputTokens = usage.prompt_tokens || 0;
    const outputTokens = usage.completion_tokens || 0;

    return {
      content: choice?.message?.content || '',
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

  /** @returns {Promise<{ ok: boolean, latencyMs: number }>} */
  async healthCheck() {
    const start = Date.now();
    try {
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 5,
        }),
      });
      return { ok: resp.ok, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }
}
