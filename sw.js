// Offline shell + background deadline checks.
// Bump CACHE whenever the app files change so clients pick up the new version.
const CACHE = 'seminary-v1';

const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/store.js',
  './js/schedule.js',
  './js/notify.js',
  './data/courses.json',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
  './icons/badge.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  // The syllabus is the one file worth refreshing eagerly: network first,
  // cache as the fallback so the app still opens on a plane.
  if (request.url.includes('/data/courses.json')) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
            return res;
          })
          .catch(() => caches.match('./index.html'))
    )
  );
});

// Chrome may wake us here roughly twice a day when the app is installed.
// Open a hidden client so the app's own reminder logic runs.
self.addEventListener('periodicsync', (event) => {
  if (event.tag !== 'check-deadlines') return;
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (clients.length) {
        clients[0].postMessage({ type: 'check-deadlines' });
        return;
      }
      // No window open — the page cannot run, so nudge the user to open it
      // only if something is actually due soon.
      const res = await caches.match('./data/courses.json');
      if (!res) return;
      const data = await res.json();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const soon = [];
      for (const course of data.courses) {
        for (const session of course.sessions) {
          const [y, m, d] = session.date.split('-').map(Number);
          const when = new Date(y, m - 1, d);
          const days = Math.round((when - today) / 86400000);
          if (days >= 0 && days <= 2 && (session.readings?.length || session.assignments?.length)) {
            soon.push(`${course.short || course.name}: ${session.topic} (${days === 0 ? 'today' : `in ${days} days`})`);
          }
        }
      }
      if (!soon.length) return;
      await self.registration.showNotification('Coming up', {
        body: soon.join('\n'),
        tag: 'periodic-check',
        icon: './icons/icon-192.png',
        badge: './icons/badge.png',
        data: { url: './' }
      });
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((c) => c.url.includes(self.registration.scope));
      if (existing) return existing.focus();
      return self.clients.openWindow(event.notification.data?.url || './');
    })
  );
});
