// Hearth's offline shell: network first for everything (the remote must never
// be stale), the last copy when there's no network, so the app can open away
// from home and show Light Racer. The API and live events are never cached.
const CACHE = 'hearth-shell-v1';
const PRECACHE = ['./', 'racer/', 'racer/racer.js', 'racer/racer.css', 'feel.js', 'shapes.js', 'vendor/aurora-field.min.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('hearth-shell-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const fonts = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!fonts && (url.origin !== location.origin || url.pathname.includes('/api/'))) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok || res.type === 'opaque') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: !fonts }).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./') : Response.error()))),
  );
});
