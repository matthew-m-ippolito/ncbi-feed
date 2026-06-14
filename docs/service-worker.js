/* Bump VERSION whenever you change index.html / app.css / app.js. */
var VERSION = 'v6';
var SHELL = 'shell-' + VERSION;
var DATA = 'data-' + VERSION;
var SHELL_FILES = [
  './', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL).then(function (c) { return c.addAll(SHELL_FILES); })
      .then(function () { return self.skipWaiting(); })
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

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let PubMed etc. go to network

  // data files: fresh-ish but offline-capable
  if (/\/(articles|abstracts)\.json$/.test(url.pathname)) {
    if (req.cache === 'no-store') return; // page's explicit freshness probe → straight to network
    e.respondWith(staleWhileRevalidate(req));
    return;
  }

  // navigations: serve app shell
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('index.html').then(function (c) { return c || fetch(req); }));
    return;
  }

  // shell assets: cache-first, fall back to network and cache it
  e.respondWith(
    caches.match(req).then(function (cached) {
      return cached || fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') {
          var copy = res.clone();
          caches.open(SHELL).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    })
  );
});
