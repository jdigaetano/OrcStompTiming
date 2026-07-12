const CACHE_NAME = 'orc-stomp-v1.4.5';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/launchericon-192x192.png',
  './icons/launchericon-512x512.png',
  './BleDriver.js',
  './TimingEngine.js',
  './AppUI.js'
];

// Install Event - Caching Assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Service Worker: Caching Assets');
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate Event - Cleaning up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('Service Worker: Clearing Old Cache');
            return caches.delete(cache);
          }
        })
      );
    })
  );
});

// Fetch Event - Network first, fall back to cache when offline.
// This means changes are always picked up immediately when the server is
// reachable, with no version-bumping required. Cache is only used when
// the network is unavailable (the actual offline PWA scenario).
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
