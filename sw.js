const CACHE_NAME = "minha-caminhada-v13";

const APP_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icon.svg"
];

const CDN_HOSTS = ["unpkg.com"];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(
              key =>
                key.startsWith("minha-caminhada-") &&
                key !== CACHE_NAME
            )
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

function openMapDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(
      "minha-caminhada-dados-v2",
      1
    );

    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("data")) {
        req.result.createObjectStore("data");
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function readMap() {
  return openMapDB().then(db =>
    new Promise((resolve, reject) => {
      const req = db
        .transaction("data", "readonly")
        .objectStore("data")
        .get("offline-map");

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    })
  );
}

async function serveArchive(request) {
  const item = await readMap();

  if (!item || !item.blob) {
    return new Response(
      "Mapa offline não instalado.",
      { status: 404 }
    );
  }

  const blob = item.blob;
  const size = blob.size;
  const range = request.headers.get("Range");

  const headers = {
    "Content-Type": "application/vnd.pmtiles",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store"
  };

  if (!range) {
    headers["Content-Length"] = String(size);

    return new Response(blob, {
      status: 200,
      headers
    });
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);

  if (!match) {
    return new Response(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${size}`
      }
    });
  }

  let start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));

  let end =
    match[2] && match[1]
      ? Number(match[2])
      : size - 1;

  if (start >= size || end < start) {
    return new Response(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${size}`
      }
    });
  }

  end = Math.min(end, size - 1);

  const part = blob.slice(start, end + 1);

  headers["Content-Length"] = String(part.size);
  headers["Content-Range"] =
    `bytes ${start}-${end}/${size}`;

  return new Response(part, {
    status: 206,
    headers
  });
}

self.addEventListener("fetch", event => {
  const request = event.request;

  if (
    request.method !== "GET" &&
    request.method !== "HEAD"
  ) {
    return;
  }

  const url = new URL(request.url);

  if (
    url.origin === self.location.origin &&
    url.pathname.endsWith("/offline-map/current.pmtiles")
  ) {
    event.respondWith(serveArchive(request));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then(async cached => {
        if (cached) return cached;

        try {
          const response = await fetch(request);

          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);

            cache.put(request, response.clone());
          }

          return response;
        } catch (error) {
          if (request.mode === "navigate") {
            return caches.match("./index.html");
          }

          return new Response(
            "Arquivo indisponível offline.",
            { status: 503 }
          );
        }
      })
    );

    return;
  }

  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.match(request).then(async cached => {
        if (cached) return cached;

        try {
          const response = await fetch(request);

          if (response.ok || response.type === "opaque") {
            const cache = await caches.open(CACHE_NAME);

            cache.put(request, response.clone());
          }

          return response;
        } catch (error) {
          return new Response(
            "Biblioteca indisponível offline.",
            { status: 503 }
          );
        }
      })
    );
  }
});
