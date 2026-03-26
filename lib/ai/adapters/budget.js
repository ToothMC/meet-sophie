// lib/ai/adapters/budget.js — Budget Adapter for Gemini + Mistral
import { calculateCost } from '../types.js';

export class BudgetAdapter {
  /**
   * @param {'google' | 'mistral'} subProvider
   */
  constructor(subProvider) {
    this.subProvider = subProvider;
    this.provider = subProvider;
  }

  async complete(req) {
    if (this.subProvider === 'google') return this._completeGoogle(req);
    return this._completeMistral(req);
  }

  // --- Google Gemini ---

  async _completeGoogle(req) {
    const model = req.model || 'gemini-2.5-flash-lite';
    const start = Date.now();

    // Build contents array from messages
    const systemParts = req.messages.filter(m => m.role === 'system').map(m => m.content);
    const contents = [];

    for (const m of req.messages) {
      if (m.role === 'system') continue;
      contents.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      });
    }
    // Gemini needs at least one user message
    if (contents.length === 0) {
      contents.push({ role: 'user', parts: [{ text: '...' }] });
    }

    const body = {
      contents,
      generationConfig: {
        maxOutputTokens: req.maxTokens || 1024,
        temperature: req.temperature ?? 0.85,
      },
    };
    if (systemParts.length > 0) {
      body.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GOOGLE_AI_API_KEY}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Google AI error ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json();
    const content = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    const usage = data.usageMetadata || {};
    const inputTokens = usage.promptTokenCount || 0;
    const outputTokens = usage.candidatesTokenCount || 0;

    return {
      content,
      model,
      provider: 'google',
      usage: {
        inputTokens,
        outputTokens,
        costUsd: calculateCost(model, inputTokens, outputTokens),
      },
      latencyMs: Date.now() - start,
    };
  }

  // --- Mistral ---

  async _completeMistral(req) {
    const model = req.model || 'mistral-small-latest';
    const start = Date.now();

    const resp = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`,
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
      throw new Error(`Mistral API error ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json();
    const choice = data.choices?.[0];
    const usage = data.usage || {};
    const inputTokens = usage.prompt_tokens || 0;
    const outputTokens = usage.completion_tokens || 0;

    return {
      content: choice?.message?.content || '',
      model,
      provider: 'mistral',
      usage: {
        inputTokens,
        outputTokens,
        costUsd: calculateCost(model, inputTokens, outputTokens),
      },
      latencyMs: Date.now() - start,
    };
  }

  async healthCheck() {
    if (this.subProvider === 'google') return this._healthGoogle();
    return this._healthMistral();
  }

  async _healthGoogle() {
    const start = Date.now();
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GOOGLE_AI_API_KEY}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 5 },
        }),
      });
      return { ok: resp.ok, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }

  async _healthMistral() {
    const start = Date.now();
    try {
      const resp = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'mistral-small-latest',
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
