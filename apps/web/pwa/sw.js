/* The app's service worker, written by hand (served as /sw.js; the Vite config stamps the
   build's version into VERSION). What it does:

   - Caches the app shell (the page every route serves, the manifest and the icons) at install,
     and the hashed build assets (/assets/*, immutable) the first time they load.
   - Never caches the API: /v1/* and /.well-known/* always go to the network (balances, orders
     and sign-in must be live, and a session must never be replayed from a cache).
   - Pages: the network first, then the cached shell (the app then shows its offline notice),
     then a small offline page.
   - A new version waits until the page asks it to take over (the app's update prompt). */
const VERSION = '__VERSION__';
const SHELL = `shell-${VERSION}`;
const ASSETS = 'assets-v1';
const SHELL_URLS = ['/app', '/manifest.webmanifest', '/icons/icon-192.png', '/favicon.svg'];

const OFFLINE_HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f1f3ee;
color:#10261f;font:16px/1.5 system-ui,sans-serif;text-align:center;padding:24px}
button{margin-top:16px;min-height:48px;padding:0 20px;border:0;border-radius:12px;
background:#10261f;color:#f6f8f3;font:inherit;font-weight:600}</style></head>
<body><div><h1>Sin conexión / Offline</h1>
<p>Revisa tu conexión y vuelve a intentar.<br>Check your connection and try again.</p>
<button onclick="location.reload()">Reintentar / Try again</button></div></body></html>`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_URLS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith('shell-') && k !== SHELL).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

const neverCached = (url) =>
  url.pathname.startsWith('/v1/') ||
  url.pathname === '/v1' ||
  url.pathname.startsWith('/.well-known/');

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || neverCached(url)) return;

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(ASSETS).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Every route serves the same shell: keep the latest copy for offline starts.
          if (res.ok && res.headers.get('content-type')?.includes('text/html')) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put('/app', copy));
          }
          return res;
        })
        .catch(async () => {
          const shell = await caches.match('/app');
          return (
            shell ??
            new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
          );
        }),
    );
    return;
  }

  // Icons, the manifest, the favicon: the cache, refreshed in the background.
  event.respondWith(
    caches.open(SHELL).then(async (cache) => {
      const hit = await cache.match(req);
      const fresh = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit ?? fresh;
    }),
  );
});
