const CACHE_NAME = 'auradrive-cache-v1';
const ASSETS = [
    // '/',
    '/index.html',
    '/styles.css',
    '/app.js',
    '/manifest.json',
    '/icon-192.png',
    '/icon-512.png',
    'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
    'https://unpkg.com/lucide@latest'
];

// Install Event - Caching Assets
self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[Service Worker] Caching App Shell Assets');
            return cache.addAll(ASSETS);
        })
    );
});

// Activate Event - Clearing old caches
self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.map((key) => {
                    if (key !== CACHE_NAME) {
                        console.log('[Service Worker] Clearing old cache:', key);
                        return caches.delete(key);
                    }
                })
            );
        })
    );
});

// Fetch Event - Network First with Cache Fallback
self.addEventListener('fetch', (e) => {
    // Only cache GET requests (ignore PeerJS signaling or external POST requests)
    if (e.request.method !== 'GET') return;

    e.respondWith(
        fetch(e.request)
            .then((res) => {
                // Clone response to put in cache
                const resClone = res.clone();
                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(e.request, resClone);
                });
                return res;
            })
            .catch(() => {
                // If network fails, serve from cache
                return caches.match(e.request);
            })
    );
});
