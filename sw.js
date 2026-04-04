// Service Worker v3 — Network First, bypass HTTP cache, auto-reload on update
const CACHE = "sophie-v3";

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
  if (request.url.includes("/api/")) return;
  if (request.url.includes("/auth/")) return;

  e.respondWith(
    fetch(request, { cache: "no-store" })
      .then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(request, clone));
        }
        return res;
      })
      .catch(() => caches.match(request))
  );
});
