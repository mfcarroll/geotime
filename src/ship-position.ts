// src/ship-position.ts
//
// Which hull are we standing on?
//
// Native never asks this. Aboard, the ship's own gateway stamps every response
// with environment-marker and environment-ship-code, and CapacitorHttp reads
// them because it is not bound by CORS. A browser is, and `?shipprobe` was run
// aboard Star of the Seas to find out whether the gateway stamps OUR origin
// too. It does not — nothing touched those responses in transit. Those headers
// come from RCCL's own infrastructure, so no host we control will ever carry
// them and that route is closed for good. See docs/next-version.md item 4.
//
// What is left is inference: the app already knows where the device is, and the
// fleet feed already knows where the ships are. If exactly one vessel is within
// arm's reach of the device, that is the one it is on.
//
// The whole difficulty is in "exactly one", and in trusting neither position
// more than it deserves.

import { distance } from './utils';
import type { ShipRef } from './ships';
import type { NearbyVessel } from './shiptrack';

/**
 * How close counts as aboard.
 *
 * Not a measure of GPS error — it is the radius inside which a second vessel
 * makes the answer unknowable. Ten kilometres is far larger than any hull and
 * far smaller than the separation between ships genuinely under way, which is
 * what makes it work: at sea the nearest other vessel is typically hundreds of
 * kilometres off, and alongside it is a few hundred metres.
 */
const ACCEPT_KM = 10;

/**
 * How stale a fix may be before its position stops meaning anything.
 *
 * A vessel out of terrestrial AIS range is only seen on satellite passes, and
 * some fixes in the feed are hours old. A ship doing 17 knots that was last
 * seen 217 minutes ago is somewhere in a 114 km circle — so the honest response
 * is not to widen the search but to admit we do not know where she is.
 *
 * Expressed as distance rather than time, because a moored ship has not moved
 * no matter how old its fix is, and that is the case where the feed is most
 * often stale and least often wrong.
 */
const UNCERTAINTY_BASE_KM = 2;

/** Where a vessel might be, given how long ago it was last seen. */
function uncertaintyKm(vessel: NearbyVessel, now: number): number {
  if (vessel.tst === null) return Infinity;
  const hours = Math.max(0, (now - vessel.tst * 1000) / 3_600_000);
  const knots = vessel.sog ?? 0;
  return UNCERTAINTY_BASE_KM + knots * 1.852 * hours;
}

/**
 * A fix good enough to reason about.
 *
 * This is the guard the whole feature rests on. A ship's wifi is Starlink, and
 * a network-derived position can land on the other side of the world from the
 * hull it was taken aboard — onLocationSuccess already says so, and it is the
 * reason that function distinguishes the two kinds of fix at all.
 *
 * Matching a network position against a vessel position would not be slightly
 * worse, it would be nonsense: the answer would be "you are aboard whichever
 * ship is nearest to your ISP". So only a sensor fix is admitted, and the tell
 * is the same one the location card uses — the fields a network fix cannot
 * supply.
 */
export interface DeviceFix {
  lat: number;
  lon: number;
  accuracy: number;
  /** True when altitude, speed or heading was present: a real sensor fix. */
  sensor: boolean;
}

export function isUsableFix(fix: DeviceFix | null): fix is DeviceFix {
  return !!fix && fix.sensor && fix.accuracy <= 100;
}

/** What the device is standing on, as far as position can tell. */
export type PositionVerdict =
  | { kind: 'aboard'; imo: string; ship: ShipRef; name: string | null; km: number }
  | { kind: 'ashore' }
  | { kind: 'unknown'; why: string };

/**
 * The rule.
 *
 * Two quantities were conflated in the first sketch of this and they must not
 * be:
 *
 *   AMBIGUITY   whether a second vessel could be the answer -> compare
 *               positions, and abstain if more than one is in reach.
 *   ACCEPTANCE  whether THIS vessel is the answer -> a tight radius. A stale
 *               fix must never widen it. "Allure was 114 km away three hours
 *               ago" is not evidence of being aboard Allure.
 *
 * Three outcomes, not two. `unknown` is not a failure: absence of an answer is
 * not evidence of being ashore, and state.aboardShipKey documents at length why
 * that distinction is the one thing holding ship mode together.
 */
