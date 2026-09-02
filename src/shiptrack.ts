// src/shiptrack.ts
//
// Where a ship is, where it has been, and where it is going. The companion to
// src/rccl.ts, which answers what time it is there.
//
// Two things about the shape of this module follow from the data rather than
// from taste:
//
// 1. Position is fetched for the WHOLE FLEET in one request, not per ship. The
//    upstream feed is global and costs the same whether you want one vessel or
//    forty, so a shared fetch with a shared cache is both cheaper for us and
//    politer to a third party we are a guest of. Per-ship detail (track, route,
//    ports) is genuinely per-ship, and is only fetched for the selection.
//
// 2. Everything here is best-effort and expires. A ship's *clock* must be right
//    or it is worse than absent, which is why src/rccl.ts is careful about
//    staleness; a ship's *position* is allowed to be an hour old as long as it
//    says so. So this module keeps a cache with ages rather than a cache with
//    guarantees, and every getter can answer "nothing yet".
//
// Unlike ship time there is no native counterpart. The widget shows no map, so
// nothing here is duplicated in Swift or Java — which is the single biggest
// reason this feature is smaller than the last one.

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { shipImo } from './ships';

/**
 * The Worker. Every platform uses it — see the module comment on
 * workers/ship-track/src/index.ts for why native does not go direct here even
 * though it must for ship time.
 *
 * The default must match the one in vite.config.js's workerCsp(), or the CSP
 * will refuse the very request the client is about to make.
 */
const BASE: string =
  import.meta.env.VITE_SHIP_TRACK ?? 'https://geotime-ship-track.matthew-carroll.workers.dev';

/** One vessel's live position, as the fleet feed reports it. */
export interface ShipFix {
  imo: string;
  lon: number;
  lat: number;
  /** Speed over ground in knots. 0 means alongside or at anchor. */
  sog: number | null;
  /** Course over ground in degrees — what the marker is rotated by. */
  cog: number | null;
  /** Heading in degrees, already filtered of the 511 "unavailable" sentinel. */
  heading: number | null;
  destination: string | null;
  /** Unix seconds of the AIS fix. Ages range from a minute to several hours. */
  tst: number | null;
}

/** A port call on the planned route. */
export interface ShipPort {
  lon: number;
  lat: number;
  /**
   * Parsed from the upstream itinerary, or null when that parse found nothing —
   * in which case the caller names it from the bundled city index instead. Never
   * assume this is present: it comes from scraping someone's markup.
   */
  name: string | null;
  /** 'itinerary' when parsed upstream; 'geocoded' once we have named it here. */
  nameSource: 'itinerary' | 'geocoded' | null;
  /** Voyage day, 1-based, skipping days at sea. */
  day: number | null;
  depart: string | null;
}

/** Track, route and voyage framing for one vessel. */
export interface ShipVoyage {
  imo: string;
  destination: string | null;
  eta: string | null;
  voyage: {
    name: string | null;
    startDate: string | null;
    endDate: string | null;
    days: string | null;
  };
  /**
   * Past breadcrumbs as `[lon, lat]`, oldest first, ending near the current
   * position. Normalised to the same order as `route` by the Worker; upstream
   * gives these two in opposite orders.
   *
   * NOT clipped to the current voyage — it is a rolling window that reaches back
   * into previous sailings, sometimes by more than a week. See `voyageTrack()`.
   */
  track: Array<[number, number]>;
  /** Planned route as `[lon, lat]`. Fixed for the voyage. */
  route: Array<[number, number]>;
  ports: ShipPort[];
  /** `[minLat, minLon, maxLat, maxLon]` — what the map fits to on selection. */
  extent: [number, number, number, number] | null;
  /**
   * True when some of `track` is history we kept rather than history upstream
   * just sent. Diagnostics only — the points are equally real either way.
   */
  trackRetained?: boolean;
}

/** Anything cached carries when it was fetched, because age is displayed. */
interface Cached<T> {
  at: number;
  value: T;
}

const FLEET_CACHE_KEY = 'shipFleetFix';
const VOYAGE_CACHE_KEY = 'shipVoyages';

/**
 * How long a cached position is reused before asking again.
 *
 * Matched to the Worker's own 60 s cache: asking more often than that cannot
 * produce a newer answer, it just costs a round trip.
 */
const FLEET_MAX_AGE_MS = 60 * 1000;

/** Ditto, matched to the Worker's detail TTL. */
const VOYAGE_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * How many ships' voyages to keep.
 *
 * Each holds a track of up to MAX_RETAINED_TRACK points, so this is the bound
 * that actually matters for storage: six of them is a couple of hundred
 * kilobytes at worst, against a localStorage budget this app shares with a
 * 1.8 MB city index. Six is also comfortably more than anyone keeps on a clock
 * list, so in practice nothing is ever evicted — this only stops a user who has
 * browsed many ships from filling the quota and silently losing all of it.
 */
