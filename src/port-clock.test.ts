import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { clock12, departsAt, instantOf, parseWall, voyageYear } from './port-clock';

// These run in whatever zone the machine is set to, and that is the point: the
// bug being guarded against was invisible on a machine in the same zone as the
// port and three hours wide on one in Vancouver. Every assertion below is
// therefore stated as an absolute instant, never as a local wall clock.

describe('parsing what upstream states', () => {
    it('reads a port departure', () => {
        assert.deepEqual(parseWall('2026-09-06 17:00:00'),
            { year: 2026, month: 9, day: 6, hour: 17, minute: 0 });
    });

    it('reads an ETA, which carries no year', () => {
        assert.deepEqual(parseWall('September 8, 18:30'),
            { year: null, month: 9, day: 8, hour: 18, minute: 30 });
    });

    it('refuses a shape it has not seen rather than guessing', () => {
        assert.equal(parseWall('sometime last Tuesday'), null);
        assert.equal(parseWall('Septober 8, 18:30'), null);
        assert.equal(parseWall(''), null);
        assert.equal(parseWall(null), null);
    });
});

describe('the instant a stated time refers to', () => {
    // Harmony of the Seas, 6 September 2026: Coco Cay departure 17:00, stated in
    // the Bahamas, which keeps UTC-4 in September. That is 21:00 UTC — and at
    // 22:46 UTC she was forty kilometres past it making nineteen knots.
    const COCO_CAY = '2026-09-06 17:00:00';
    const TRUE_DEPARTURE = Date.parse('2026-09-06T21:00:00Z');

    it('resolves a wall clock in the zone it was stated in', () => {
        assert.equal(departsAt(COCO_CAY, -4, 2026), TRUE_DEPARTURE);
    });

    it('has her gone by the time she is gone', () => {
        const at = Date.parse('2026-09-06T22:46:00Z');
        assert.ok(departsAt(COCO_CAY, -4, 2026)! < at, 'departed');

        // What the device's own zone produced instead, and what it drew: from
        // Vancouver the same string read 00:00 UTC on the 7th — an hour and a
        // half in the FUTURE — so every "has she left?" test said no and the
        // route ahead ran backwards to the port she had just sailed from.
        assert.ok(departsAt(COCO_CAY, -7, 2026)! > at, 'the fault, stated');
        assert.equal(departsAt(COCO_CAY, -7, 2026)! - TRUE_DEPARTURE, 3 * 3600_000);
    });

    it('borrows the voyage year for a time that omits one', () => {
        assert.equal(instantOf(parseWall('September 8, 18:30')!, -8, 2026),
            Date.parse('2026-09-09T02:30:00Z'));
    });

    it('says null where the itinerary says nothing', () => {
        // The last call of every cruise: nobody leaves again, so there is no
        // departure to state. Null must not read as "left long ago".
        assert.equal(departsAt(null, -4, 2026), null);
        assert.equal(departsAt('sometime last Tuesday', -4, 2026), null);
    });

    it('handles a zone at a half-hour offset', () => {
        assert.equal(departsAt('2026-09-06 17:00:00', 5.5, 2026),
            Date.parse('2026-09-06T11:30:00Z'));
    });
});

describe('the year an ETA leaves out', () => {
    it('comes from the voyage it belongs to', () => {
        assert.equal(voyageYear('05 Sep, 2026', '10 Sep, 2026'), 2026);
        assert.equal(voyageYear(null, '10 Sep, 2027'), 2027);
    });

    it('falls back to this one when the voyage is undated', () => {
        assert.equal(voyageYear(null, null), new Date().getFullYear());
    });
});

describe('twelve-hour display', () => {
    it('names noon and midnight correctly', () => {
        assert.equal(clock12({ year: null, month: 9, day: 6, hour: 12, minute: 0 }), '12:00 PM');
        assert.equal(clock12({ year: null, month: 9, day: 6, hour: 0, minute: 5 }), '12:05 AM');
    });

    it('pads the minutes', () => {
        assert.equal(clock12({ year: null, month: 9, day: 6, hour: 17, minute: 0 }), '5:00 PM');
    });
});
