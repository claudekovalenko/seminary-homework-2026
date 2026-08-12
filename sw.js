// Offline shell + background deadline checks.
//
// Caching strategy, learned the hard way: the app shell is served
// stale-while-revalidate, never plain cache-first. Cache-first meant a phone
// that had once loaded the app kept serving that version forever, and new
// features silently never arrived. Now every load paints instantly from cache
// *and* refreshes the cache in the background, so the next load is current.
const CACHE = 'seminary-v17';

const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/bundle.js',
  './data/courses.json',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
  './icons/badge.png'
];

// Wanted offline, but not worth failing an install over: nearly a megabyte of
// PDF on a phone with one bar. addAll() is all-or-nothing, so these are fetched
// separately and allowed to fail — the fetch handler will cache them on first
// use instead.
const EXTRAS = [
  './syllabi/theology-1-theo-7003-fall-2026.pdf',
  './syllabi/intermediate-greek-grek-6003-fall-2026.pdf'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(SHELL);
      await Promise.all(EXTRAS.map((url) => cache.add(url).catch(() => {})));
      await self.skipWaiting();
    })()
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

// `no-cache` forces a revalidation against the server. Without it the browser's
// own HTTP cache can answer this fetch, and "network-first" quietly serves
// week-old files — which is exactly how a new version fails to arrive.
async function freshen(request) {
  const res = await fetch(request, { cache: 'no-cache' });
  if (res && res.ok) {
    const copy = res.clone();
    const cache = await caches.open(CACHE);
    await cache.put(request, copy);
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  // The page, its code and the syllabus go to the network first. They have to
  // agree with each other: serving a fresh index.html beside a stale app.js
  // renders the new layout against old code. Cache is the offline fallback.
  const code = ['document', 'script', 'style'].includes(request.destination);
  if (request.mode === 'navigate' || code || request.url.includes('/data/courses.json')) {
    event.respondWith(
      freshen(request).catch(async () => (await caches.match(request)) || caches.match('./index.html'))
    );
    return;
  }

  // Icons and everything else change rarely and are the bulky part: answer from
  // cache at once, refresh behind the scenes for next time.
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = freshen(request).catch(() => hit);
      return hit || network;
    })
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
