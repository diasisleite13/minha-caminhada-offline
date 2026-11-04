
const CACHE_NAME = "minha-caminhada-v8";

const FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icon.svg",
  "./vendor/leaflet.js",
  "./vendor/leaflet.css"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key =>
            key.startsWith("minha-caminhada-") &&
            key !== CACHE_NAME
          )
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then(async cached => {
      if (cached) return cached;

      try {
        const response = await fetch(request);

        if (response.ok) {
          const copy = response.clone();

          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, copy);
        }

        return response;

      } catch (error) {
        if (request.mode === "navigate") {
          return await caches.match("./index.html");
        }

        return new Response("Arquivo não disponível offline.", {
          status: 503
        });
      }
    })
  );
});
