// src/wake.ts
//
// Which parts of a voyage to draw: where the wake is a passage and where it is
// a hole, and which way along the route is still ahead.
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
    /**
     * When she is due to leave, as an instant.
     *
     * Resolved by the caller and never parsed here, because the itinerary states
     * it as a bare wall clock in the PORT's zone and only the caller can look
     * that zone up — see port-clock.ts, and the loop-backs that reading it in
     * the device's zone drew.
     *
     * Null where the itinerary states none, which is the last call of every
     * cruise. Null means "has not left", never "left long ago".
     */
    departsAt: number | null;
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
 * Ports still ahead are excluded, which is the whole reason a departure time is
 * read rather than the day number. On day three of eight, five ports are
 * naturally absent from the wake and none of them is missing.
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
        // No departure time means she has not left — the last call of the
        // itinerary, where she may be standing right now. Nothing is missing yet.
        if (port.departsAt === null || port.departsAt > at) continue;

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

/** One point in the track that told us which day it belongs to. */
export interface DayMark {
    /** Index into the track. */
    i: number;
    /** Upstream's own wording, "06 Sep 00:30". No year, ever. */
    label: string;
}

/**
 * Where in the track the named day begins, or -1.
 *
 * Matched on day and month alone, because the labels carry no year and the
 * window they cover is a fortnight — no two marks in it can share a date. That
 * also means this survives a New Year without special handling, which a
 * year-aware parse would not have done without inventing one.
 *
 * `startDate` arrives as "06 Sep, 2026" and labels as "06 Sep 00:30", so the
 * comparison is the first two whitespace-separated words of each, lowercased,
 * with punctuation dropped.
 */
export function dayIndex(marks: DayMark[], startDate: string | null): number {
    if (!startDate) return -1;
    const key = (s: string) => s.replace(/,/g, ' ').trim().split(/\s+/).slice(0, 2).join(' ').toLowerCase();
    const want = key(startDate);
    if (!want) return -1;
    for (const mark of marks) {
        if (key(mark.label) === want) return mark.i;
    }
    return -1;
}

/**
 * The stretch of the rolling window belonging to the voyage in progress.
 *
 * The window is a fixed ~720 points however long ago the cruise started, so on a
 * ship mid-sailing it reaches back through the previous voyage and sometimes the
 * one before. Drawing it raw answers a question nobody asked.
 *
 * TWO SIGNALS, AND NEITHER IS ENOUGH ALONE.
 *
 * Geometry finds the visits to the embarkation port, but cannot say which one
 * this voyage began at. On turnaround day the arrival, the stay and the next
 * departure are ONE unbroken stretch of "near the port" — she never leaves the
 * box in between — so the old rule, which asked whether she was still there and
 * stepped back a visit if so, chose the previous cruise's departure and drew a
 * finished voyage. Observed on Star and Symphony within minutes of each other,
 * both sailing new itineraries with the old ones drawn under them.
 *
 * Time says which day each part of the window is, but not where in that day she
 * sailed. Clipping at the voyage's first midnight still includes the run home
 * from the cruise before, which shares the date.
 *
 * Together they are exact: take the visits to the embarkation port, and pick the
 * last one that begins on or after the voyage's first day. That is the departure
 * this voyage started with, whatever else happened at that berth.
 *
 * Degrades in the right direction. No marks, no start date, or a window that
 * does not reach back to the voyage's first day — a long cruise, or an entry
 * retained before day labels were kept — and it falls back to the last visit,
 * which is right for every ship that is not mid-turnaround.
 */
