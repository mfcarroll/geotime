import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { wakeGaps, wakeRuns, type WakePort } from './wake';

// Real coordinates throughout, because what this guards against was only ever
// visible in real data: a wake drawn confidently through places the ship had
// never been. Synthetic points a degree apart would prove the arithmetic and
// none of the judgement in the rule.

const NOW = Date.parse('2026-09-07T12:00:00');
const AGO = '2026-09-02 17:00:00';       // departed
const SOON = '2026-09-08 11:59:00';      // still ahead

/** Star of the Seas: where her held wake stopped, inbound to Cozumel on day 4. */
const OFF_COZUMEL: [number, number] = [-86.40427, 20.96229];
/** And where she actually was on day 8 — alongside, 1,014 km away. */
const PORT_CANAVERAL: [number, number] = [-80.61014, 28.40875];
const COZUMEL: WakePort = { lon: -86.94, lat: 20.51, depart: AGO };

/** A plausible afternoon's crumbs off the Florida coast, ~30 km apart. */
const CONTINUOUS: Array<[number, number]> = [
    [-80.10, 28.20], [-80.40, 27.90], [-80.75, 27.60],
    [-81.05, 27.30], [-81.35, 27.00], [-81.65, 26.70],
];

describe('wake gaps', () => {
    it('finds none in a wake that reaches every port it has left', () => {
        const port: WakePort = { lon: -80.75, lat: 27.60, depart: AGO };
        assert.equal(wakeGaps(CONTINUOUS, [port], NOW).size, 0);
    });

    /**
     * The case that started this: the held track ended inbound to Cozumel on day
     * four while she was alongside at Port Canaveral on day eight, and the
     * closing join drew a straight line between them — 240 km of it over land.
     */
    it('marks the hop a departed port fell into', () => {
        const wake: Array<[number, number]> = [
            [-86.14673, 21.15979], [-86.23083, 21.07788], OFF_COZUMEL, PORT_CANAVERAL,
        ];
        const gaps = wakeGaps(wake, [COZUMEL], NOW);
        assert.deepEqual([...gaps], [2], 'the long closing hop, not a short one before it');
    });

    it('leaves a port she has not sailed from yet alone', () => {
        // Radiance's Tampa, the last call of her itinerary: no departure time
        // because she has not left, so nothing about it is missing.
        const wake = [...CONTINUOUS, [-70.0, 22.0] as [number, number]];  // a 1,200 km hop
        const ahead: WakePort = { lon: -82.45, lat: 27.94, depart: null };
        // Only the backstop fires; the port contributes nothing.
        assert.deepEqual([...wakeGaps(wake, [ahead], NOW)], [5]);
        assert.equal(wakeGaps(CONTINUOUS, [ahead], NOW).size, 0);
    });

    it('leaves a port whose departure is still in the future alone', () => {
        // Vision's Kings Wharf, departing tomorrow.
        const soon: WakePort = { lon: -64.83, lat: 32.32, depart: SOON };
        assert.equal(wakeGaps(CONTINUOUS, [soon], NOW).size, 0);
    });

    it('does not dot an ordinary hop just because a port sits off it', () => {
        // The first draft did exactly this, pinning a missed port to whichever
        // hop lay nearest and dotting stretches of 3, 8 and 12 km. A port 40 km
        // off an unbroken wake is a tender berth or a rough coordinate, not a
        // hole in the line.
        const nearby: WakePort = { lon: -80.75, lat: 27.25, depart: AGO };
        assert.equal(wakeGaps(CONTINUOUS, [nearby], NOW).size, 0);
    });

    it('dots a very long hop even with no itinerary at all', () => {
        // The backstop. A straight line is a fair sketch of a passage at 200 km
        // and a fiction at 2,000.
        const wake: Array<[number, number]> = [OFF_COZUMEL, PORT_CANAVERAL];
        assert.deepEqual([...wakeGaps(wake, [], NOW)], [0]);
    });

    it('does not dot a middling hop with no port missed', () => {
        // Allure of the Seas, 184 km on day 3, over open water, skipping nothing.
        const wake: Array<[number, number]> = [[-77.0, 25.0], [-78.5, 24.0]];
        assert.equal(wakeGaps(wake, [], NOW).size, 0);
    });

    it('gives a tie to the longer hop', () => {
        // Adjacent hops share an endpoint, so a port beyond the end of the track
        // is exactly equidistant from the last real hop and the long one closing
        // to the ship. The ship crossed the long one.
        const wake: Array<[number, number]> = [
            [-86.0, 21.4], [-86.2, 21.2], OFF_COZUMEL, PORT_CANAVERAL,
        ];
        const beyond: WakePort = { lon: -84.0, lat: 24.5, depart: AGO };
        const gaps = wakeGaps(wake, [beyond], NOW);
        assert.ok(gaps.has(2), 'the 1,014 km hop, not the 30 km one that shares its start');
    });

    it('ignores a departure string it cannot read', () => {
        const bad: WakePort = { lon: -86.94, lat: 20.51, depart: 'sometime last Tuesday' };
        assert.equal(wakeGaps(CONTINUOUS, [bad], NOW).size, 0);
    });

    it('has nothing to say about a wake of fewer than two points', () => {
        assert.equal(wakeGaps([], [COZUMEL], NOW).size, 0);
        assert.equal(wakeGaps([PORT_CANAVERAL], [COZUMEL], NOW).size, 0);
    });
});

describe('wake runs', () => {
    it('keeps an unbroken wake in one piece', () => {
        const runs = wakeRuns(CONTINUOUS, new Set());
        assert.equal(runs.length, 1);
        assert.deepEqual(runs[0], CONTINUOUS);
    });

    it('breaks after the marked hop, so the gap falls between two runs', () => {
        const runs = wakeRuns(CONTINUOUS, new Set([2]));
        assert.equal(runs.length, 2);
        assert.equal(runs[0].length, 3);
        assert.equal(runs[1].length, 3);
        // The dotted stretch the caller draws is between these two points.
        assert.deepEqual(runs[0][runs[0].length - 1], CONTINUOUS[2]);
        assert.deepEqual(runs[1][0], CONTINUOUS[3]);
    });

    it('leaves the hull as a run of its own, which draws no line', () => {
        const wake: Array<[number, number]> = [...CONTINUOUS, PORT_CANAVERAL];
        const runs = wakeRuns(wake, new Set([CONTINUOUS.length - 1]));
        assert.deepEqual(runs[runs.length - 1], [PORT_CANAVERAL]);
    });

    it('returns nothing for an empty wake', () => {
        assert.deepEqual(wakeRuns([], new Set()), []);
    });
});
