// Minimal service worker so the app is installable (PWA). Network-first: the server is local, offline is not a goal.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  const url = new URL(e.request.url);
  // relative to where the app lives (the scope is sw.js's folder), not to the origin's root
  const base = new URL(self.registration.scope).pathname;
  if (url.pathname.startsWith(base + 'api/') || url.pathname === base + 'ws') return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request).then((r) => r || new Response('离线：无法连接 Claude Web 服务', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } }))));
});