export function voyageSlice(
    track: Array<[number, number]>,
    origin: [number, number] | undefined,
    marks: DayMark[],
    startDate: string | null
): Array<[number, number]> {
    if (!origin || track.length < 2) return track;

    // Within about 25 nm of the departure port counts as being there. Loose
    // enough to catch a track that never passes exactly through the marker,
    // tight enough not to match a different port on the same coast.
    const NEAR_DEGREES = 0.4;
    const near = (i: number) =>
        Math.abs(track[i][0] - origin[0]) < NEAR_DEGREES &&
        Math.abs(track[i][1] - origin[1]) < NEAR_DEGREES;

    const visits: Array<{ from: number; to: number }> = [];
    for (let i = 0; i < track.length; i++) {
        if (!near(i)) continue;
        const last = visits[visits.length - 1];
        if (last && i === last.to + 1) last.to = i;
        else visits.push({ from: i, to: i });
    }
    // Never near the start: a one-way or repositioning leg, or a route that does
    // not begin where the window does. The whole window is the best answer here.
    if (visits.length === 0) return track;

    // The FIRST visit at or after the voyage's opening day, not the last.
    //
    // Both are the same ship alongside the same berth, and only the date tells
    // them apart:
    //
    //   TURNAROUND   she arrived, turned round and sailed again inside one
    //                unbroken stretch of "near the port". The voyage's first day
    //                falls inside that stretch, so it is the one chosen, and the
    //                wake starts where she left — minutes ago.
    //   ARRIVAL DAY  she is alongside at the END of the voyage. Its first day is
    //                a week earlier, so the visit chosen is the departure back
    //                then, and the whole completed cruise is drawn.
    //
    // Taking the LAST such visit gets turnaround right and arrival day wrong,
    // drawing a finished cruise as a single point. Taking the first gets both.
    const firstDay = dayIndex(marks, startDate);
    const departure = (firstDay >= 0 ? visits.find((v) => v.to >= firstDay) : undefined)
        ?? visits[visits.length - 1];

    // From the LAST point of the visit — the moment she left, not the moment she
    // arrived — so a long stay alongside is not drawn as part of the passage.
    //
    // Returned however short it comes out, which is the other half of the fix. A
    // ship two hours into a cruise has two hours of wake, and the old code read
    // that as a rendering fault and drew the entire window instead — turning a
    // correct empty answer into somebody else's voyage.
    return track.slice(departure.to);
}

/**
 * Whether a voyage has finished, by its own account.
 *
 * Compared by calendar day rather than by instant, and the grace that buys is
 * the point: a cruise ending TODAY is still under way as far as this is
 * concerned, right up to midnight. Three vessels were checked while writing
 * this — Brilliance, Radiance and Celebrity Infinity — each on the final leg of
 * a cruise ending today with every port already departed, and each correctly
 * still drawing the run into her last call.
 *
 * `endDate` arrives as "06 Sep, 2026". Parsed by Date, which reads that format,
 * and treated as unfinished if it cannot be read — the safe direction, since the
 * only thing this suppresses is a line we would otherwise draw.
 */
export function voyageIsOver(endDate: string | null, at: number): boolean {
    if (!endDate) return false;
    const end = Date.parse(endDate.replace(/,/g, ''));
    if (!Number.isFinite(end)) return false;
    const endOfThatDay = new Date(end);
    endOfThatDay.setHours(23, 59, 59, 999);
    return at > endOfThatDay.getTime();
}

/**
 * Index of the route vertex closest to a point, searching from `from` onward.
 *
 * Longitude is scaled by cos(latitude) so a degree of longitude is compared
 * against a degree of latitude at roughly its true length. Without it, two
 * vertices equally far away in miles compare unequally at high latitude, and the
 * nearest vertex to a ship off Norway is not the one it looks like on the map.
 */
function nearestIndex(
    route: Array<[number, number]>,
    target: [number, number],
    from: number
): number {
    const scale = Math.cos((target[1] * Math.PI) / 180) || 1;
    let best = from;
    let bestDistance = Infinity;
    for (let i = from; i < route.length; i++) {
        const dx = (route[i][0] - target[0]) * scale;
        const dy = route[i][1] - target[1];
        const d = dx * dx + dy * dy;
        if (d < bestDistance) {
            bestDistance = d;
            best = i;
        }
    }
    return best;
}

