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

  voyages.set(imo, { at: Date.now(), value: payload });
  writeCache(VOYAGE_CACHE_KEY, Object.fromEntries(voyages));
  return payload;
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

/** Degrees to rotate a ship marker by, or null when the feed has neither value. */
export function markerBearing(fix: ShipFix): number | null {
  return fix.cog ?? fix.heading;
}
