const CACHE_NAME = "tikboo-v1";

const ASSETS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",

  "/assets/css/app.css",
  "/assets/css/ui/icons.css",
  "/assets/css/ui/videoMeta.css",

  "/assets/js/app.js",
  "/assets/js/swipe.js",

  "/assets/swipe-192x192.png",
  "/assets/swipe-512x512.png",
  "/assets/swipe-logo.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );

  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );

  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request).then((response) => {
          const copy = response.clone();

          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, copy);
          });

          return response;
        })
      );
    })
  );
});