/**
 * Comparable distance from a point to a segment, longitude-scaled.
 *
 * Not a real distance — only ever compared against others computed the same way,
 * at latitudes close enough that one scale factor serves for all of them.
 */
function distanceToSegment(
    p: [number, number], a: [number, number], b: [number, number]
): number {
    const scale = Math.cos((p[1] * Math.PI) / 180) || 1;
    const ax = (a[0] - p[0]) * scale, ay = a[1] - p[1];
    const bx = (b[0] - p[0]) * scale, by = b[1] - p[1];
    const dx = bx - ax, dy = by - ay;

    const length = dx * dx + dy * dy;
    // A degenerate segment is just its own endpoint.
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length));

    const cx = ax + t * dx, cy = ay + t * dy;
    return cx * cx + cy * cy;
}

/** More than a right angle off the bow, and therefore behind her. */
function astern(from: [number, number], to: [number, number], course: number): boolean {
    const scale = Math.cos((from[1] * Math.PI) / 180) || 1;
    const bearing = (Math.atan2((to[0] - from[0]) * scale, to[1] - from[1]) * 180) / Math.PI;
    const off = Math.abs(((bearing - course + 540) % 360) - 180);
    return off > 90;
}

/**
 * The port she is heading for: the first call not yet departed, else null.
 *
 * A call with no departure time is that port — it is the end of the itinerary,
 * where nobody leaves again — so it stops the walk rather than being skipped.
 */
function nextCall(ports: WakePort[], now: number): [number, number] | null {
    for (const port of ports) {
        if (port.departsAt === null || port.departsAt > now) return [port.lon, port.lat];
    }
    return null;
}

/** The furthest route index belonging to a port we have already left. */
function departedFloor(
    ports: WakePort[], route: Array<[number, number]>, now: number
): number {
    let floor = 0;
    for (const port of ports) {
        if (port.departsAt === null || port.departsAt > now) continue;
        floor = Math.max(floor, nearestIndex(route, [port.lon, port.lat], 0));
    }
    return floor;
}

/**
 * The part of the planned route still to come: from where the ship is now, to
 * the last port.
 *
 * Needed because `route` is the whole voyage, including the water already
 * covered. Drawing it entire and letting the wake cover the sailed part looks
 * right only while there IS a wake — and the upstream track goes empty often
 * enough that the fallback matters, where the full route would then claim the
 * ship had not left yet.
 *
 * The hard part is that a nearest-vertex search is ambiguous on a round trip:
 * these itineraries come back through water they went out through, so the vertex
 * closest to the ship may belong to the leg it has not sailed yet. The
 * itinerary breaks the tie — no part of the route before the last port the ship
 * has already left can still be ahead of it — so the search is floored at that
 * port and geometry only decides the rest.
 *
 * WHICH MEANS THE ITINERARY HAS TO BE READ IN THE RIGHT CLOCK. Both the floor
 * and the ceiling below are "has she left yet?" tests, and while the answer was
 * computed in the device's zone instead of the port's, the whole line inverted
 * for the few hours after every departure — see port-clock.ts. `departsAt`
 * arrives already resolved for exactly that reason.
 */
