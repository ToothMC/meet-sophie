// lib/ai/fact-check.js — Sophie answers first, this checks afterwards.
// Two steps: does the answer assert anything externally checkable, and does the
// evidence contradict it. Only contradictions surface. "Unverifiable" stays
// silent on purpose — constant hedging erodes trust more than it protects.
import { getAdapter } from './adapters/index.js';
import { redactSensitive } from './redact.js';

export const FACT_CHECK_MODEL = { provider: 'openai', model: 'gpt-4o-mini' };
export const MAX_CLAIMS = 3;
export const TIMEOUTS = { detectMs: 6000, verifyMs: 8000 };
export const LIMITS = { question: 1000, answer: 3000, claim: 300, query: 200, correction: 400, evidence: 2000 };

const DETECT_SYSTEM =
  'Du prüfst, ob eine Gesprächsantwort überprüfbare Tatsachenbehauptungen enthält. ' +
  'Überprüfbar heißt: extern nachschlagbar und eindeutig richtig oder falsch — Gesetzeslagen, Zahlen, Preise, Daten, ' +
  'Ereignisse, Eigenschaften benannter Dinge oder Personen. ' +
  'NICHT überprüfbar: Meinungen, Ratschläge, Abwägungen, Gefühle, Aussagen über den Gesprächspartner oder über dich selbst, ' +
  'allgemeine Lebensweisheiten, Hypothesen und alles, was erkennbar als Einschätzung formuliert ist. ' +
  'Entscheide aus dem Zusammenhang, nicht anhand einzelner Wörter. ' +
  `Antworte AUSSCHLIESSLICH als JSON: {"claims":[{"claim":"...","query":"..."}]} — höchstens ${MAX_CLAIMS} Einträge, ` +
  'claim ist die Behauptung in einem Satz, query eine knappe Suchanfrage dazu. ' +
  'Enthält die Antwort nichts Überprüfbares: {"claims":[]}.';

const VERIFY_SYSTEM =
  'Du prüfst eine einzelne Behauptung gegen Rechercheergebnisse. ' +
  'Antworte AUSSCHLIESSLICH als JSON: {"verdict":"supported|contradicted|unverifiable","correction":"..."}. ' +
  '"contradicted" nur, wenn die Belege der Behauptung klar widersprechen — nicht bei Unschärfe, fehlendem Beleg oder ' +
  'bloß anderer Betonung. Im Zweifel "unverifiable". ' +
  'correction ist nur bei "contradicted" gefüllt: ein Satz, was stattdessen gilt. Sonst leerer String.';

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms))]);
}

function parseJson(text) {
  try { return JSON.parse(String(text ?? '').trim()); } catch { return null; }
}

function clamp(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }

/** @returns {Array<{claim: string, query: string}>} */
export function parseClaims(text) {
  const obj = parseJson(text);
  if (!obj || !Array.isArray(obj.claims)) return [];
  const out = [];
  for (const c of obj.claims.slice(0, MAX_CLAIMS)) {
    const claim = clamp(typeof c === 'string' ? c : c?.claim, LIMITS.claim);
    if (!claim) continue;
    out.push({ claim, query: clamp(c?.query, LIMITS.query) || claim.slice(0, LIMITS.query) });
  }
  return out;
}

/** @returns {{ verdict: 'supported'|'contradicted'|'unverifiable', correction: string }} */
export function parseVerdict(text) {
  const obj = parseJson(text);
  const verdict = String(obj?.verdict ?? '').trim().toLowerCase();
  const known = ['supported', 'contradicted', 'unverifiable'].includes(verdict) ? verdict : 'unverifiable';
  const correction = clamp(obj?.correction, LIMITS.correction);
  // A contradiction without a usable correction is not actionable — treat as unverified.
  if (known === 'contradicted' && !correction) return { verdict: 'unverifiable', correction: '' };
  return { verdict: known, correction };
}

/**
 * @param {{ question: string, answer: string, search: (q: string) => Promise<{text?: string, sources?: Array}>,
 *           complete?: (messages: Array, timeoutMs: number, role: string) => Promise<{content: string, usage?: object}>,
 *           onCost?: (entry: object) => void }} opts
 * @returns {Promise<{ checked: number, corrections: Array<{claim, correction, sources}>, verdicts: string[] }>}
 */
export async function verifyAnswer({ question, answer, search, complete: injected, onCost = () => {} }) {
  const q = redactSensitive(String(question || '').slice(0, LIMITS.question));
  const a = redactSensitive(String(answer || '').slice(0, LIMITS.answer));
  if (!a.text.trim()) return { checked: 0, corrections: [], verdicts: [] };

  const complete = injected || ((messages, timeoutMs, role) => withTimeout(
    getAdapter(FACT_CHECK_MODEL.provider)
      .complete({ messages, model: FACT_CHECK_MODEL.model, maxTokens: 700, temperature: 0, json: true })
      .then(r => { onCost({ ...FACT_CHECK_MODEL, usage: r.usage, role }); return r; }),
    timeoutMs,
  ));

  let claims = [];
  try {
    const detected = await complete([
      { role: 'system', content: DETECT_SYSTEM },
      { role: 'user', content: `FRAGE DES NUTZERS:\n${q.text}\n\nANTWORT:\n${a.text}` },
    ], TIMEOUTS.detectMs, 'detect');
    claims = parseClaims(detected.content);
  } catch (e) {
    console.warn('[factcheck] claim detection failed:', e?.message?.slice(0, 120));
    return { checked: 0, corrections: [], verdicts: [] };
  }

  if (!claims.length) return { checked: 0, corrections: [], verdicts: [] };

  const results = await Promise.allSettled(claims.map(async ({ claim, query }) => {
    const found = await search(query);
    const evidence = redactSensitive(String(found?.text || '').slice(0, LIMITS.evidence)).text;
    if (!evidence.trim()) return { claim, verdict: 'unverifiable', correction: '', sources: [] };

    const checked = await complete([
      { role: 'system', content: VERIFY_SYSTEM },
      { role: 'user', content: `BEHAUPTUNG:\n${claim}\n\nRECHERCHE:\n${evidence}` },
    ], TIMEOUTS.verifyMs, 'verify');
    const { verdict, correction } = parseVerdict(checked.content);
    return { claim, verdict, correction, sources: (found?.sources || []).slice(0, 2) };
  }));

  const settled = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  return {
    checked: claims.length,
    verdicts: settled.map(r => r.verdict),
    corrections: settled.filter(r => r.verdict === 'contradicted')
      .map(({ claim, correction, sources }) => ({ claim, correction, sources })),
  };
}
