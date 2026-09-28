// src/service-worker.ts
//
// The web keeps its service worker; the apps get rid of theirs.
//
// On the web the worker is what makes geotime work offline and load instantly.
// In the apps the bundle is already on the device, and a worker only gets in
// the way: after a store update it can go on serving the previous version from
// its cache. See public/sw-native-guard.js, which handles the harder half —
// an install whose old worker is still serving the old bundle, so that none of
// this file ever runs.
//
// Registration used to be injected into index.html by vite-plugin-pwa, which
// cannot tell the two apart; `injectRegister: null` in vite.config.js is what
// hands it to this file.

import { Capacitor } from '@capacitor/core';

export function manageServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  if (Capacitor.isNativePlatform()) {
    void retire();
    return;
  }
  // `vite dev` has no worker to register; production builds do.
  if (!import.meta.env.PROD) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
      console.warn('[sw] registration failed', err);
    });
  });
}

async function retire(): Promise<void> {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    if (registrations.length === 0) return;
    await Promise.all(registrations.map((registration) => registration.unregister()));
    for (const key of await caches.keys()) await caches.delete(key);
    // No reload, even when a worker served this page: an in-place reload crashes
    // the Android app (see sw-native-guard.js). The next launch is from the bundle.
  } catch (err) {
    console.warn('[sw] could not retire the service worker', err);
  }
}