export function routeAhead(
    route: Array<[number, number]>,
    ports: WakePort[],
    endDate: string | null,
    position: [number, number] | null,
    course: number | null,
    now: number,
): Array<[number, number]> {
    if (route.length < 2) return route;

    // A voyage that has already ended has no route ahead, and the route we hold
    // is not the one she is on.
    //
    // Left undrawn rather than drawn wrong, because what this produces otherwise
    // is not a small error. Every port of a finished cruise has departed, so
    // `nextCall` falls through to the last call — the only one without a
    // departure time — and `limit` lands on the final vertex of a round trip.
    // The line becomes the ship plus one point: a dashed stub back to the port
    // she has just sailed FROM, pointing the wrong way down a voyage she has
    // finished.
    //
    // Watched on Oasis of the Seas an hour out of New York on a new cruise,
    // while the finished one was still cached: 2 points and 59 km where the
    // answer was 36 points and 3,952 km. The window is ours rather than
    // upstream's — thirty minutes of Worker cache and thirty of client cache —
    // but it reopens at every turnaround, so it wants handling rather than
    // waiting out.
    if (voyageIsOver(endDate, now)) return [];

    const floor = departedFloor(ports, route, now);
    if (!position) return route.slice(floor);

    // The next port of call is the one thing this line must not lose.
    //
    // Whatever else is uncertain — which leg of a round trip she is on, which
    // vertex is behind her — the route ahead has to arrive at the place she is
    // going. So her next call's vertex is a ceiling on the search below as well
    // as on the walk after it: she has left every port before `floor` and
    // reached none at or beyond `limit`, so the stretch she is on lies between
    // them by construction.
    const target = nextCall(ports, now);
    const limit = target ? nearestIndex(route, target, floor) : route.length - 1;

    // Which SEGMENT she is on, not which vertex she is near.
    //
    // Snapping to the nearest vertex was wrong in a way that distance to the
    // next port could not fix. A route is a coarse polyline; the vertex closest
    // to a ship halfway along a leg is routinely the one she has just passed, so
    // the line hooked backwards before setting off. Ordering by progress toward
    // the next call corrected that where the call was near — Liberty, 237 km
    // from Cadiz — and did nothing where it was far: Oasis, 1679 km from Cape
    // Liberty, moved 8 km and still set off in the opposite direction to her
    // course.
    //
    // Position ALONG THE POLYLINE is the ordering that actually means "ahead",
    // and it needs no reference point to measure against. Find the segment she
    // is nearest to and start at that segment's far end: everything before it
    // she has sailed, by construction rather than by inference.
    //
    // SEARCHED WITHIN THE CEILING, not clamped to it afterwards, and a round
    // trip is why. Its first segment and its last are the same water — Serenade
    // of the Seas alongside in Vancouver was 0.2 km from both — so which one
    // wins comes down to the last bit of a float. It picked segment 90 of 92 by
    // a margin of 2e-20, the clamp pulled that back to the ceiling, and the
    // route ahead became a straight line from Vancouver to Sitka with the whole
    // Inside Passage missing. Bounding the search cannot express that answer.
    let bestSegment = floor;
    let bestDistance = Infinity;
    for (let i = floor; i < Math.min(limit, route.length - 1); i++) {
        const d = distanceToSegment(position, route[i], route[i + 1]);
        if (d < bestDistance) {
            bestDistance = d;
            bestSegment = i;
        }
    }

    let at = Math.min(Math.max(bestSegment + 1, floor), limit);

    // Then discard anything still astern of her.
    //
    // Projection alone is not enough, and the reason is these itineraries: most
    // are round trips, so the polyline passes through the same water twice and
    // the segment she is nearest to may belong to the leg she is not on. Her own
    // course settles it — a vertex more than a right angle off the bow is behind
    // her whatever the index says.
    //
    // Only while she is making way, which is the caller's job to decide: a
    // moored hull's heading is the berth's orientation and says nothing about
    // where she is going next. Serenade lay at Canada Place pointing east with
    // her whole voyage leading west, and every vertex of it read as behind her —
    // so this walked the line up to its ceiling and drew Vancouver to Sitka
    // direct. A null course means "no opinion", and no opinion is right here.
    if (course !== null) {
        while (at < limit && astern(position, route[at], course)) at++;
    }

    // Begins at the vessel rather than at the vertex: on a 10-point polyline
    // across an ocean that vertex can be a hundred miles away, and the gap
    // between the ship and her own route reads as a rendering fault.
    //
    // That join is a straight line to a PLANNED route from an ACTUAL position,
    // so where a ship has left her plan it can cross land. Watched on Oasis of
    // the Seas working around the Bahamas — weather routing, presumably — where
    // the line cut through the islands. Left as it is: the alternative is
    // inventing a path we have no basis for, and the line's job here is to say
    // which way along the route is ahead, which it now does.
    return [position, ...route.slice(at)];
}