export function verdictFor(
  fix: DeviceFix,
  vessels: NearbyVessel[],
  roster: ShipRef[],
  now: number,
): PositionVerdict {
  const verdict = decide(fix, vessels, roster, now);
  lastVerdict = verdict;
  return verdict;
}

function decide(
  fix: DeviceFix,
  vessels: NearbyVessel[],
  roster: ShipRef[],
  now: number,
): PositionVerdict {
  const byImo = new Map(roster.filter((s) => s.imo).map((s) => [s.imo as string, s]));

  const inReach = vessels
    .map((v) => ({ v, km: distance(fix.lat, fix.lon, v.lat, v.lon) }))
    .filter((c) => c.km <= ACCEPT_KM);

  // Nothing floating anywhere near. This is the one case that can say "ashore"
  // outright: it is a positive observation, not a missing signal. A guest who
  // flew home is here, and so is a guest sitting in a hotel in Miami.
  if (inReach.length === 0) return { kind: 'ashore' };

  // More than one hull in reach and there is no honest way to choose. This is
  // the common case alongside: cruise berths are 100-400 m apart, an
  // Oasis-class hull is 360 m long, and walking aft moves the phone further
  // than the gap between two ships.
  if (inReach.length > 1) {
    const names = inReach.map((c) => c.v.name ?? c.v.imo).join(', ');
    return { kind: 'unknown', why: `${inReach.length} vessels within ${ACCEPT_KM} km: ${names}` };
  }

  const { v, km } = inReach[0];

  // One hull, but we do not know where it is well enough to say the guest is on
  // it. Being close to a three-hour-old position is a coincidence, not a fact.
  const slack = uncertaintyKm(v, now);
  if (slack > ACCEPT_KM) {
    return { kind: 'unknown', why: `${v.name ?? v.imo} fix too stale (${slack.toFixed(0)} km of drift)` };
  }

  // One hull, well located, and not one whose clock we can serve. A guest on a
  // Carnival ship gets nothing rather than the wrong ship's time.
  const ship = byImo.get(v.imo);
  if (!ship) return { kind: 'unknown', why: `${v.name ?? v.imo} is not in our roster` };

  return { kind: 'aboard', imo: v.imo, ship, name: v.name, km };
}

let lastVerdict: PositionVerdict | null = null;

/**
 * How often to ask, and why it is not one interval.
 *
 * watchPosition fires continuously — a fix a second while moving — and each
 * answer here is a request. The Worker caches per grid cell so upstream is
 * unaffected, but a browser tab left open should not spend the day asking a
 * question whose answer changes on the scale of a voyage.
 *
 * Ashore is the cheap case and the overwhelmingly common one: someone at home
 * is not about to be on a ship, and the ten-minute back-off costs a guest
 * nothing worse than boarding being noticed a few minutes late. Aboard and
 * unknown stay brisk, because those are the states that actually turn over —
 * an unknown alongside becomes a clean answer the moment the neighbour sails.
 */
const ASK_INTERVAL_MS = { ashore: 10 * 60_000, other: 60_000 };

/** Far enough to be somewhere else, and worth re-asking regardless of the clock. */
const MOVED_KM = 2;

let lastAsk: { at: number; lat: number; lon: number } | null = null;

export function shouldAsk(fix: DeviceFix): boolean {
  const now = Date.now();
  if (!lastAsk) { lastAsk = { at: now, lat: fix.lat, lon: fix.lon }; return true; }

  const wait = lastVerdict?.kind === 'ashore' ? ASK_INTERVAL_MS.ashore : ASK_INTERVAL_MS.other;
  const moved = distance(fix.lat, fix.lon, lastAsk.lat, lastAsk.lon);
  if (now - lastAsk.at < wait && moved < MOVED_KM) return false;

  lastAsk = { at: now, lat: fix.lat, lon: fix.lon };
  return true;
}

/** The last verdict, for the diagnostics page. Detection is invisible when it works. */
export function lastPositionVerdict(): PositionVerdict | null {
  return lastVerdict;
}
