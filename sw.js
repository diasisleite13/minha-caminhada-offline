
const CACHE_NAME = "minha-caminhada-v10";

const FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icon.svg"
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

  // Arquivos da biblioteca Leaflet:
  // armazenar para permitir uso offline posterior.
  if (
    url.hostname === "unpkg.com" &&
    url.pathname.includes("/leaflet@1.9.4/")
  ) {
    event.respondWith(
      caches.match(request).then(async cached => {
        if (cached) return cached;

        try {
          const response = await fetch(request);

          if (response.ok || response.type === "opaque") {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(request, response.clone());
          }

          return response;

        } catch (error) {
          return new Response(
            "Biblioteca Leaflet indisponível offline.",
            { status: 503 }
          );
        }
      })
    );

    return;
  }

  // Não armazenar automaticamente todos os
  // blocos de mapas, pois isso pode consumir
  // muito espaço no aparelho.
  if (
    url.hostname.endsWith("openstreetmap.org")
  ) {
    return;
  }

  // Arquivos do próprio aplicativo.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then(async cached => {
        if (cached) return cached;

        try {
          const response = await fetch(request);

          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);

            await cache.put(
              request,
              response.clone()
            );
          }

          return response;

        } catch (error) {
          if (request.mode === "navigate") {
            return await caches.match("./index.html");
          }

          return new Response(
            "Arquivo indisponível offline.",
            { status: 503 }
          );
        }
      })
    );
  }
});
