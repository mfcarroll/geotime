import test from 'node:test';
import assert from 'node:assert/strict';

import {
    STALE_AFTER_MS,
    anchorIsStale,
    anchorSubLabel,
    validateAnchor,
} from './anchor';

test('an anchor ashore', async (t) => {
    await t.test('is a zone id and the town, if the device knows one', () => {
        assert.deepEqual(
            validateAnchor({ kind: 'zone', tz: 'America/Vancouver', place: 'Nelson' }),
            { kind: 'zone', tz: 'America/Vancouver', place: 'Nelson' });
    });

    await t.test('is a zone id alone where it does not', () => {
        assert.deepEqual(validateAnchor({ kind: 'zone', tz: 'Europe/London' }),
                         { kind: 'zone', tz: 'Europe/London' });
    });

    await t.test('is refused when the zone is one nobody can resolve', () => {
        // Asked of Intl, not of a pattern: the question is whether the device
        // reading this can turn it into a time.
        assert.equal(validateAnchor({ kind: 'zone', tz: 'America/Atlantis' }), null);
        assert.equal(validateAnchor({ kind: 'zone', tz: '' }), null);
        assert.equal(validateAnchor({ kind: 'zone' }), null);
    });
});

test('an anchor aboard', async (t) => {
    await t.test('is an offset and a name, because no zone exists to name', () => {
        assert.deepEqual(
            validateAnchor({ kind: 'ship', offsetMinutes: -240, name: 'Wonder of the Seas',
                             short: 'Wonder' }),
            { kind: 'ship', offsetMinutes: -240, name: 'Wonder of the Seas', short: 'Wonder' });
    });

    await t.test('drops a short name that only repeats the full one', () => {
        const anchor = validateAnchor(
            { kind: 'ship', offsetMinutes: 0, name: 'Anthem', short: 'Anthem' });
        assert.deepEqual(anchor, { kind: 'ship', offsetMinutes: 0, name: 'Anthem' });
    });

    await t.test('holds the real range of offsets, which is not symmetric', () => {
        // Kiribati is +14, Baker Island -12. Nothing lies outside that.
        assert.ok(validateAnchor({ kind: 'ship', offsetMinutes: 14 * 60, name: 'A' }));
        assert.ok(validateAnchor({ kind: 'ship', offsetMinutes: -12 * 60, name: 'A' }));
        assert.equal(validateAnchor({ kind: 'ship', offsetMinutes: 14 * 60 + 1, name: 'A' }), null);
        assert.equal(validateAnchor({ kind: 'ship', offsetMinutes: -12 * 60 - 1, name: 'A' }), null);
    });

    await t.test('refuses an offset that is not a whole number of minutes', () => {
        assert.equal(validateAnchor({ kind: 'ship', offsetMinutes: 90.5, name: 'A' }), null);
        assert.equal(validateAnchor({ kind: 'ship', offsetMinutes: NaN, name: 'A' }), null);
        assert.equal(validateAnchor({ kind: 'ship', offsetMinutes: -240, name: '  ' }), null);
    });
});

test('what a hostile sender cannot smuggle through', async (t) => {
    await t.test('nothing but the named fields survives', () => {
        // Rebuilt field by field, not spread. This arrives from a device that is
        // not ours and ends up in a database and on someone else's home screen.
        const anchor = validateAnchor({
            kind: 'zone', tz: 'America/Vancouver', place: 'Nelson',
            lat: 49.49, lon: -117.29, evil: '<script>', __proto__: { polluted: true },
        });
        assert.deepEqual(anchor, { kind: 'zone', tz: 'America/Vancouver', place: 'Nelson' });
        // Through `unknown`, because the point is that the property is not on
        // the type — which is the type system agreeing with the test.
        assert.equal((anchor as unknown as Record<string, unknown>).lat, undefined);
    });

    await t.test('there is nowhere to put a position, which is the point', () => {
        // The line between this feature and location sharing is drawn in the
        // type, not in a policy document.
        const anchor = validateAnchor({ kind: 'zone', tz: 'Europe/London', lat: 51.5, lon: -0.1 });
        assert.deepEqual(Object.keys(anchor!), ['kind', 'tz']);
    });

    await t.test('a name long enough to break a row is refused, not truncated', () => {
        const long = 'x'.repeat(61);
        assert.equal(validateAnchor({ kind: 'ship', offsetMinutes: 0, name: long }), null);

        // A name IS the ship, so an unusable one sinks the anchor. A place is a
        // nicety on top of a zone, so the anchor stands and the place is left off.
        const ashore = validateAnchor({ kind: 'zone', tz: 'Europe/London', place: long });
        assert.ok(ashore && ashore.kind === 'zone');
        assert.equal(ashore.place, undefined);
    });

    await t.test('junk of every shape is simply not an anchor', () => {
        for (const junk of [null, undefined, 42, 'zone', [], {}, { kind: 'person' }]) {
            assert.equal(validateAnchor(junk), null, `${JSON.stringify(junk)}`);
        }
    });
});

test('how old an answer is', async (t) => {
    const now = 1_788_800_000_000;

    await t.test('fresh under a day', () => {
        assert.equal(anchorIsStale(now - 1000, now), false);
        assert.equal(anchorIsStale(now - (STALE_AFTER_MS - 1), now), false);
    });

    await t.test('stale at a day', () => {
        assert.equal(anchorIsStale(now - STALE_AFTER_MS, now), true);
        assert.equal(anchorIsStale(now - 30 * STALE_AFTER_MS, now), true);
    });

    await t.test('a stamp that is no stamp at all counts as stale', () => {
        assert.equal(anchorIsStale(NaN, now), true);
    });
});

test('the line underneath the name', async (t) => {
    // The person's own name belongs to whoever follows them; this is the line
    // that says where they are.
    await t.test('ashore, the town — or the zone where there is no town', () => {
        assert.equal(anchorSubLabel({ kind: 'zone', tz: 'America/Vancouver', place: 'Nelson' }),
                     'Nelson');
        assert.equal(anchorSubLabel({ kind: 'zone', tz: 'America/Vancouver' }),
                     'America/Vancouver');
    });

    await t.test('aboard, the ship — short enough for a row', () => {
        assert.equal(
            anchorSubLabel({ kind: 'ship', offsetMinutes: -240, name: 'Wonder of the Seas',
                             short: 'Wonder' }),
            'Wonder');
        assert.equal(anchorSubLabel({ kind: 'ship', offsetMinutes: -240, name: 'Anthem' }),
                     'Anthem');
    });
});
