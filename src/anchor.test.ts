import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HEARTBEAT_MS,
    anchorAsSeen,
    zoneOffsetMinutes,
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
    await t.test('is a zone id and nothing else', () => {
        assert.deepEqual(validateAnchor({ kind: 'zone', tz: 'Europe/London' }),
                         { kind: 'zone', tz: 'Europe/London' });
    });

    await t.test('drops a town, wherever one came from', () => {
        // THE safeguard, and the reason validateAnchor rebuilds rather than
        // spreads. 2.0.0-alpha sent a `place` for a while; a build still doing
        // it, or anything else pointed at the relay, gets it dropped here — on
        // the way in at the server AND on the way out at every reader, because
        // both ends run this same function on this same file.
        //
        // A zone is thousands of kilometres wide and that width is the whole
        // privacy story. A town is not, so a town does not travel.
        const anchor = validateAnchor({ kind: 'zone', tz: 'Europe/London', place: 'Birmingham' });
        assert.deepEqual(Object.keys(anchor!), ['kind', 'tz']);
        assert.equal((anchor as unknown as Record<string, unknown>).place, undefined);
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
        assert.deepEqual(anchor, { kind: 'zone', tz: 'America/Vancouver' });
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

    await t.test('no anchor of any kind carries anything that narrows a zone', () => {
        // Belt and braces over the case above, and deliberately a rule about
        // the SHAPE rather than about known field names: a future field that
        // says where somebody is has to fail this without anybody remembering
        // to come back and add a case for it.
        const built = [
            validateAnchor({ kind: 'zone', tz: 'Europe/London', place: 'Birmingham',
                             city: 'Birmingham', town: 'Birmingham', region: 'West Midlands',
                             country: 'UK', postcode: 'B1', lat: 52.5, lon: -1.9 }),
            validateAnchor({ kind: 'ship', offsetMinutes: 60, name: 'Anthem of the Seas',
                             port: 'Southampton', lat: 50.9, lon: -1.4 }),
        ];
        const allowed = new Set(['kind', 'tz', 'offsetMinutes', 'name', 'short']);
        for (const anchor of built) {
            for (const key of Object.keys(anchor!)) {
                assert.ok(allowed.has(key), `an anchor came back carrying "${key}"`);
            }
        }
    });

    await t.test('a name long enough to break a row is refused, not truncated', () => {
        const long = 'x'.repeat(61);
        assert.equal(validateAnchor({ kind: 'ship', offsetMinutes: 0, name: long }), null);

        // A name IS the ship, so an unusable one sinks her anchor. A zone
        // anchor has nothing but its zone, so nothing about a long string
        // attached to it can sink anything.
        const ashore = validateAnchor({ kind: 'zone', tz: 'Europe/London', place: long });
        assert.deepEqual(ashore, { kind: 'zone', tz: 'Europe/London' });
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
    await t.test('ashore, the zone, because the zone is all there is', () => {
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
const ashore: Anchor = { kind: 'zone', tz: 'America/Vancouver' };

test('what this device says its anchor is', async (t) => {
    await t.test('the ship, when aboard one whose clock is known', () => {
        assert.deepEqual(anchorFrom(wonder, 'America/New_York'), {
            kind: 'ship',
            offsetMinutes: -240,
            name: 'Wonder of the Seas',
            short: 'Wonder',
        });
    });

    await t.test('the ground, when the ship has no clock yet', () => {
        // Aboard is not a fact you can send; an offset is. Until one resolves
        // there is nothing to say about the ship, so the ground is the answer.
        assert.deepEqual(anchorFrom({ ...wonder, offsetHours: null }, 'America/Vancouver'),
                         ashore);
    });

    await t.test('the ground, when not aboard anything', () => {
        assert.deepEqual(anchorFrom(null, 'America/Vancouver'), ashore);
    });

    await t.test('nothing, when the device does not know its own zone', () => {
        // Sending UTC and letting somebody read it would be worse than silence.
        assert.equal(anchorFrom(null, null), null);
    });

    await t.test('ashore, carries the zone and nothing else, ever', () => {
        // There is no third argument. The device knows its nearest town and
        // this function has nowhere to put it, which is the compile-time half
        // of the safeguard validateAnchor is the runtime half of.
        assert.deepEqual(anchorFrom(null, 'America/Vancouver'),
                         { kind: 'zone', tz: 'America/Vancouver' });
    });

    await t.test('omits a short name that is the name', () => {
        const anchor = anchorFrom({ name: 'Icon', short: 'Icon', offsetHours: 0 }, null);
        assert.equal('short' in anchor!, false);
    });

    await t.test('rounds a half-hour ship clock to whole minutes', () => {
        const anchor = anchorFrom({ ...wonder, offsetHours: 5.75 }, null);
        assert.deepEqual((anchor as { offsetMinutes: number }).offsetMinutes, 345);
    });
});

test('whether two anchors read the same', async (t) => {
    await t.test('same fields, same answer', () => {
        assert.equal(sameAnchor(ashore, { ...ashore }), true);
    });

    await t.test('a different zone is a change', () => {
        assert.equal(sameAnchor(ashore, { kind: 'zone', tz: 'America/Toronto' }), false);
    });

    await t.test('kinds never match across', () => {
        assert.equal(sameAnchor(ashore, anchorFrom(wonder, null)), false);
    });

    await t.test('null equals only null', () => {
        assert.equal(sameAnchor(null, null), true);
        assert.equal(sameAnchor(null, ashore), false);
    });
});

test('whether it is due', async (t) => {
    await t.test('a change is always due', () => {
        // Crossing a border, which for this feature is the only kind of change
        // there is ashore: moving town within a zone changes nothing anybody
        // can see, because nothing about the town is sent.
        assert.equal(shouldPush({ kind: 'zone', tz: 'America/Toronto' }, ashore, NOW, NOW), true);
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

test('a zone, as far from UTC as it is right now', async (t) => {
    await t.test('whole hours, half hours and the far edges', () => {
        assert.equal(zoneOffsetMinutes('Europe/London', new Date('2026-09-08T12:00:00Z')), 60);
        assert.equal(zoneOffsetMinutes('Asia/Kolkata', new Date('2026-09-08T12:00:00Z')), 330);
        assert.equal(zoneOffsetMinutes('Pacific/Marquesas', new Date('2026-09-08T12:00:00Z')), -570);
        assert.equal(zoneOffsetMinutes('Pacific/Kiritimati', new Date('2026-09-08T12:00:00Z')), 840);
    });

    await t.test('UTC is zero, not unparseable', () => {
        // Intl says plain "GMT" there rather than "GMT+0", which a stricter
        // pattern reads as a failure.
        assert.equal(zoneOffsetMinutes('UTC', new Date('2026-09-08T12:00:00Z')), 0);
    });

    await t.test('follows daylight saving, which is the whole reason it exists', () => {
        const summer = new Date('2026-09-08T12:00:00Z');
        const winter = new Date('2026-11-15T12:00:00Z');
        assert.equal(zoneOffsetMinutes('America/Vancouver', summer), -420);
        assert.equal(zoneOffsetMinutes('America/Vancouver', winter), -480);
    });

    await t.test('a zone nobody can resolve is null, not zero', () => {
        assert.equal(zoneOffsetMinutes('America/Atlantis'), null);
    });
});

test('what a follower is allowed to see', async (t) => {
    const vancouver: Anchor = { kind: 'zone', tz: 'America/Vancouver' };
    const wonder: Anchor = {
        kind: 'ship', offsetMinutes: -240, name: 'Wonder of the Seas', short: 'Wonder',
    };

    await t.test('with the switch on, exactly what was stored', () => {
        assert.deepEqual(anchorAsSeen(vancouver, true), vancouver);
        assert.deepEqual(anchorAsSeen(wonder, true), wonder);
    });

    await t.test('with it off, a zone becomes a number and loses its id', () => {
        const seen = anchorAsSeen(vancouver, false);
        assert.deepEqual(Object.keys(seen!), ['kind', 'offsetMinutes']);
        assert.equal(seen!.kind, 'offset');
    });

    await t.test('with it off, a SHIP loses her name too', () => {
        // A vessel is a more specific fact about somebody than a timezone is,
        // so "only my offset" has to mean it. This is the case a display-only
        // toggle would have missed entirely.
        assert.deepEqual(anchorAsSeen(wonder, false), { kind: 'offset', offsetMinutes: -240 });
    });

    await t.test('the number it produces is the zone offset, freshly worked out', () => {
        const seen = anchorAsSeen(vancouver, false) as { offsetMinutes: number };
        assert.equal(seen.offsetMinutes, zoneOffsetMinutes('America/Vancouver'));
    });

    await t.test('nothing about where survives being hidden, at any depth', () => {
        // The rule as a shape rather than a field list, so a zone id smuggled
        // into some later field fails this without anybody remembering to add
        // a case for it.
        const hidden = JSON.stringify(anchorAsSeen(vancouver, false));
        assert.doesNotMatch(hidden, /Vancouver|America/i);
        assert.doesNotMatch(JSON.stringify(anchorAsSeen(wonder, false)), /Wonder|Seas/i);
    });

    await t.test('an unresolvable zone is dropped rather than guessed at', () => {
        // Better a follower who sees nothing than one confidently shown
        // Greenwich. validateAnchor would not have let this through, so this is
        // the second line of defence.
        assert.equal(anchorAsSeen({ kind: 'zone', tz: 'America/Atlantis' }, false), null);
    });

    await t.test('nothing is still nothing', () => {
        assert.equal(anchorAsSeen(null, true), null);
        assert.equal(anchorAsSeen(null, false), null);
    });
});
