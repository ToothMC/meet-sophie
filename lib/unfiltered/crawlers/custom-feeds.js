// lib/unfiltered/crawlers/custom-feeds.js — User-spezifische News-
// Quellen. Akzeptiert RSS/Atom-URLs ODER bloße Domains (cyprus-mail.com,
// tagesschau.de) und versucht in dieser Reihenfolge:
//
//   1. URL direkt als RSS parsen (wenn content-type oder body wie XML aussieht)
//   2. HTML laden, <link rel="alternate" type="application/rss+xml"> finden
//   3. Common-path-Fallback: /feed, /rss, /feed.xml, /atom.xml, /rss.xml
//
// Pro Feed max ITEMS_PER_FEED Headlines.

import { parseRssXml } from "./rss-boulevard.js";  // wir re-exportieren den Parser

const MAX_FEEDS_PER_RUN = 6;
const ITEMS_PER_FEED    = 5;
const FETCH_TIMEOUT_MS  = 7000;

const COMMON_FEED_PATHS = [
  "/feed",
  "/rss",
  "/feed.xml",
  "/rss.xml",
  "/atom.xml",
  "/feeds/all.atom.xml",
  "/index.xml",
];

function normalizeUrl(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  // Erlaube auch Domains ohne Protokoll
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    return u.toString();
  } catch {
    return null;
  }
}

function looksLikeXml(body, ct) {
  if (ct && /(xml|rss|atom)/i.test(ct)) return true;
  if (!body) return false;
  const head = body.slice(0, 400).toLowerCase();
  return head.includes("<rss") || head.includes("<feed") || head.includes("<?xml");
}

async function timedFetch(url, opts = {}) {
  return fetch(url, {
    ...opts,
    headers: {
      "User-Agent": "sophie-unfiltered/1.0",
      "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html",
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

// Findet RSS-Links in HTML-<head>
function discoverFeedFromHtml(html, baseUrl) {
  if (!html) return null;
  // grobes regex statt DOMParser (Vercel-Serverless: kein DOM)
  const linkRe = /<link[^>]+rel=["']alternate["'][^>]*>/gi;
  const blocks = html.match(linkRe) || [];
  for (const b of blocks) {
    if (!/type=["'](application\/rss\+xml|application\/atom\+xml)["']/i.test(b)) continue;
    const m = b.match(/href=["']([^"']+)["']/i);
    if (!m) continue;
    try { return new URL(m[1], baseUrl).toString(); } catch { /* ignore */ }
  }
  return null;
}

/**
 * Resolved den Feed für einen User-Eintrag (URL oder Domain).
 * Returns { feed_url, label } oder null wenn nichts gefunden.
 */
export async function resolveFeed(rawEntry) {
  const url = normalizeUrl(rawEntry);
  if (!url) return null;

  // 1. Direct fetch — vielleicht ist es schon ein RSS-Feed
  try {
    const r = await timedFetch(url);
    if (r.ok) {
      const ct = r.headers.get("content-type") || "";
      const body = await r.text();
      if (looksLikeXml(body, ct)) {
        return { feed_url: url, label: extractFeedLabel(body) || new URL(url).hostname };
      }
      // 2. HTML head: <link rel="alternate" type="application/rss+xml">
      const discovered = discoverFeedFromHtml(body, url);
      if (discovered) {
        const r2 = await timedFetch(discovered);
        if (r2.ok) {
          const ct2 = r2.headers.get("content-type") || "";
          const body2 = await r2.text();
          if (looksLikeXml(body2, ct2)) {
            return { feed_url: discovered, label: extractFeedLabel(body2) || new URL(url).hostname };
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[unf/custom] direct fetch failed for ${url}:`, err?.message || err);
  }

  // 3. Common paths
  try {
    const base = new URL(url);
    for (const path of COMMON_FEED_PATHS) {
      const candidate = base.origin + path;
      try {
        const r = await timedFetch(candidate);
        if (!r.ok) continue;
        const ct = r.headers.get("content-type") || "";
        const body = await r.text();
        if (looksLikeXml(body, ct)) {
          return { feed_url: candidate, label: extractFeedLabel(body) || base.hostname };
        }
      } catch { /* try next */ }
    }
  } catch (err) {
    console.warn(`[unf/custom] common-path probe failed for ${url}:`, err?.message || err);
  }

  return null;
}

function extractFeedLabel(xml) {
  if (typeof xml !== "string") return null;
  // <channel><title>...</title></channel>  (RSS)  oder  <feed><title>...</title>  (Atom)
  const m = xml.match(/<channel[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i)
        || xml.match(/<feed[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i)
        || xml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  return String(m[1] || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * Holt für eine Liste User-Einträge die Signale.
 * @param {Object} opts
 * @param {Array<string>} opts.custom_feeds   — URL- oder Domain-Strings vom User
 * @param {Object} [opts.meta]                — vorher gespeicherte resolved-URLs (lazy cache)
 * @returns {Promise<{signals: Array, resolved_map: Object}>}
 */
export async function fetchCustomFeeds({ custom_feeds = [], meta = {} } = {}) {
  if (!Array.isArray(custom_feeds) || custom_feeds.length === 0) {
    return { signals: [], resolved_map: {} };
  }
  const entries = custom_feeds.slice(0, MAX_FEEDS_PER_RUN);

  // Pro Eintrag: wenn meta schon eine resolved feed_url hat, direkt nehmen,
  // sonst auto-discover (best effort).
  const resolved_map = { ...meta };
  const fetchTasks = entries.map(async entry => {
    let resolved = meta[entry];
    if (!resolved || !resolved.feed_url) {
      resolved = await resolveFeed(entry);
      if (resolved) resolved_map[entry] = resolved;
    }
    if (!resolved?.feed_url) return [];

    try {
      const r = await timedFetch(resolved.feed_url);
      if (!r.ok) return [];
      const xml = await r.text();
      const items = parseRssXml(xml, resolved.label || new URL(resolved.feed_url).hostname);
      // mark these signals with source=custom für guards.isTrustedNews
      // — der User hat sie explizit hinterlegt, sie gelten als trusted.
      return items.slice(0, ITEMS_PER_FEED).map(s => ({ ...s, source: "custom", confidence: "news" }));
    } catch (err) {
      console.warn(`[unf/custom] fetch failed for ${resolved.feed_url}:`, err?.message || err);
      return [];
    }
  });

  const results = await Promise.allSettled(fetchTasks);
  const signals = results.flatMap(r => (r.status === "fulfilled" && Array.isArray(r.value) ? r.value : []));
  return { signals, resolved_map };
}
