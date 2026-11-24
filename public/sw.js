/* TRAP VANI AI: lightweight install/offline shell only.
   Never cache API responses, recordings, imported audio, or the built-in 808 library.
   The studio's audio assets remain network-loaded and are managed by the app itself. */
const CACHE_NAME = 'trap-vani-shell-v2';
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/trap-vani-icon.svg'];
const NEVER_CACHE_PREFIXES = ['/api/', '/audio/'];
const CACHEABLE_ASSET = /\.(?:js|css|svg|png|webp|ico|woff2?)$/i;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith('trap-vani-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return;
  if (url.pathname.endsWith('.wav') || url.pathname.endsWith('.mp3') || url.pathname.endsWith('.ogg') || url.pathname.endsWith('.m4a')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy));
        }
        return response;
      }).catch(async () => (await caches.match('/index.html')) || (await caches.match('/')))
    );
    return;
  }

  // Cache only small application assets. Unknown data endpoints remain network-only.
  if (!CACHEABLE_ASSET.test(url.pathname)) return;
  event.respondWith(
    caches.match(request).then(async (cached) => {
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        const copy = response.clone();
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, copy);
      }
      return response;
    })
  );
});
