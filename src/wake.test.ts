import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { dayIndex, routeAhead, voyageIsOver, voyageSlice, wakeGaps, wakeRuns, type WakePort } from './wake';

// Real coordinates throughout, because what this guards against was only ever
// visible in real data: a wake drawn confidently through places the ship had
// never been. Synthetic points a degree apart would prove the arithmetic and
// none of the judgement in the rule.

const NOW = Date.parse('2026-09-07T12:00:00Z');
// Instants, not wall clocks: resolving the itinerary's "2026-09-02 17:00:00" in
// the PORT's zone is the caller's job now — see port-clock.ts.
const AGO = Date.parse('2026-09-02T17:00:00-04:00');    // departed
const SOON = Date.parse('2026-09-08T11:59:00-04:00');   // still ahead

/** Star of the Seas: where her held wake stopped, inbound to Cozumel on day 4. */
const OFF_COZUMEL: [number, number] = [-86.40427, 20.96229];
/** And where she actually was on day 8 — alongside, 1,014 km away. */
const PORT_CANAVERAL: [number, number] = [-80.61014, 28.40875];
const COZUMEL: WakePort = { lon: -86.94, lat: 20.51, departsAt: AGO };

/** A plausible afternoon's crumbs off the Florida coast, ~30 km apart. */
const CONTINUOUS: Array<[number, number]> = [
    [-80.10, 28.20], [-80.40, 27.90], [-80.75, 27.60],
    [-81.05, 27.30], [-81.35, 27.00], [-81.65, 26.70],
];

