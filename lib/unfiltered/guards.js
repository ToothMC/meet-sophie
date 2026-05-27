// lib/unfiltered/guards.js — Hartcodierte No-Go-Filter für Briefing-Signals.
//
// Idee:
//  - SENSITIVE_PATTERNS dürfen NUR auftauchen, wenn die Quelle als "news"
//    klassifiziert ist (verifizierte Boulevard-/Nachrichten-Outlets, nicht
//    Reddit/Forum/Tweet). Sonst raus.
//  - KID_PATTERNS sind immer raus, egal welche Quelle.
//  - User-spezifische avoid_topics werden zusätzlich gefiltert.

const SENSITIVE_PATTERNS = [
  /\b(schwanger|pregnant|expecting|baby[\s-]?bump)\b/i,
  /\b(krank|illness|cancer|krebs|hiv|aids|diagnose|sterben|todeskampf|chemo|tumor)\b/i,
  /\b(schwul|lesbisch|gay|bisexual|trans|outing|outed|coming[\s-]?out)\b/i,
  /\b(missbrauch|abuse|assault|vergewaltig|sexual\s+misconduct|grooming)\b/i,
  /\b(suizid|suicide|selbstmord|self[\s-]?harm)\b/i,
  /\b(magersucht|anorexia|bulimia|ess[\s-]?störung|eating\s+disorder)\b/i,
];

const KID_PATTERNS = [
  /\b(minderjährig|underage|child\s+actor|kinderstar)\b/i,
  /\bteen[\s-]?(pregnan|mom|dad|parent)/i,             // "teen pregnancy", "teen-mom"
  /\b(tochter|sohn|daughter|son)\b\s*\(?\s*(\d{1,2})\s*\)?/i,  // "Tochter (15)", "Sohn 12"
  /\b(\d{1,2})\s*[\-– ]?\s*(jahre\s+alt|jähr|year[\s-]?old).{0,30}(kind|teen|jugendlich|child)/i,
];

const TRUSTED_NEWS_SOURCES = new Set([
  "news", "spiegel.de", "zeit.de", "sueddeutsche.de", "faz.net", "tagesschau.de",
  "bbc.com", "bbc.co.uk", "reuters.com", "apnews.com", "nytimes.com", "washingtonpost.com",
  "theguardian.com", "ft.com", "wsj.com",
]);

function isTrustedNews(signal) {
  const src = String(signal?.source || "").toLowerCase();
  if (TRUSTED_NEWS_SOURCES.has(src)) return true;
  const pub = String(signal?.publisher || "").toLowerCase();
  if (!pub) return false;
  for (const dom of TRUSTED_NEWS_SOURCES) {
    if (dom === "news") continue;
    // Full domain match ("bbc.com") OR base-name match ("spiegel" in
    // "Spiegel Online") — publishers in feeds rarely include TLDs.
    if (pub.includes(dom)) return true;
    const stem = dom.split(".")[0];
    if (stem && stem.length > 2 && pub.includes(stem)) return true;
  }
  return false;
}

/**
 * Filtert die gesammelten Signale nach den Hard-Line-Regeln.
 * @param {Array} signals  von runCrawlers gesammelt
 * @param {Object} [opts]
 * @param {Array<string>} [opts.avoid_topics]  user-defined blocklist
 * @returns {Array}  gefilterte Signale
 */
export function filterByGuards(signals, { avoid_topics = [] } = {}) {
  if (!Array.isArray(signals)) return [];
  const avoid = Array.isArray(avoid_topics)
    ? avoid_topics.map(t => String(t || "").trim().toLowerCase()).filter(Boolean)
    : [];

  return signals.filter(s => {
    if (!s || typeof s !== "object") return false;
    const text = `${s.headline || ""} ${s.text || ""}`.toLowerCase();

    // Minderjährigen-Bezug: immer raus
    if (KID_PATTERNS.some(p => p.test(text))) return false;

    // Sensible Pattern: nur durchlassen wenn vertrauenswürdige News-Quelle
    if (SENSITIVE_PATTERNS.some(p => p.test(text))) {
      if (!isTrustedNews(s)) return false;
    }

    // User-Blocklist
    if (avoid.length && avoid.some(t => t && text.includes(t))) return false;

    return true;
  });
}

// Convenience-Exports für Tests
export const _internals = { SENSITIVE_PATTERNS, KID_PATTERNS, TRUSTED_NEWS_SOURCES, isTrustedNews };
