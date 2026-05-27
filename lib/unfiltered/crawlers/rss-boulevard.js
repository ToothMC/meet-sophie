// lib/unfiltered/crawlers/rss-boulevard.js — RSS-Feeds vom Boulevard.
// Wir parsen nur Headlines + descriptions (kein full-text), das reicht
// für den Synthesizer und hält den Pipeline-Footprint klein.

const FEEDS_BY_COUNTRY = {
  DE: [
    { url: "https://www.bunte.de/themen/aktuell.xml",          publisher: "Bunte" },
    { url: "https://www.gala.de/feed.rss",                     publisher: "Gala" },
    { url: "https://www.promiflash.de/rss/news.xml",           publisher: "Promiflash" },
  ],
  AT: [
    { url: "https://www.heute.at/feeds/promis/rss.xml",        publisher: "Heute" },
  ],
  CH: [
    { url: "https://www.blick.ch/people-tv/rss.xml",           publisher: "Blick" },
  ],
  GB: [
    { url: "https://www.dailymail.co.uk/tvshowbiz/index.rss",  publisher: "Daily Mail" },
    { url: "https://www.thesun.co.uk/tvandshowbiz/feed/",      publisher: "The Sun" },
  ],
  US: [
    { url: "https://www.tmz.com/rss.xml",                       publisher: "TMZ" },
    { url: "https://pagesix.com/feed/",                         publisher: "Page Six" },
  ],
};

const MAX_FEEDS_PER_RUN = 4;
const ITEMS_PER_FEED    = 6;

// Sehr schmaler RSS/Atom-Parser via regex — wir wollen keine xml2js-
// Dependency reinholen für ein paar Headlines. Exportiert, damit
// custom-feeds.js denselben Parser wiederverwenden kann.
export function parseRssXml(xml, publisher) {
  if (typeof xml !== "string") return [];
  const items = [];
  const re = /<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi;
  const blocks = xml.match(re) || [];
  for (const b of blocks.slice(0, ITEMS_PER_FEED)) {
    const title = decode(pick(b, /<title[^>]*>([\s\S]*?)<\/title>/i));
    const link  = decode(pickLink(b));
    const desc  = decode(pick(b, /<description[^>]*>([\s\S]*?)<\/description>/i)
                  || pick(b, /<summary[^>]*>([\s\S]*?)<\/summary>/i));
    if (!title) continue;
    items.push({
      source:    "rss",
      publisher,
      headline:  title.slice(0, 240),
      url:       link || null,
      text:      stripTags(desc || "").slice(0, 400),
      confidence: "boulevard",
      fetched_at: new Date().toISOString(),
    });
  }
  return items;
}
function pick(s, re) {
  const m = s.match(re);
  return m ? m[1] : "";
}
function pickLink(b) {
  // RSS: <link>url</link>  |  Atom: <link href="url"/>
  const m1 = b.match(/<link[^>]*>([^<]+)<\/link>/i);
  if (m1) return m1[1].trim();
  const m2 = b.match(/<link[^>]+href=["']([^"']+)["']/i);
  if (m2) return m2[1].trim();
  return "";
}
function decode(s) {
  if (!s) return "";
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .trim();
}
function stripTags(s) { return String(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }

export async function fetchRSSBoulevard({ country = "DE" } = {}) {
  const feeds = (FEEDS_BY_COUNTRY[country] || FEEDS_BY_COUNTRY.DE).slice(0, MAX_FEEDS_PER_RUN);
  const all = [];
  for (const f of feeds) {
    try {
      const r = await fetch(f.url, {
        headers: { "User-Agent": "sophie-unfiltered/1.0", "Accept": "application/rss+xml, application/atom+xml, application/xml" },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) {
        console.warn(`[unf/rss] ${f.publisher} HTTP ${r.status}`);
        continue;
      }
      const xml = await r.text();
      const items = parseRss(xml, f.publisher);
      all.push(...items);
    } catch (err) {
      console.warn(`[unf/rss] ${f.publisher} failed:`, err?.message || err);
    }
  }
  return all;
}