/**
 * How far into a leg a corner may be cut, in kilometres.
 *
 * The whole budget for this, and small on purpose. A rounded corner is a
 * PRETTIER version of the route, never a different one: the curve stays inside
 * the triangle made by the corner and its two trim points, so nothing can move
 * further from the stated line than this, and a turn drawn tight against a
 * headland cannot be rounded out into it.
 *
 * Four kilometres is under a pixel at the zoom a whole cruise is framed at, and
 * about three at the zoom one leg fills the screen — which is the range where a
 * corner reads as a corner rather than as a kink.
 */
const CORNER_KM = 4;

/**
 * Beyond this much of a turn, the corner is left alone.
 *
 * A route doubles back on itself at every port — in and out through the same
 * water — and the vertex there is a reversal rather than a bend. Rounding it
 * would pull the line short of the very place it exists to reach, and draw a
 * loop where the ship turned round.
 */
const CORNER_MAX_TURN = 150;

/**
 * The same path with its corners eased.
 *
 * A planned route is a handful of waypoints, so every course change is a hard
 * angle — which is honest about the data and wrong about the sea, where nothing
 * turns on a point. Each interior vertex becomes a short quadratic curve
 * between two points trimmed back along its own legs, with the vertex as the
 * control point.
 *
 * Deliberately not a smoothing filter. Chaikin and friends move every vertex by
 * a FRACTION of its legs, which is unbounded in kilometres and cuts a 200 km
 * leg's corner by twenty; this trims a fixed distance, so the longer the leg the
 * less of it proportionally is touched and the error stays where it can be
 * reasoned about. See CORNER_KM.
 */
export function roundCorners(
    path: Array<[number, number]>,
    maxKm = CORNER_KM
): Array<[number, number]> {
    if (path.length < 3) return path;

    const out: Array<[number, number]> = [path[0]];
    for (let i = 1; i < path.length - 1; i++) {
        const before = path[i - 1], at = path[i], after = path[i + 1];
        const back = distance(at[1], at[0], before[1], before[0]);
        const on = distance(at[1], at[0], after[1], after[0]);

        // A duplicated vertex — which is how a port call arrives — has no leg to
        // trim along and no corner to round.
        if (back === 0 || on === 0 || turnAt(before, at, after) > CORNER_MAX_TURN) {
            out.push(at);
            continue;
        }

        // Never past halfway, or two corners on a short leg would meet in the
        // middle and swallow the straight between them.
        const from = along(at, before, Math.min(0.5, maxKm / back));
        const to = along(at, after, Math.min(0.5, maxKm / on));

        // Three samples is enough for an arc this short; a fourth is invisible
        // and costs a point on every corner of every redraw.
        for (const t of [0, 0.25, 0.5, 0.75, 1]) {
            const u = 1 - t;
            out.push([
                u * u * from[0] + 2 * u * t * at[0] + t * t * to[0],
                u * u * from[1] + 2 * u * t * at[1] + t * t * to[1],
            ]);
        }
    }
    out.push(path[path.length - 1]);
    return out;
}

/** A point a fraction of the way from `at` toward `to`. */
function along(at: [number, number], to: [number, number], t: number): [number, number] {
    return [at[0] + (to[0] - at[0]) * t, at[1] + (to[1] - at[1]) * t];
}

/** Degrees of course change at a vertex: 0 is straight on, 180 is a reversal. */
function turnAt(
    before: [number, number], at: [number, number], after: [number, number]
): number {
    const scale = Math.cos((at[1] * Math.PI) / 180) || 1;
    const inbound = Math.atan2((at[0] - before[0]) * scale, at[1] - before[1]);
    const outbound = Math.atan2((after[0] - at[0]) * scale, after[1] - at[1]);
    const degrees = ((outbound - inbound) * 180) / Math.PI;
    return Math.abs(((degrees + 540) % 360) - 180);
}
