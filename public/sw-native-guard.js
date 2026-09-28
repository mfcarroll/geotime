// public/sw-native-guard.js
//
// Imported at the top of the generated service worker (see `importScripts` in
// vite.config.js), so these listeners are registered before Workbox's and can
// stop them from running.
//
// ON THE WEB THIS DOES NOTHING. In the native apps it retires the worker.
//
// A service worker in the app is worse than none. The bundle is already on the
// device, so there is nothing for it to make faster or offline — and what it
// does do is serve the *previous* version's bundle from its cache after the
// store installs a new one, until it notices and updates itself. An update can
// land and run old code for a whole session. That happened twice on the Android
// emulator while building 2.0, and only clearing the app's data fixed it.
//
// The page no longer registers one in the app (src/service-worker.ts), but that
// alone cannot help an install that already has one: every 1.7.0 install does,
// and its first launch after the update is served by the 1.7.0 worker, so none
// of 2.0's page code ever runs. The one new file that old worker does fetch is
// /sw.js, when it checks itself for an update — which is how this arrives.
// On the app's host it caches nothing, serves nothing, deletes every cache and
// unregisters. From the next launch on, the page comes from the bundle.
//
// IT DOES NOT RELOAD THE PAGE, deliberately. The session it arrives in carries on
// with the old bundle it was already running; reloading would fix that, but an
// in-place reload of the Android app crashes it — the WebView runs out of JS heap
// inside Google Maps about ten seconds later, in 1.7.0 as much as 2.0. Measured on
// the emulator: reloading turned "one stale session" into "a crash on the first
// launch after updating", for every user upgrading. One stale session it is.
//
// The host is `server.hostname` in capacitor.config.ts, on both platforms.
// src/service-worker.test.ts fails if the two ever disagree.
(() => {
  if (self.location.hostname !== 'geotime.local') return;

  const stop = (event) => event.stopImmediatePropagation();

  self.addEventListener('install', (event) => {
    stop(event);            // Workbox would precache the whole bundle here
    self.skipWaiting();
  });

  // No respondWith: the request goes where it would with no worker at all.
  self.addEventListener('fetch', stop);

  self.addEventListener('activate', (event) => {
    stop(event);
    event.waitUntil((async () => {
      for (const key of await caches.keys()) await caches.delete(key);
      await self.registration.unregister();
    })());
  });
})();
