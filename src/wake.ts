// src/wake.ts
//
// Where a wake is a passage and where it is a hole.
//
// Its own module because it is pure and worth testing, and ship-markers.ts is
// not importable outside a browser — it reaches for the Maps API at the top
// level. Same reason clock-offset.ts, zone-order.ts and ship-position.ts live
// apart from their callers.

import { distance } from './utils';

/** Just the parts of a ShipPort this needs, so tests need not build one. */
export interface WakePort {
    lon: number;
    lat: number;
    /** Upstream's local wall time, "2026-08-31 17:00:00", or null. */
    depart: string | null;
}

/**
 * How near a crumb has to pass for the wake to have reached a port.
 *
 * Generous, because several calls are tender ports where the ship anchors
 * offshore, and because the track is a sample that need not include the closest
 * approach. The same 25 km the port-coverage survey used.
 */
const REACHED_KM = 25;

/**
 * Below this, a hop is sampling rather than a hole, whatever the itinerary says.
 *
 * A gate, not the test. Without it a missed port gets pinned to whichever hop
 * happens to lie nearest it, and that is usually an ordinary short one — the
 * first draft of this dotted hops of 3, 8 and 12 km, which is not a gap anybody
 * can see and not where the missing stretch is. A port sitting 30 km off an
 * unbroken wake is a tender berth or a rough coordinate, not a hole in the line.
 *
 * Real hops run to a p99 of 40.7 km, and an hour behind at 22 knots — the
 * fastest in the fleet survey — is 41 km, so 75 is comfortably past anything
 * sampling produces.
 */
const MIN_GAP_KM = 75;

/**
 * A hop this long is drawn dotted whatever the itinerary says.
 *
 * A backstop, not the rule. Nothing in the fleet survey triggered it — the
 * largest hop that skipped no port was 266 km — and it exists for the case the
 * survey did not contain: a wake whose held history is old enough that the ship
 * has crossed an ocean since, on a leg with no port on it at all. A straight
 * line is a fair sketch of a passage between two real positions at 200 km and a
 * fiction at 2,000.
 *
 * Set above every harmless gap observed, with margin, and below the smallest
 * harmful one that distance alone would have caught.
 */
const ALWAYS_DOTTED_KM = 400;

/**
 * Which hops in the wake are holes rather than passages, by index.
 *
 * DISTANCE IS NOT THE TEST, and that took a fleet survey to establish. The two
 * populations overlap almost entirely:
 *
 *   hops skipping no port    76 - 266 km, and 0 km of them cross land
 *   hops skipping a port     76 - 1263 km, and 573 km of them cross land
 *
 * So a threshold at any distance either dots gaps that need no dotting — an
 * afternoon's sampling hole in open water, which is what Allure of the Seas had
 * at 184 km — or misses real ones, since the smallest harmful gap in the survey
 * was 76 km. Every kilometre of land crossed was in a hop that skipped a port,
 * and none at all in a hop that did not.
 *
 * What makes a hop a hole is therefore that the voyage went somewhere the wake
 * does not show: a port the ship has already sailed FROM, which no crumb passes
 * near. That is the fault worth drawing, and it is the one a reader can check
 * against the itinerary in front of them.
 *
 * Ports still ahead are excluded, which is the whole reason `depart` is read
 * rather than the day number. On day three of eight, five ports are naturally
 * absent from the wake and none of them is missing.
 *
 * @param at  now, as ms; ports departed before this should be on the wake.
 */
export function wakeGaps(
    wake: Array<[number, number]>,
    ports: WakePort[],
    at: number
): Set<number> {
    const gaps = new Set<number>();
    if (wake.length < 2) return gaps;

    const hop = (i: number) => distance(wake[i][1], wake[i][0], wake[i + 1][1], wake[i + 1][0]);

    // Only a hop already too long to be sampling can be a hole. A missed port
    // picks among these, never among the ordinary ones.
    const candidates: number[] = [];
    for (let i = 0; i < wake.length - 1; i++) {
        const length = hop(i);
        if (length > ALWAYS_DOTTED_KM) gaps.add(i);
        if (length > MIN_GAP_KM) candidates.push(i);
    }
    if (candidates.length === 0) return gaps;

    for (const port of ports) {
        const departed = port.depart ? Date.parse(port.depart.replace(' ', 'T')) : NaN;
        // No departure time means she has not left — the last call of the
        // itinerary, where she may be standing right now. Nothing is missing yet.
        if (!Number.isFinite(departed) || departed > at) continue;

        const reached = wake.some((c) => distance(c[1], c[0], port.lat, port.lon) <= REACHED_KM);
        if (reached) continue;

        // Which hole this port fell into: the candidate whose ends come nearest
        // it. Crude on purpose — a real passage bows away from the straight line
        // between its ends, so measuring to the line itself would put Cozumel
        // 382 km off a leg it is genuinely on. Endpoints are enough to pick the
        // right one out of a handful, and there are only ever a handful.
        let best = candidates[0];
        let bestKm = Infinity;
        for (const i of candidates) {
            const d = Math.min(
                distance(wake[i][1], wake[i][0], port.lat, port.lon),
                distance(wake[i + 1][1], wake[i + 1][0], port.lat, port.lon)
            );
            // Ties go to the longer hop. Adjacent hops share an endpoint, so a
            // port beyond the end of the track is exactly equidistant from the
            // last real hop and the long one closing to the ship — and it is the
            // long one the ship actually crossed.
            if (d < bestKm - 0.001 || (Math.abs(d - bestKm) <= 0.001 && hop(i) > hop(best))) {
                bestKm = d;
                best = i;
            }
        }
        gaps.add(best);
    }
    return gaps;
}

/**
 * The wake, split at the holes.
 *
 * Returns runs of crumbs to be drawn solid. Whatever falls between two runs is a
 * hop `wakeGaps` called a hole, drawn dotted by the caller rather than either
 * joined — which claims a passage that never happened — or dropped, which leaves
 * the wake stopping in open water for no stated reason.
 *
 * The ship's own position is just the last crumb as far as this is concerned.
 */
export function wakeRuns(
    wake: Array<[number, number]>,
    gaps: Set<number>
): Array<Array<[number, number]>> {
    const runs: Array<Array<[number, number]>> = [];
    let run: Array<[number, number]> = [];
    for (let i = 0; i < wake.length; i++) {
        run.push(wake[i]);
        if (gaps.has(i)) { runs.push(run); run = []; }
    }
    if (run.length > 0) runs.push(run);
    return runs;
}
