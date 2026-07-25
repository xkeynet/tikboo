// /sw.js

const CACHE_VERSION = 'tikboo-static-v1';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',

  '/assets/css/app.css',
  '/assets/css/ui/icons.css',
  '/assets/css/ui/videoMeta.css',

  '/assets/js/app.js',
  '/assets/js/swipe.js',
  '/assets/js/ui/interactions.js',
  '/assets/js/data/playlist.js',
  '/assets/js/utils/supabaseClient.js',

  '/assets/swipe-logo.png',
  '/assets/swipe-180x180.png',
  '/assets/swipe-192x192.png',
  '/assets/swipe-512x512.png',

  '/assets/icons/phone.svg',
  '/assets/icons/heart.svg',
  '/assets/icons/talk.svg',
  '/assets/icons/bookmark.svg',
  '/assets/icons/share.svg',
  '/assets/icons/dots.svg',
  '/assets/icons/play.svg',
  '/assets/icons/home.svg',
  '/assets/icons/search.svg',
  '/assets/icons/plus.svg',
  '/assets/icons/messages.svg',
  '/assets/icons/user.svg'
];

function isHttpRequest(request) {
  try {
    const url = new URL(request.url);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isSameOrigin(request) {
  try {
    return new URL(request.url).origin === self.location.origin;
  } catch {
    return false;
  }
}

function isVideoStreamRequest(request) {
  try {
    const url = new URL(request.url);
    const pathname = url.pathname.toLowerCase();

    return (
      pathname.endsWith('.m3u8') ||
      pathname.endsWith('.ts') ||
      pathname.endsWith('.m4s') ||
      pathname.endsWith('.mp4') ||
      pathname.endsWith('.mpd') ||
      request.destination === 'video' ||
      request.headers.has('range')
    );
  } catch {
    return false;
  }
}

function isNavigationRequest(request) {
  return request.mode === 'navigate';
}

function isStaticAssetRequest(request) {
  if (!isSameOrigin(request)) return false;

  return (
    request.destination === 'style' ||
    request.destination === 'script' ||
    request.destination === 'image' ||
    request.destination === 'font' ||
    request.destination === 'manifest'
  );
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);

    if (response && response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      await cache.put(request, response.clone());
    }

    return response;
  } catch {
    const cached = await caches.match(request);

    if (cached) return cached;

    const fallback = await caches.match('/index.html');

    if (fallback) return fallback;

    return new Response('Tikboo is temporarily unavailable.', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8'
      }
    });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);

  const networkPromise = fetch(request)
    .then(async (response) => {
      if (response && response.ok) {
        await cache.put(request, response.clone());
      }

      return response;
    })
    .catch(() => null);

  if (cached) {
    void networkPromise;
    return cached;
  }

  const networkResponse = await networkPromise;

  if (networkResponse) return networkResponse;

  return new Response('', {
    status: 504,
    statusText: 'Gateway Timeout'
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(async (cache) => {
      const results = await Promise.allSettled(
        STATIC_ASSETS.map((asset) => cache.add(asset))
      );

      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          console.warn(
            '[Tikboo SW] Asset was not cached:',
            STATIC_ASSETS[index],
            result.reason
          );
        }
      });
    })
  );

  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((cacheName) => cacheName !== CACHE_VERSION)
          .map((cacheName) => caches.delete(cacheName))
      )
    )
  );

  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') return;
  if (!isHttpRequest(request)) return;

  /*
   * HLS, MP4, Range requests and all external requests bypass
   * Service Worker caching completely.
   */
  if (!isSameOrigin(request) || isVideoStreamRequest(request)) {
    return;
  }

  if (isNavigationRequest(request)) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (isStaticAssetRequest(request)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