const MAX_CACHED_VOYAGES = 6;

/**
 * Beyond this, a fix is withheld rather than drawn.
 *
 * A day-old position is not a stale fact, it is a wrong one — a ship makes
 * several hundred miles in that time, so the marker would sit in open water
 * nowhere near the vessel. Better to show nothing and say why.
 */
export const FIX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Past this, the marker is drawn dimmed: still useful, no longer current. */
export const FIX_STALE_AGE_MS = 60 * 60 * 1000;

let fleet: Cached<Map<string, ShipFix>> | null = null;
const voyages = new Map<string, Cached<ShipVoyage>>();

/** True when the map layers can work at all. */
export function shipTrackAvailable(): boolean {
  return !!BASE;
}

/**
 * One GET, JSON or null. Never throws.
 *
 * Uses CapacitorHttp on native for the same reason src/rccl.ts does — it
 * bypasses the WebView's CORS enforcement, which the origin gives it no way to
 * satisfy. On the web the Worker's own CORS headers make a plain fetch work.
 */
async function get<T>(path: string): Promise<T | null> {
  const url = `${BASE}${path}`;
  try {
    if (Capacitor.isNativePlatform()) {
      const response = await CapacitorHttp.get({ url, headers: { accept: 'application/json' } });
      if (response.status !== 200) return null;
      // CapacitorHttp parses JSON responses itself, but hands back a string when
      // the content type surprises it.
      return typeof response.data === 'string'
        ? (JSON.parse(response.data) as T)
        : (response.data as T);
    }
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    // Offline, blocked, or aboard a ship — all the same to the caller, which
    // falls back to whatever it last knew.
    return null;
  }
}

function readCache<T>(key: string): Cached<T> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.at === 'number' && parsed.value != null ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), value }));
  } catch {
    // A full quota must not break the map. The in-memory copy still works for
    // this session; only persistence across launches is lost.
  }
}

/** Restores the last known positions and voyages, so a cold start can draw. */
export function initShipTrack(): void {
  const storedFleet = readCache<Array<[string, ShipFix]>>(FLEET_CACHE_KEY);
  if (storedFleet && Array.isArray(storedFleet.value)) {
    fleet = { at: storedFleet.at, value: new Map(storedFleet.value) };
  }

  const storedVoyages = readCache<Record<string, Cached<ShipVoyage>>>(VOYAGE_CACHE_KEY);
  if (storedVoyages?.value && typeof storedVoyages.value === 'object') {
    for (const [imo, entry] of Object.entries(storedVoyages.value)) {
      if (entry?.value?.imo) voyages.set(imo, entry);
    }
  }
}

/**
 * Positions for the whole fleet, keyed by IMO.
 *
 * Serves the cached copy while it is younger than the Worker's own TTL, so a
 * screenful of ships costs one request rather than one per row. On failure the
 * previous copy is kept — never cleared — because a position we cannot refresh
 * is still where the ship was, and the caller decides whether that is too old to
 * draw.
 */
export async function fleetFixes(force = false): Promise<Map<string, ShipFix>> {
  const fresh = fleet && Date.now() - fleet.at < FLEET_MAX_AGE_MS;
  if (fresh && !force) return fleet!.value;

  const payload = await get<{ ships: ShipFix[] }>('/fleet');
  if (!payload?.ships?.length) return fleet?.value ?? new Map();

  const byImo = new Map(payload.ships.map((ship) => [ship.imo, ship]));
  fleet = { at: Date.now(), value: byImo };
  writeCache(FLEET_CACHE_KEY, [...byImo]);
  return byImo;
}

/** The last known fix for one ship, by clock key ("R/ST"), or null. */
export function fixForShip(shipKey: string): ShipFix | null {
  const imo = shipImo(shipKey);
  if (!imo || !fleet) return null;
  return fleet.value.get(imo) ?? null;
}

/** Age of the fleet snapshot in ms, or null if we have never had one. */
export function fleetAge(): number | null {
  return fleet ? Date.now() - fleet.at : null;
}

/**
 * Track, route and ports for one ship, by clock key.
 *
 * Only called for a selection, so it is per-ship by design — drawing 44
 * overlapping tracks would be noise even if it were free.
 */
