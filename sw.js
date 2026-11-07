// データやコードを更新したら必ずこの番号を上げる。上げ忘れると端末に古い版が残る。
const CACHE_NAME = 'hum-to-score-v7';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/pitch.js',
  './js/score.js',
  './js/score-view.js',
  './js/musicxml.js',
  './js/audio.js',
  './js/recorder-worklet.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// HTML と JSON は最新を優先し、オフラインのときだけ保存分を使う。
function isNetworkFirst(request) {
  const url = new URL(request.url);
  return request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('.json');
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
    return response;
  } catch (error) {
    return (await caches.match(request)) || caches.match('./index.html');
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  const cache = await caches.open(CACHE_NAME);
  cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || !event.request.url.startsWith(self.location.origin)) return;
  event.respondWith(isNetworkFirst(event.request) ? networkFirst(event.request) : cacheFirst(event.request));
});
