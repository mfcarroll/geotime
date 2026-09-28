/**
 * geotime.app: the web app, and the links that open the native one.
 *
 * The site is the Vite build, served as static assets. This script decides the
 * handful of requests that are not simply "the file at that path":
 *
 *   www.geotime.app/…          → 301 to geotime.app/…
 *   /f/<code>, /.well-known/…  → the gateway, which owns follow links and the
 *                                 App Links / Universal Links files, so that a
 *                                 link can read geotime.app/f/… and still open
 *                                 the app rather than the website
 *   /import                    → the landing half of the move from the old
 *                                 domain; see importPage
 *   geotime.matthewcarroll.ca  → the old domain; see legacy
 *
 * Everything else is ASSETS.
 */

interface Env {
  ASSETS: Fetcher;
  GATEWAY: Fetcher;
}

const APEX = 'geotime.app';
const LEGACY = 'geotime.matthewcarroll.ca';

/** What the old domain kept in localStorage, and so what is worth carrying over. */
const CARRIED_KEYS = ['worldClocks', 'shipClocks', 'localPlaceName', 'aboardShipKey'];

const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // These pages exist to run one inline script and leave.
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  });

/**
 * geotime.app/import — writes what the old domain handed over, then goes home.
 *
 * localStorage belongs to an origin, so a move of domain would silently empty
 * everybody's saved cities. The old domain's page reads its own and sends them
 * here in the fragment, which never reaches a server log; this page puts them
 * into this origin's storage.
 *
 * Two guards, because anybody can link to this page. It writes only keys that
 * are still empty, so it can never overwrite what somebody already has here.
 * And only when the visitor has just come from the old domain, so a crafted
 * link cannot seed a stranger's clock list. What it writes is then validated by
 * the app on load like anything else in storage (migrateStoredTimezones).
 */
function importPage(): Response {
  return html(`<!doctype html><meta charset="utf-8"><title>GeoTime</title>
<script>
(() => {
  try {
    if (document.referrer.startsWith('https://${LEGACY}/')) {
      const data = JSON.parse(decodeURIComponent(location.hash.slice(1)) || '{}');
      for (const key of ${JSON.stringify(CARRIED_KEYS)}) {
        const value = data[key];
        if (typeof value === 'string' && value.length < 100000 && localStorage.getItem(key) === null) {
          localStorage.setItem(key, value);
        }
      }
    }
  } catch (e) { /* nothing worth carrying, or storage refused: start fresh */ }
  location.replace('/');
})();
</script>`);
}

/**
 * The old domain's page: carries its storage across, then leaves.
 *
 * Served for navigations rather than a bare 301, because a 301 cannot take
 * localStorage with it. It also unregisters the old site's service worker and
 * deletes its caches: left alone, that worker would go on serving the old site
 * from its cache on every visit and nobody would ever reach this page.
 */
function legacyPage(): Response {
  return html(`<!doctype html><meta charset="utf-8"><title>GeoTime has moved</title>
<p style="font:16px system-ui;color:#9ca3af;background:#111827;margin:0;padding:2rem">GeoTime has moved to <a style="color:#60a5fa" href="https://${APEX}/">${APEX}</a>…</p>
<script>
(async () => {
  const carried = {};
  try {
    for (const key of ${JSON.stringify(CARRIED_KEYS)}) {
      const value = localStorage.getItem(key);
      if (value !== null) carried[key] = value;
    }
  } catch (e) {}
  try {
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    for (const k of await caches.keys()) await caches.delete(k);
  } catch (e) {}
  location.replace(Object.keys(carried).length
    ? 'https://${APEX}/import#' + encodeURIComponent(JSON.stringify(carried))
    : 'https://${APEX}/' + location.search);
})();
</script>`);
}

/**
 * The old domain's /sw.js: a worker whose only job is to remove itself.
 *
 * A browser that installed the old site checks this file for updates, and it
 * is the one request such a browser still makes to the network — its pages
 * come from the old worker's cache. It cannot be a redirect: browsers refuse
 * to update a service worker from one. So it is a script that clears the
 * caches, unregisters, and reloads its pages, which then reach legacyPage and
 * move over like anyone else's.
 */
const SELF_REMOVING_WORKER = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url);
  })());
});
`;

function legacy(request: Request, url: URL): Response {
  if (url.pathname === '/sw.js') {
    return new Response(SELF_REMOVING_WORKER, {
      headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  // A page someone is opening gets the page that carries their storage over.
  // Anything else — the privacy policy linked from a store listing, an icon —
  // goes straight to the same path on the new domain.
  const navigation = request.method === 'GET'
    && (url.pathname === '/' || url.pathname === '/index.html')
    && (request.headers.get('Accept') ?? '').includes('text/html');
  if (navigation) return legacyPage();
  return Response.redirect(`https://${APEX}${url.pathname}${url.search}`, 301);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.hostname === LEGACY) return legacy(request, url);
    if (url.hostname !== APEX) {
      return Response.redirect(`https://${APEX}${url.pathname}${url.search}`, 301);
    }

    if (url.pathname.startsWith('/.well-known/') || url.pathname.startsWith('/f/')) {
      return env.GATEWAY.fetch(request);
    }
    if (url.pathname === '/import') return importPage();

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