export async function voyageForShip(shipKey: string, force = false): Promise<ShipVoyage | null> {
  const imo = shipImo(shipKey);
  if (!imo) return null;   // no identity, no map layer — see build-ship-index.mjs

  const cached = voyages.get(imo);
  if (cached && !force && Date.now() - cached.at < VOYAGE_MAX_AGE_MS) return cached.value;

  const payload = await get<ShipVoyage>(`/ship/${imo}`);
  if (!payload?.imo) return cached?.value ?? null;

  // Never let a successful response with no track erase a track we already had.
  const merged = withRetainedTrack(payload, cached?.value);
  voyages.set(imo, { at: Date.now(), value: merged });
  pruneVoyages();
  writeCache(VOYAGE_CACHE_KEY, Object.fromEntries(voyages));
  return merged;
}

/**
 * Drops the least recently fetched voyages beyond the cap.
 *
 * Least *recently fetched* rather than oldest data, because a voyage is
 * re-fetched whenever its ship is selected — so recency of fetch is recency of
 * interest, and the ships someone actually watches keep their history.
 */
function pruneVoyages(): void {
  if (voyages.size <= MAX_CACHED_VOYAGES) return;
  const byAge = [...voyages.entries()].sort((a, b) => b[1].at - a[1].at);
  for (const [imo] of byAge.slice(MAX_CACHED_VOYAGES)) voyages.delete(imo);
}

/**
 * The part of the track belonging to the voyage in progress.
 *
 * The upstream window is a fixed 720 points regardless of when the cruise
 * started, so on a ship mid-sailing it reaches back through the previous voyage
 * and sometimes the one before. Drawing it raw answers a question nobody asked.
 *
 * There are no timestamps on the points to clip by — only 15 of 720 carry a
 * label, and the rest are bare coordinates — so the clip is geometric: find
 * where the ship last left the embarkation port and keep everything after it.
 * That is exact for the round trips these itineraries almost always are, and
 * degrades to "slightly too much history" rather than to nothing when it is not.
 */
export function voyageTrack(voyage: ShipVoyage): Array<[number, number]> {
  const start = voyage.route[0];
  if (!start || voyage.track.length < 2) return voyage.track;

  // Within about 25 nm of the departure port counts as being there. Loose
  // enough to catch a track that never passes exactly through the marker,
  // tight enough not to match a different port on the same coast.
  const NEAR_DEGREES = 0.4;
  const near = (i: number) =>
    Math.abs(voyage.track[i][0] - start[0]) < NEAR_DEGREES &&
    Math.abs(voyage.track[i][1] - start[1]) < NEAR_DEGREES;

  // Contiguous stretches of "at the departure port". These itineraries are
  // overwhelmingly round trips, so the window typically holds several: the start
  // of each sailing, and — once the ship is home again — the end of one.
  const visits: Array<{ from: number; to: number }> = [];
  for (let i = 0; i < voyage.track.length; i++) {
    if (!near(i)) continue;
    const last = visits[visits.length - 1];
    if (last && i === last.to + 1) last.to = i;
    else visits.push({ from: i, to: i });
  }

  // Never near the start: a one-way or repositioning leg, or a route that does
  // not begin where the window does. The whole window is the best answer we have.
  if (visits.length === 0) return voyage.track;

  // Which visit is *this* voyage's departure? The last one — unless the ship is
  // sitting at that port right now, in which case the last visit is the arrival
  // at the END of the voyage rather than a departure.
  //
  // Getting this wrong is not loud. Slicing from an arrival leaves a point or
  // two, which trips the short-track fallback below and quietly draws the ENTIRE
  // rolling window instead — measured at 732 points spanning two prior sailings,
  // where the voyage itself is 131. So the failure is a track that looks
  // plausible and is mostly somebody else's cruise, and it only appears on
  // turnaround day.
  const ARRIVED_WITHIN = 3;   // points, ~90 min at this sampling rate
  const lastVisit = visits[visits.length - 1];
  const stillThere = lastVisit.to >= voyage.track.length - 1 - ARRIVED_WITHIN;
  const departure = stillThere && visits.length > 1
    ? visits[visits.length - 2]
    : lastVisit;

  // Slice from the last point of the visit — the moment it left, not the moment
  // it arrived — so a long stay alongside is not drawn as part of the passage.
  const clipped = voyage.track.slice(departure.to);

  // Embarkation day: the ship has barely moved, and a two-point line looks like
  // a rendering bug rather than a short track.
  return clipped.length >= 2 ? clipped : voyage.track;
}

/**
 * How many track points we are willing to remember for one voyage.
 *
 * The upstream window is 720. A fortnight-long cruise reporting every half hour
 * exceeds that, so retaining more than the window is the point — but not
 * without a bound, since this ends up in localStorage.
 */
const MAX_RETAINED_TRACK = 2000;