describe('wake gaps', () => {
    it('finds none in a wake that reaches every port it has left', () => {
        const port: WakePort = { lon: -80.75, lat: 27.60, departsAt: AGO };
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
        const ahead: WakePort = { lon: -82.45, lat: 27.94, departsAt: null };
        // Only the backstop fires; the port contributes nothing.
        assert.deepEqual([...wakeGaps(wake, [ahead], NOW)], [5]);
        assert.equal(wakeGaps(CONTINUOUS, [ahead], NOW).size, 0);
    });

    it('leaves a port whose departure is still in the future alone', () => {
        // Vision's Kings Wharf, departing tomorrow.
        const soon: WakePort = { lon: -64.83, lat: 32.32, departsAt: SOON };
        assert.equal(wakeGaps(CONTINUOUS, [soon], NOW).size, 0);
    });

    it('does not dot an ordinary hop just because a port sits off it', () => {
        // The first draft did exactly this, pinning a missed port to whichever
        // hop lay nearest and dotting stretches of 3, 8 and 12 km. A port 40 km
        // off an unbroken wake is a tender berth or a rough coordinate, not a
        // hole in the line.
        const nearby: WakePort = { lon: -80.75, lat: 27.25, departsAt: AGO };
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
        const beyond: WakePort = { lon: -84.0, lat: 24.5, departsAt: AGO };
        const gaps = wakeGaps(wake, [beyond], NOW);
        assert.ok(gaps.has(2), 'the 1,014 km hop, not the 30 km one that shares its start');
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

describe('day index', () => {
    const marks = [
        { i: 336, label: '30 Aug 00:32' },
        { i: 369, label: '31 Aug 00:00' },
        { i: 672, label: '06 Sep 00:30' },
        { i: 707, label: '07 Sep 00:00' },
    ];

    it('finds the day a voyage started', () => {
        assert.equal(dayIndex(marks, '06 Sep, 2026'), 672);
        assert.equal(dayIndex(marks, '30 Aug, 2026'), 336);
    });

    it('ignores the year, which the labels never carry', () => {
        assert.equal(dayIndex(marks, '06 Sep, 2027'), 672);
    });

    it('ignores the time of day, which varies by half an hour either way', () => {
        // Upstream's midnight marks drift: 00:00, 00:30, 02:45 all appear.
        assert.equal(dayIndex([{ i: 5, label: '04 Sep 02:45' }], '04 Sep, 2026'), 5);
    });

    it('returns -1 when the window does not reach the voyage start', () => {
        assert.equal(dayIndex(marks, '01 Aug, 2026'), -1);
    });

    it('returns -1 with nothing to go on', () => {
        assert.equal(dayIndex(marks, null), -1);
        assert.equal(dayIndex([], '06 Sep, 2026'), -1);
        assert.equal(dayIndex(marks, '   '), -1);
    });
});

describe('voyage slice', () => {
    const PC: [number, number] = [-80.607, 28.404];   // Port Canaveral
    /** Well clear of the port — the open-sea part of a passage. */
    const away = (n: number): Array<[number, number]> =>
        Array.from({ length: n }, (_, k) => [-84 - k * 0.1, 24 - k * 0.05] as [number, number]);
    /** Alongside. */
    const atPort = (n: number): Array<[number, number]> =>
        Array.from({ length: n }, () => [PC[0] + 0.01, PC[1] + 0.01] as [number, number]);
    /** An hour out, and still inside the 0.4 degree box — as Star was. */
    const justOut = (n: number): Array<[number, number]> =>
        Array.from({ length: n }, (_, k) => [PC[0] + 0.09 + k * 0.02, PC[1] - 0.05] as [number, number]);

    /**
     * The shape that broke it: two cruises in one window, and the visits to the
     * home port are arrival, stay and next departure in one unbroken stretch —
     * she never leaves the box in between.
     *
     *   0-2    alongside, before the cruise before last
     *   3-12   at sea
     *   13-16  alongside: arrival, turnaround, departure
     *   17-22  at sea, the cruise that has just finished
     *   23-25  alongside: arrival, turnaround, departure again
     *   26-27  an hour into the current cruise, still inside the box
     */
    const track: Array<[number, number]> = [
        ...atPort(3), ...away(10), ...atPort(4), ...away(6), ...atPort(3), ...justOut(2),
    ];
    /**
     * Midnight falls while she is ALONGSIDE, because a cruise departs in the
     * afternoon of its start date — so each mark sits at the beginning of the
     * visit she then sails from, not after it. Star's real marks do the same:
     * "06 Sep 00:30" at index 672, her departure at 691.
     */
    const marks = [
        { i: 0, label: '26 Aug 00:10' },
        { i: 13, label: '30 Aug 00:20' },
        { i: 23, label: '06 Sep 00:30' },
    ];

    it('starts at the departure that began the CURRENT voyage', () => {
        // Sailed an hour ago: an hour of wake, and not a minute of the cruise
        // before it. This is Star and Symphony, both of which drew a finished
        // voyage under the new one.
        const slice = voyageSlice(track, PC, marks, '06 Sep, 2026');
        assert.ok(slice.length <= 3, `drew ${slice.length} points of a 28 point window`);
        assert.deepEqual(slice[slice.length - 1], track[track.length - 1]);
    });

    it('draws the whole cruise when she is alongside at the END of it', () => {
        // The same geometry, a week earlier: the last visit is the ARRIVAL, and
        // the voyage's first day points back to the departure it began with.
        // Choosing the last visit at or after that day would draw a completed
        // cruise as a single point.
        const arrived: Array<[number, number]> = [
            ...atPort(3), ...away(10), ...atPort(4), ...away(6), ...atPort(3),
        ];
        const slice = voyageSlice(arrived, PC, marks, '30 Aug, 2026');
        assert.equal(slice.length, 10, 'from the 30 Aug departure through to the berth');
        assert.deepEqual(slice[0], arrived[16]);
    });

    it('returns a short wake rather than the whole window', () => {
        // A ship an hour into a cruise has an hour of wake. The old code read
        // that as a rendering fault and drew all 720 points of somebody else's
        // voyage instead.
        const slice = voyageSlice(track, PC, marks, '06 Sep, 2026');
        assert.ok(slice.length < track.length / 2);
    });

    it('leaves a ship in mid-passage alone, dated or not', () => {
        const midCruise: Array<[number, number]> = [...atPort(3), ...away(20)];
        const dated = voyageSlice(midCruise, PC, [{ i: 3, label: '06 Sep 00:30' }], '06 Sep, 2026');
        const blind = voyageSlice(midCruise, PC, [], null);
        assert.deepEqual(dated, blind);
        assert.equal(dated.length, 21);
    });

    it('falls back to the last visit when the marks miss the start day', () => {
        // A cruise longer than the window reaches back, or an entry retained
        // before day labels were kept. Right for every ship not mid-turnaround.
        const slice = voyageSlice(track, PC, marks, '14 Jul, 2026');
        assert.deepEqual(slice, voyageSlice(track, PC, [], null));
    });

    it('keeps the whole window for a leg that never touches the origin', () => {
        // A one-way or repositioning sailing. Everything is the best answer.
        const leg = away(30);
        assert.deepEqual(voyageSlice(leg, PC, marks, '06 Sep, 2026'), leg);
    });

    it('has nothing to do without an origin or a track', () => {
        assert.deepEqual(voyageSlice(track, undefined, marks, '06 Sep, 2026'), track);
        assert.deepEqual(voyageSlice([], PC, marks, '06 Sep, 2026'), []);
    });
});

describe('voyage is over', () => {
    const noon = (d: string) => Date.parse(`${d}T12:00:00`);

    it('is not over on its last day, however late', () => {
        // Brilliance, Radiance and Celebrity Infinity were all doing exactly this
        // when it was written: final leg, every port departed, cruise ending
        // today, and each correctly still drawing the run into her last call.
        assert.equal(voyageIsOver('07 Sep, 2026', noon('2026-09-07')), false);
        assert.equal(voyageIsOver('07 Sep, 2026', Date.parse('2026-09-07T23:59:00')), false);
    });

    it('is over the day after', () => {
        assert.equal(voyageIsOver('06 Sep, 2026', noon('2026-09-07')), true);
    });

    it('is not over before it ends', () => {
        assert.equal(voyageIsOver('13 Sep, 2026', noon('2026-09-07')), false);
    });

    it('says nothing when the date is missing or unreadable', () => {
        // The safe direction: the only thing this suppresses is a line that
        // would otherwise be drawn.
        assert.equal(voyageIsOver(null, noon('2026-09-07')), false);
        assert.equal(voyageIsOver('next Thursday', noon('2026-09-07')), false);
        assert.equal(voyageIsOver('', noon('2026-09-07')), false);
    });
});

describe('route ahead', () => {
    /**
     * Harmony of the Seas' real route, all 31 vertices of it, on her round trip
     * out of Port Canaveral. Two things about its shape drive everything below.
     *
     * It DOUBLES BACK: every port is visited twice over, outbound and homeward,
     * so the water at index 8 is the water at index 19 and geometry alone cannot
     * say which leg she is on. And each call is a DUPLICATED PAIR of vertices —
     * Coco Cay at 5 and 6, Cozumel at 17 and 18 — which is what turns a
     * one-vertex error into a visible spike on the map.
     */
    const HARMONY: Array<[number, number]> = [
        [-80.60688, 28.40364], [-80.56006, 28.409107], [-79.031804, 26.258172],
        [-77.981406, 25.902989], [-77.985901, 25.83423],
        [-77.93411, 25.8169], [-77.93411, 25.8169],            // Coco Cay
        [-77.985901, 25.83423], [-78.691629, 25.791336], [-79.18788, 25.810065],
        [-79.880466, 25.273181], [-80.326746, 24.731696], [-81.202233, 23.978561],
        [-81.572913, 23.840338], [-82.076714, 23.730991], [-82.861672, 23.720652],
        [-85.837088, 21.657746],
        [-86.95408, 20.51213], [-86.95408, 20.51213],          // Cozumel
        [-85.837088, 21.657746], [-82.861672, 23.720652], [-82.092874, 23.972037],
        [-81.953348, 24.161146], [-80.797412, 24.600942], [-80.231637, 25.017102],
        [-80.056052, 25.273181], [-79.872937, 26.600425], [-79.912494, 26.97601],
        [-80.151633, 27.522691], [-80.56006, 28.409107], [-80.60688, 28.40364],
    ];
    const COCO_CAY: [number, number] = [-77.93411, 25.8169];
    const COZUMEL: [number, number] = [-86.95408, 20.51213];
    const CANAVERAL: [number, number] = [-80.60688, 28.40364];

    /** Where she was, and what she was doing: 41 km past Coco Cay at 19 knots. */
    const UNDER_WAY: [number, number] = [-78.29509, 25.98767];
    const COURSE = 288;

    const NOW = Date.parse('2026-09-06T22:46:00Z');
    /** Coco Cay's stated 17:00, resolved in the Bahamas' own clock. */
    const LEFT_COCO_CAY = Date.parse('2026-09-06T21:00:00Z');
    const LEAVES_COZUMEL = Date.parse('2026-09-08T21:00:00Z');

    const itinerary = (cocoCay: number | null): WakePort[] => [
        { lon: COCO_CAY[0], lat: COCO_CAY[1], departsAt: cocoCay },
        { lon: COZUMEL[0], lat: COZUMEL[1], departsAt: LEAVES_COZUMEL },
        { lon: CANAVERAL[0], lat: CANAVERAL[1], departsAt: null },
    ];

    /** Degrees off the bow, so "ahead" can be asserted rather than eyeballed. */
    const offBow = (to: [number, number]) => {
        const scale = Math.cos((UNDER_WAY[1] * Math.PI) / 180);
        const bearing = (Math.atan2(
            (to[0] - UNDER_WAY[0]) * scale, to[1] - UNDER_WAY[1]) * 180) / Math.PI;
        return Math.abs(((bearing - COURSE + 540) % 360) - 180);
    };

    it('sets off for the next call, not back to the one just left', () => {
        // The fault, exactly as reported: "the forward track is still looping
        // back to Coco Cay before continuing on, so there's a zig zag." Twelve
        // of forty-five vessels were drawing one, all of them within a few hours
        // of a departure — which is the window in which the itinerary was being
        // read in the wrong clock. See port-clock.ts.
        const line = routeAhead(
            HARMONY, itinerary(LEFT_COCO_CAY), '10 Sep, 2026', UNDER_WAY, COURSE, NOW);

        assert.deepEqual(line[0], UNDER_WAY, 'begins at the vessel');
        assert.ok(offBow(line[1]) < 90,
            `sets off ${offBow(line[1]).toFixed(0)}° off the bow`);
        assert.notDeepEqual(line[1], COCO_CAY, 'not back to Coco Cay');
        assert.ok(line.some((p) => p[0] === COZUMEL[0] && p[1] === COZUMEL[1]),
            'and still arrives at Cozumel');
    });

    it('never begins past the call she has not reached', () => {
        // The other half of the same clamp, and the reason it exists: with Coco
        // Cay still ahead of her the line has to run through it rather than set
        // off for the call after it. Without the ceiling, projection onto a
        // route that doubles back skipped Cadiz entirely on Liberty of the Seas.
        const line = routeAhead(
            HARMONY, itinerary(NOW + 3600_000), '10 Sep, 2026', UNDER_WAY, COURSE, NOW);
        assert.deepEqual(line[1], COCO_CAY, 'through the port, not past it');
    });

    it('has nothing to draw for a voyage that has ended', () => {
        assert.deepEqual(
            routeAhead(HARMONY, itinerary(LEFT_COCO_CAY), '05 Sep, 2026', UNDER_WAY, COURSE, NOW),
            []);
    });

    it('falls back to the last departed port when there is no position', () => {
        const line = routeAhead(
            HARMONY, itinerary(LEFT_COCO_CAY), '10 Sep, 2026', null, null, NOW);
        assert.deepEqual(line[0], COCO_CAY);
    });

    /**
     * Serenade of the Seas, alongside at Canada Place with nothing departed yet.
     *
     * Trimmed to the vertices that matter, and the first two and last two are
     * verbatim: her route leaves Vancouver and comes home through exactly the
     * same water, so the outbound segment and the homeward one are the SAME LINE
     * traversed backwards. Distance to each is therefore equal in real
     * arithmetic and unequal in floating point — the homeward one measured
     * nearer by two parts in 10^20, which was enough to choose it.
     */
    const VANCOUVER: [number, number] = [-123.10906, 49.28856];
    const FIRST_NARROWS: [number, number] = [-123.261, 49.3102];
    const SITKA: [number, number] = [-135.37854, 57.12623];
    const INSIDE_PASSAGE: Array<[number, number]> = [
        VANCOUVER, FIRST_NARROWS, [-127.5, 51.5], [-133.0, 55.0],
        SITKA, SITKA,
        [-133.0, 55.0], [-127.5, 51.5], FIRST_NARROWS, VANCOUVER,
    ];
    /** Her AIS fix at the berth, 0.2 km off the vertex the route uses. */
    const ALONGSIDE: [number, number] = [-123.10709, 49.28996];
    const ALASKA: WakePort[] = [
        { lon: SITKA[0], lat: SITKA[1], departsAt: Date.parse('2026-09-08T18:30:00-08:00') },
        { lon: VANCOUVER[0], lat: VANCOUVER[1], departsAt: null },
    ];

    it('draws the whole outbound leg for a ship still at her origin', () => {
        // What it drew instead was Vancouver to Sitka in one straight line with
        // the entire Inside Passage missing — the homeward segment won the tie,
        // the ceiling pulled it back to Sitka, and 25 vertices vanished.
        const line = routeAhead(
            INSIDE_PASSAGE, ALASKA, '13 Sep, 2026', ALONGSIDE, null, NOW);

        assert.deepEqual(line[1], FIRST_NARROWS, 'out through the First Narrows');
        assert.equal(line.length, INSIDE_PASSAGE.length, 'the whole route, plus her');
    });

    it('ignores a course of null rather than walking the line away', () => {
        // Why the caller withholds a moored hull's heading. Serenade lay at the
        // berth pointing east with her whole voyage leading west; given that as
        // a course, every vertex ahead of her reads as behind and the walk
        // consumes the line up to its ceiling.
        const moored = routeAhead(
            INSIDE_PASSAGE, ALASKA, '13 Sep, 2026', ALONGSIDE, 81, NOW);
        assert.deepEqual(moored[1], SITKA, 'the answer a berth heading produces');

        const withheld = routeAhead(
            INSIDE_PASSAGE, ALASKA, '13 Sep, 2026', ALONGSIDE, null, NOW);
        assert.deepEqual(withheld[1], FIRST_NARROWS, 'and the answer without it');
    });

    it('still uses a course from a ship that is making way', () => {
        // The walk earns its place on the doubled-back stretch: at Cozumel the
        // route turns round on itself, and the vertex projection lands on can be
        // the one she has just passed.
        const homeward: [number, number] = [-86.0, 21.5];
        const line = routeAhead(
            HARMONY,
            [{ lon: COCO_CAY[0], lat: COCO_CAY[1], departsAt: LEFT_COCO_CAY },
             { lon: COZUMEL[0], lat: COZUMEL[1], departsAt: Date.parse('2026-09-08T21:00:00Z') },
             { lon: CANAVERAL[0], lat: CANAVERAL[1], departsAt: null }],
            '10 Sep, 2026', homeward, 60, Date.parse('2026-09-08T23:00:00Z'));
        assert.ok(line.length >= 2);
        assert.ok(line[1][0] > homeward[0], 'headed east for home, not west to Cozumel');
    });

    it('leaves a route of fewer than two points alone', () => {
        assert.deepEqual(routeAhead([], [], null, UNDER_WAY, COURSE, NOW), []);
        assert.deepEqual(routeAhead([COCO_CAY], [], null, UNDER_WAY, COURSE, NOW), [COCO_CAY]);
    });
});
