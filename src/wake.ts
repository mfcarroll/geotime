// src/wake.ts
//
// Where a wake is a passage and where it is a hole.
//
// Its own module because it is pure and worth testing, and ship-markers.ts is
// not importable outside a browser — it reaches for the Maps API at the top
// level. Same reason clock-offset.ts, zone-order.ts and ship-position.ts live
// apart from their callers.

import { distance } from './utils';

/**
 * How far apart two crumbs can be and still be one passage.
 *
 * The wake is a sample, so consecutive points are always a little apart — the
 * question is how much of that is sampling and how much is missing history.
 * Measured across the fleet, 5,157 hops inside drawn wakes:
 *
 *   median      9.8 km
 *   p90        19.0 km
 *   p99        40.7 km
 *   beyond     24 hops, 83 to 309 km
 *
 * p99 landing on 40.7 is the corroboration worth having: an hour behind at 22
 * knots, the fastest vessel in the survey, is 41 km. Real hops stop where the
 * arithmetic says they should, and everything past that is a different
 * population — 7 of those 24 run over land, one for 227 km.
 *
 * 75 km sits between the two with room either side, and errs low deliberately.
 * Too low and a real passage is drawn dotted, understating what is known; too
 * high and a hole is drawn solid, inventing a passage that never happened. The
 * second is the failure that put a line across Florida.
 */
export const JOINABLE_KM = 75;

/**
 * The wake, split wherever the trail goes missing.
 *
 * Returns runs of crumbs that really are consecutive. Whatever falls between two
 * runs is a gap the feed does not account for, to be drawn dotted rather than
 * either joined — which claims a passage that may never have happened — or
 * dropped, which leaves the wake stopping in open water for no stated reason.
 *
 * The ship's own position is just the last crumb as far as this is concerned. It
 * used to be joined unconditionally, on the reasoning that the feed runs up to
 * an hour behind the hull. That is true, and it is the same reasoning that holds
 * for every other hop — so it gets the same test rather than an exemption.
 */
export function wakeRuns(wake: Array<[number, number]>): Array<Array<[number, number]>> {
    const runs: Array<Array<[number, number]>> = [];
    let run: Array<[number, number]> = [];
    for (const crumb of wake) {
        const previous = run[run.length - 1];
        if (previous && distance(previous[1], previous[0], crumb[1], crumb[0]) > JOINABLE_KM) {
            runs.push(run);
            run = [];
        }
        run.push(crumb);
    }
    if (run.length > 0) runs.push(run);
    return runs;
}