/** Two fixes are the same fix if they agree to about a decimetre. */
function samePoint(a: [number, number], b: [number, number]): boolean {
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
}

/**
 * Length of the overlap between the end of `retained` and the start of `fresh`.
 *
 * The two arrays are windows onto the *same* underlying sequence of fixes, so
 * the join can be found exactly rather than estimated: the largest k where the
 * last k of one equals the first k of the other. That matters because the
 * geometric alternatives are both wrong on these itineraries. Matching the
 * nearest point discards the whole voyage when a round trip brings the ship back
 * past its start; matching the last point within a radius overshoots whenever
 * the vessel is barely moving, and duplicates the overlap. Neither can tell
 * "here again" from "here still", and the identical coordinates can.
 */
function overlapLength(
  retained: Array<[number, number]>,
  fresh: Array<[number, number]>
): number {
  for (let k = Math.min(retained.length, fresh.length); k > 0; k--) {
    let matched = true;
    for (let i = 0; i < k; i++) {
      if (!samePoint(retained[retained.length - k + i], fresh[i])) {
        matched = false;
        break;
      }
    }
    if (matched) return k;
  }
  return 0;
}

/**
 * Combines the history we already had with the window upstream just sent.
 *
 * Three things make this worth doing rather than simply taking the fresh copy:
 *
 * 1. The track comes back EMPTY intermittently — observed on a vessel that had
 *    720 points hours earlier, while its route and position kept working. Taking
 *    the fresh copy would erase good history on a response that was, by every
 *    other measure, a success.
 * 2. The window is a fixed 720 points, so on a long cruise the earliest part of
 *    the voyage falls off the end. Those points are still this voyage's history.
 * 3. The wake is the one layer that cannot be re-derived later. A position we
 *    miss is gone; a route we can always re-ask for.
 */
export function mergeTrack(
  retained: Array<[number, number]>,
  fresh: Array<[number, number]>
): Array<[number, number]> {
  if (fresh.length === 0) return retained;
  if (retained.length === 0) return fresh;

  // No overlap means the window has slid entirely past our copy, so the fresh
  // points belong after everything we hold rather than instead of it.
  const overlap = overlapLength(retained, fresh);
  const merged = [...retained, ...fresh.slice(overlap)];

  // Keep the newest, which is the part the map draws up to the ship.
  return merged.length > MAX_RETAINED_TRACK
    ? merged.slice(merged.length - MAX_RETAINED_TRACK)
    : merged;
}

/**
 * The fresh voyage, carrying whatever history is worth keeping from the old one.
 *
 * Guarded on the voyage being the same sailing. A retained track from the
 * previous cruise would draw somebody else's wake under this one's route, which
 * is precisely the confusion clipping the track was meant to remove.
 */
function withRetainedTrack(fresh: ShipVoyage, previous: ShipVoyage | undefined): ShipVoyage {
  if (!previous || previous.track.length === 0) return fresh;
  if (previous.voyage.startDate !== fresh.voyage.startDate) return fresh;

  const track = mergeTrack(previous.track, fresh.track);
  if (track.length === fresh.track.length) return fresh;
  return { ...fresh, track, trackRetained: true };
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
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
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
 */
export function routeAhead(
  voyage: ShipVoyage,
  position: [number, number] | null
): Array<[number, number]> {
  const route = voyage.route;
  if (route.length < 2) return route;

  // Departure times are stated in each port's own local time with no zone. That
  // is fine here: this only has to decide which ports are behind us, and being
  // a few hours out cannot change the answer on a schedule measured in days.
  const now = Date.now();
  let floor = 0;
  for (const port of voyage.ports) {
    if (!port.depart) continue;   // the last call has no departure
    const departed = Date.parse(port.depart.replace(' ', 'T'));
    if (!Number.isFinite(departed) || departed > now) continue;
    floor = Math.max(floor, nearestIndex(route, [port.lon, port.lat], 0));
  }

  if (!position) return route.slice(floor);

  const at = nearestIndex(route, position, floor);
  // Begins at the vessel rather than at the nearest vertex: on a 10-point
  // polyline across an ocean, that vertex can be a hundred miles away, and the
  // gap between the ship and its own route reads as a rendering fault.
  return [position, ...route.slice(at)];
}

/**
 * Degrees to rotate a ship marker by, or null when the feed has neither value.
 *
 * Heading before course, because the marker is a picture of the hull and heading
 * is the direction the hull is pointing. Course over ground is where it is
 * *going*, which differs in a current or a crosswind and differs completely at
 * anchor, where a vessel lies to the tide while making no way at all.
 */
export function markerBearing(fix: ShipFix): number | null {
  return fix.heading ?? fix.cog;
}
