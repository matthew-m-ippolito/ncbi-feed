/* Bump VERSION whenever you change index.html / app.css / app.js. */
var VERSION = 'v23';
var SHELL = 'shell-' + VERSION;
var DATA = 'data-' + VERSION;
var SHELL_FILES = [
  './', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL).then(function (c) {
      // cache:'reload' forces fresh copies from the network (never the HTTP cache)
      return c.addAll(SHELL_FILES.map(function (u) { return new Request(u, { cache: 'reload' }); }));
    }).then(function () { return self.skipWaiting(); })
      .catch(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== SHELL && k !== DATA) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function staleWhileRevalidate(req) {
  return caches.open(DATA).then(function (cache) {
    return cache.match(req).then(function (cached) {
      var net = fetch(req).then(function (res) {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(function () { return cached; });
      return cached || net;
    });
  });
}

// network-first for the app shell: always latest when online, cache fallback when offline
function networkFirst(req) {
  return fetch(req).then(function (res) {
    if (res && res.ok && res.type === 'basic') {
      var copy = res.clone();
      caches.open(SHELL).then(function (c) { c.put(req, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(req).then(function (c) {
      return c || (req.mode === 'navigate' ? caches.match('index.html') : Response.error());
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let PubMed etc. go to network

  // data files: fast + offline-capable, refreshed in background
  if (/\/(articles|abstracts)\.json$/.test(url.pathname)) {
    if (req.cache === 'no-store') return;          // the page's explicit freshness probe
    e.respondWith(staleWhileRevalidate(req));
    return;
  }

  // app shell + navigations: network-first so updates appear immediately when online
  e.respondWith(networkFirst(req));
});
