import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const guard = read('../public/sw-native-guard.js');

type Listener = (event: FakeEvent) => void;

class FakeEvent {
    stopped = false;
    waits: Promise<unknown>[] = [];
    stopImmediatePropagation() { this.stopped = true; }
    waitUntil(promise: Promise<unknown>) { this.waits.push(promise); }
}

/** Runs the guard in a stand-in service worker scope and reports what it did. */
function runGuard(hostname: string) {
    const listeners = new Map<string, Listener>();
    const log: string[] = [];
    const self = {
        location: { hostname },
        addEventListener: (type: string, fn: Listener) => { listeners.set(type, fn); },
        skipWaiting: () => { log.push('skipWaiting'); },
        registration: { unregister: async () => { log.push('unregister'); return true; } },
        clients: {
            matchAll: async () => [{ url: 'https://geotime.local/', navigate: (url: string) => { log.push(`navigate ${url}`); } }],
        },
    };
    const caches = {
        keys: async () => ['workbox-precache-v2', 'maps'],
        delete: async (key: string) => { log.push(`delete ${key}`); return true; },
    };
    vm.runInNewContext(guard, { self, caches });
    return { listeners, log };
}

test('the guard names the host Capacitor serves the app from', () => {
    const configured = /hostname:\s*'([^']+)'/.exec(read('../capacitor.config.ts'))?.[1];
    const guarded = /hostname !== '([^']+)'/.exec(guard)?.[1];
    assert.ok(configured, 'server.hostname not found in capacitor.config.ts');
    assert.equal(guarded, configured);
});

test('the generated worker imports the guard, and nothing injects a registration', () => {
    const config = read('../vite.config.js');
    assert.match(config, /importScripts:\s*\['sw-native-guard\.js'\]/);
    assert.match(config, /injectRegister:\s*null/);
});

test('on the web the guard leaves Workbox alone', () => {
    const { listeners, log } = runGuard('geotime.app');
    assert.equal(listeners.size, 0);
    assert.deepEqual(log, []);
});

test('in the app the worker caches nothing and serves nothing', () => {
    const { listeners, log } = runGuard('geotime.local');
    const install = new FakeEvent();
    listeners.get('install')!(install);
    assert.ok(install.stopped, 'Workbox would precache the bundle');
    assert.deepEqual(log, ['skipWaiting']);

    const fetch = new FakeEvent();
    listeners.get('fetch')!(fetch);
    assert.ok(fetch.stopped, 'Workbox would answer from its cache');
});

test('in the app the worker clears every cache and unregisters, and never reloads the page', async () => {
    const { listeners, log } = runGuard('geotime.local');
    const activate = new FakeEvent();
    listeners.get('activate')!(activate);
    assert.ok(activate.stopped);
    await Promise.all(activate.waits);
    // No navigate: an in-place reload crashes the Android app (see the guard).
    assert.deepEqual(log, [
        'delete workbox-precache-v2',
        'delete maps',
        'unregister',
    ]);
});
