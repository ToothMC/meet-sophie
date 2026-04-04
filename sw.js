// Service Worker — Network First, Cache Fallback
// HTML/JS always fetched fresh from network; cached copy only used offline.

const CACHE = "sophie-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const { request } = e;

  // Skip non-GET and API/auth requests
  if (request.method !== "GET") return;
  if (request.url.includes("/api/")) return;
  if (request.url.includes("/auth/")) return;

  e.respondWith(
    fetch(request)
      .then((res) => {
        // Cache successful responses for offline use
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(request, clone));
        }
        return res;
      })
      .catch(() => caches.match(request)) // Offline fallback
  );
});
