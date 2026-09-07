import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { callNote, callPhase, clock12, clockStated, departsAt, instantOf, localDate,
         parseWall, timeWithDay, voyageYear, type PortCall } from './port-clock';

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

describe('what a call says about itself', () => {
    // Coco Cay on Harmony's 5-night: arrive 07:00, sail 17:00, Bahamas time.
    const AT_SEA = (arrive: string | null, depart: string | null): PortCall => ({
        day: 2,
        arrive,
        depart,
        arrivesAt: arrive ? Date.parse(arrive.replace(' ', 'T') + '-04:00') : null,
        departsAt: depart ? Date.parse(depart.replace(' ', 'T') + '-04:00') : null,
    });
    const COCO_CAY = AT_SEA('2026-09-06 07:00:00', '2026-09-06 17:00:00');
    // The reader is in Vancouver, so "today" is UTC-7's day, not the port's.
    const VANCOUVER = -7;
    const note = (call: PortCall, at: string, latestDeparture = false) => {
        const now = Date.parse(at);
        return callNote(call, {
            now,
            todayDate: localDate(now, VANCOUVER),
            latestDeparture,
            year: 2026,
        });
    };

    it('says when she gets there while the call is ahead', () => {
        // The half a reader looking at a future call actually wants, and the
        // half we could not say until the itinerary's arrivals were read.
        // 09:00 UTC is 02:00 in Vancouver on the 6th, two hours before the
        // 07:00 Bahamas arrival — the same day for the reader, so no weekday.
        assert.equal(note(COCO_CAY, '2026-09-06T09:00:00Z'), 'day 2 · arrives 7:00 AM');
    });

    it('names the day when the call is not today', () => {
        assert.equal(note(COCO_CAY, '2026-09-04T20:00:00Z'), 'day 2 · arrives Sun 7:00 AM');
    });

    it('switches to the departure once she is there', () => {
        // 12:00 local at the port: arrived, not yet sailed.
        assert.equal(note(COCO_CAY, '2026-09-06T16:00:00Z'), 'day 2 · departs 5:00 PM');
    });

    it('keeps the departure on the call she has just left, that day', () => {
        // 22:46 UTC is 15:46 in Vancouver on the 6th — the same day the 17:00
        // Bahamas departure falls on, and the sentence that explains the wake
        // leading away from that port.
        assert.equal(note(COCO_CAY, '2026-09-06T22:46:00Z', true), 'day 2 · departed 5:00 PM');
    });

    it('drops it again once that day is over', () => {
        assert.equal(note(COCO_CAY, '2026-09-08T20:00:00Z', true), 'day 2');
    });

    it('says nothing of the time about any earlier call', () => {
        // Reciting a departure three days astern is telling somebody what they
        // watched happen. The day number is the whole of what still matters.
        assert.equal(note(COCO_CAY, '2026-09-06T22:46:00Z'), 'day 2');
    });

    it('falls back to the departure when no arrival was stated', () => {
        // An older Worker, or the embarkation call.
        const noArrival = AT_SEA(null, '2026-09-06 17:00:00');
        assert.equal(note(noArrival, '2026-09-06T09:00:00Z'), 'day 2 · departs 5:00 PM');
    });

    it('never reads as alongside without an arrival to say so', () => {
        const noArrival = AT_SEA(null, '2026-09-06 17:00:00');
        assert.equal(callPhase(noArrival, Date.parse('2026-09-06T16:00:00Z')), 'ahead');
        assert.equal(callPhase(COCO_CAY, Date.parse('2026-09-06T16:00:00Z')), 'alongside');
    });

    it('has the final call, which nobody leaves, still say when she is due', () => {
        const home: PortCall = {
            day: 6, arrive: '2026-09-10 06:00:00', depart: null,
            arrivesAt: Date.parse('2026-09-10T06:00:00-04:00'), departsAt: null,
        };
        assert.equal(note(home, '2026-09-06T22:46:00Z'), 'day 6 · arrives Thu 6:00 AM');
    });

    it('says only the day when it knows only the day', () => {
        assert.equal(note({ day: 3, arrive: null, depart: null, arrivesAt: null, departsAt: null },
            '2026-09-06T22:46:00Z'), 'day 3');
    });
});

describe('the anchor day', () => {
    it('is the reader\'s day, not the port\'s', () => {
        // 23:30 UTC on the 6th is still the 6th in Vancouver and already the
        // 7th in London. Which one "today" means decides whether a card says
        // "7:00 AM" or "Sun 7:00 AM".
        const at = Date.parse('2026-09-06T23:30:00Z');
        assert.equal(localDate(at, -7), '2026-09-06');
        assert.equal(localDate(at, 1), '2026-09-07');
    });

    it('handles a fractional offset', () => {
        assert.equal(localDate(Date.parse('2026-09-06T18:30:00Z'), 5.75), '2026-09-07');
    });
});

describe('a date with no clock on it', () => {
    // Quantum's Cabo San Lucas is stated "06 Sep - 08 Sep": two dates and no
    // times at all. Upstream still has to emit a departure, and fills it with
    // midnight — which read at face value is a ship sailing at twelve at night.
    const scenic: PortCall = {
        day: 3,
        arrive: null,
        depart: '2026-09-08 00:00:00',
        arrivesAt: null,
        departsAt: Date.parse('2026-09-08T00:00:00-06:00'),
    };
    const note = (call: PortCall, at: string) => {
        const now = Date.parse(at);
        return callNote(call, { now, todayDate: localDate(now, -7), latestDeparture: false, year: 2026 });
    };

    it('says the day and refuses to invent the time', () => {
        assert.equal(note(scenic, '2026-09-06T20:00:00Z'), 'day 3');
    });

    it('keeps a real midnight sailing, which arrived somewhere first', () => {
        const berthed: PortCall = {
            ...scenic,
            arrive: '2026-09-07 08:00:00',
            arrivesAt: Date.parse('2026-09-07T08:00:00-06:00'),
        };
        assert.equal(clockStated(berthed), true);
        // Alongside since yesterday morning, sailing at midnight tonight.
        assert.equal(note(berthed, '2026-09-07T20:00:00Z'), 'day 3 · departs Tue 12:00 AM');
    });

    it('leaves every ordinary time alone', () => {
        assert.equal(clockStated({
            day: 2, arrive: null, depart: '2026-09-06 17:00:00',
            arrivesAt: null, departsAt: 0,
        }), true, 'an embarkation call states no arrival and a real time');
    });

    it('says nothing of a departure it was never given', () => {
        assert.equal(clockStated({
            day: 6, arrive: '2026-09-10 06:00:00', depart: null,
            arrivesAt: 0, departsAt: null,
        }), false);
    });
});
