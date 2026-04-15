// Service Worker v5 — HTML: always fresh, assets: respect HTTP cache,
// cross-origin: pass through untouched. Auto-reload clients on update.
const CACHE = "sophie-v5";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
    .then(() => self.clients.claim())
    .then(() => self.clients.matchAll().then((clients) =>
      clients.forEach((c) => c.postMessage({ type: "SW_UPDATED" }))
    ))
  );
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;

  let url;
  try { url = new URL(request.url); } catch { return; }

  // Cross-origin (plausible, fonts, cdn, supabase, openai…) — let the browser
  // handle these directly. Intercepting them caused "Failed to convert value
  // to 'Response'" when an adblocker or network error rejected the fetch.
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname.startsWith("/auth/")) return;
  if (url.pathname === "/site.webmanifest") return; // never cache — auth-protected on preview deploys

  // HTML navigations must never be stale — force network, bypass HTTP cache.
  // This was the original reason for SW v2's cache:no-store.
  const isHTML =
    request.mode === "navigate" ||
    request.destination === "document" ||
    (request.headers.get("accept") || "").includes("text/html");

  if (isHTML) {
    e.respondWith(
      fetch(request, { cache: "no-store" })
        .catch(() => caches.match(request).then((r) => r || Response.error()))
    );
    return;
  }

  // Static assets: respect HTTP cache headers (max-age + SWR from vercel.json).
  // Cache in SW for offline fallback only.
  e.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE)
            .then((c) => c.put(request, clone))
            .catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(request).then((r) => r || Response.error()))
  );
});
