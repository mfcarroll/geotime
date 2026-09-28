import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanDisplayName } from './anchor';
import { migrateFollowedPeople } from './people';
import { migrateStoredTimezones } from './stored-zones';

// The seed is compiled out unless the build defines this; the test defines it.
(globalThis as Record<string, unknown>).__SCREENSHOT_SEED__ = true;

function fakeStorage(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial));
    return {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value); },
        store,
    };
}

async function seed(initial?: Record<string, string>) {
    const storage = fakeStorage(initial);
    (globalThis as Record<string, unknown>).localStorage = storage;
    const { seedForScreenshots } = await import('./screenshot-seed');
    seedForScreenshots();
    return storage.store;
}

test('every seeded person survives the validation the app runs at launch', async () => {
    const store = await seed();
    const raw = JSON.parse(store.get('followedPeople')!);
    const people = migrateFollowedPeople(raw);
    assert.equal(people.length, raw.length, 'a seeded person was dropped — the screenshot would be missing a row');
    assert.deepEqual(people.map((p) => p.anchor?.kind), ['offset', 'ship']);
    for (const person of people) assert.ok(person.updatedAt, `${person.name} would show no age`);
});

test('every seeded city survives the same', async () => {
    const store = await seed();
    const raw = JSON.parse(store.get('worldClocks')!);
    assert.equal(migrateStoredTimezones(raw).length, raw.length);
});

test('the sharing card has a name to show, and it is one the app would accept', async () => {
    const store = await seed();
    const name = store.get('shareName')!;
    assert.ok(name);
    assert.equal(cleanDisplayName(name), name);
});

test('a list someone already has is never overwritten', async () => {
    const mine = JSON.stringify([{ shareId: 'real', name: 'Sam', anchor: null, updatedAt: null }]);
    const store = await seed({ followedPeople: mine });
    assert.equal(store.get('followedPeople'), mine);
});
