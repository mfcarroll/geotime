import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HEARTBEAT_MS,
    STALE_AFTER_MS,
    anchorFrom,
    anchorIsStale,
    anchorSubLabel,
    sameAnchor,
    shouldPush,
    validateAnchor,
    type Anchor,
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

const NOW = 1_788_800_000_000;
const wonder = { name: 'Wonder of the Seas', short: 'Wonder', offsetHours: -4 };
const ashore: Anchor = { kind: 'zone', tz: 'America/Vancouver', place: 'Nelson' };

test('what this device says its anchor is', async (t) => {
    await t.test('the ship, when aboard one whose clock is known', () => {
        assert.deepEqual(anchorFrom(wonder, 'America/New_York', 'Miami'), {
            kind: 'ship',
            offsetMinutes: -240,
            name: 'Wonder of the Seas',
            short: 'Wonder',
        });
    });

    await t.test('the ground, when the ship has no clock yet', () => {
        // Aboard is not a fact you can send; an offset is. Until one resolves
        // there is nothing to say about the ship, so the ground is the answer.
        assert.deepEqual(anchorFrom({ ...wonder, offsetHours: null }, 'America/Vancouver', 'Nelson'),
                         ashore);
    });

    await t.test('the ground, when not aboard anything', () => {
        assert.deepEqual(anchorFrom(null, 'America/Vancouver', 'Nelson'), ashore);
    });

    await t.test('nothing, when the device does not know its own zone', () => {
        // Sending UTC and letting somebody read it would be worse than silence.
        assert.equal(anchorFrom(null, null, 'Nelson'), null);
    });

    await t.test('carries no place when there is no place to carry', () => {
        assert.deepEqual(anchorFrom(null, 'America/Vancouver', null),
                         { kind: 'zone', tz: 'America/Vancouver' });
    });

    await t.test('omits a short name that is the name', () => {
        const anchor = anchorFrom({ name: 'Icon', short: 'Icon', offsetHours: 0 }, null, null);
        assert.equal('short' in anchor!, false);
    });

    await t.test('rounds a half-hour ship clock to whole minutes', () => {
        const anchor = anchorFrom({ ...wonder, offsetHours: 5.75 }, null, null);
        assert.deepEqual((anchor as { offsetMinutes: number }).offsetMinutes, 345);
    });
});

test('whether two anchors read the same', async (t) => {
    await t.test('same fields, same answer', () => {
        assert.equal(sameAnchor(ashore, { ...ashore }), true);
    });

    await t.test('a different town in the same zone is a change', () => {
        // It is what the far end's row says underneath, so it is a change.
        assert.equal(sameAnchor(ashore, { ...ashore, place: 'Vancouver' }), false);
    });

    await t.test('an absent place and an empty one are the same nothing', () => {
        assert.equal(sameAnchor({ kind: 'zone', tz: 'UTC' },
                                { kind: 'zone', tz: 'UTC', place: '' }), true);
    });

    await t.test('kinds never match across', () => {
        assert.equal(sameAnchor(ashore, anchorFrom(wonder, null, null)), false);
    });

    await t.test('null equals only null', () => {
        assert.equal(sameAnchor(null, null), true);
        assert.equal(sameAnchor(null, ashore), false);
    });
});

test('whether it is due', async (t) => {
    await t.test('a change is always due', () => {
        assert.equal(shouldPush({ ...ashore, place: 'Victoria' }, ashore, NOW, NOW), true);
    });

    await t.test('unchanged and recent is not', () => {
        assert.equal(shouldPush(ashore, ashore, NOW - 60_000, NOW), false);
    });

    await t.test('unchanged but past the heartbeat is', () => {
        // Nothing else resets the follower's staleness clock, so an anchor that
        // never changes has to be re-sent or somebody sitting still starts to
        // look like somebody who has gone quiet.
        assert.equal(shouldPush(ashore, ashore, NOW - HEARTBEAT_MS, NOW), true);
        assert.equal(shouldPush(ashore, ashore, NOW - HEARTBEAT_MS + 1, NOW), false);
    });

    await t.test('never sent is due', () => {
        assert.equal(shouldPush(ashore, null, null, NOW), true);
        assert.equal(shouldPush(ashore, ashore, null, NOW), true);
    });

    await t.test('nothing to send is never due', () => {
        // An anchor that has gone unknown does not retract the last one. A row
        // ageing visibly beats a row that has lost its time.
        assert.equal(shouldPush(null, ashore, NOW - 10 * HEARTBEAT_MS, NOW), false);
    });

    await t.test('the heartbeat is well inside the staleness window', () => {
        assert.ok(HEARTBEAT_MS * 2 < 24 * 60 * 60 * 1000,
                  'a missed heartbeat should not be able to strand a row as stale');
    });
});
