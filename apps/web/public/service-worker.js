const VERSION = 'taskora-shell-v2';
const SHELL = [ '/', '/manifest.webmanifest', '/icon.svg' ];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => (key.startsWith('zarghamflow-') || key.startsWith('taskora-shell-')) && key !== VERSION).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) { const copy = response.clone(); void caches.open(`${VERSION}-api`).then((cache) => cache.put(request, copy)); }
      return response;
    }).catch(async () => (await caches.match(request)) || new Response(JSON.stringify({ error: { code: 'OFFLINE', message: 'Offline. Cached data is available; edits will sync when reconnected.' } }), { status: 503, headers: { 'content-type': 'application/json' } })));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => (await caches.match('/'))));
    return;
  }
  event.respondWith(caches.open(VERSION).then(async (cache) => {
    const cached = await cache.match(request);
    const update = fetch(request).then((response) => { if (response.ok) void cache.put(request, response.clone()); return response; }).catch(() => cached);
    return cached || update;
  }));
});
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(self.registration.showNotification(data.title || 'Taskora reminder', {
    body: data.body || '', icon: '/icon.svg', badge: '/icon.svg', data: { url: data.url || '/', actions: data.actions || [] },
    actions: (data.actions || []).map((action) => ({ action: action.action, title: action.title }))
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const selected = event.notification.data?.actions?.find((action) => action.action === event.action);
  event.waitUntil(self.clients.openWindow(selected?.url || event.notification.data?.url || '/'));
});
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});
