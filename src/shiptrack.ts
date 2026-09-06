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
import { voyageSlice } from './wake';
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
   *
   * Not a rare state. Upstream serves no track at all while a ship is alongside,
   * so this is what is drawn at every port call — see retainedTrack in
   * workers/ship-track.
   */
  trackRetained?: boolean;
  /**
   * When a retained track was captured, epoch ms; absent on a fresh one.
   *
   * Carried purely so the age can be read off a response. Dating the last one by
   * hand took a fleet survey and a bearing on Cozumel.
   */
  trackAt?: number;
  /**
   * The only time information the track carries: roughly one point per calendar
   * day arrives labelled "06 Sep 00:30", the rest are bare coordinates. Indices
   * are into `track`, so the two are replaced together or not at all.
   *
   * Optional because an entry the Worker retained before it started keeping
   * these restores without them, and because a client on an older Worker will
   * simply not see the field. Absence costs the time half of the voyage clip
   * and nothing else.
   */
  dayMarks?: Array<{ i: number; label: string }>;
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
 * Each holds a track of up to the upstream cap of 720 points — call it 20 KB —
 * so this is the bound that actually matters for storage, against a localStorage
 * budget this app shares with a 1.8 MB city index. Six is comfortably more than
 * anyone keeps on a clock list, so in practice nothing is ever evicted; this only
 * stops someone who has browsed many ships from filling the quota and silently
 * losing all of it.
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

/**
 * Requests already on the wire, so concurrent callers share one.
 *
 * Not a micro-optimisation. Adding a ship both announces a list change and is
 * followed by the marker layer's own poll, and on a device the two land about
 * 50 ms apart — before either has populated the cache, so both went to the
 * network. Measured on Android: two identical /fleet requests, 47 ms apart, for
 * one user action. Against a third-party endpoint we are a guest of, halving
 * that is worth ten lines.
 */
let fleetInFlight: Promise<Map<string, ShipFix>> | null = null;
const voyagesInFlight = new Map<string, Promise<ShipVoyage | null>>();

/**
 * The itinerary already in hand for a ship, or null.
 *
 * Reads the cache and never fetches. Ports become searchable as itineraries
 * arrive for other reasons — selecting a ship, drawing her route — rather than
 * by asking for 44 itineraries the moment someone opens the search box. This
 * feed is not ours, and a search box that fanned out on focus would be the most
 * expensive thing in the app.
 *
 * Keyed by clock key and resolved through shipImo(), the same way
 * voyageForShip() resolves it. Reading `imo` off the stored ShipClock instead
 * looks equivalent and is not: a roster saved by an older build carries no IMO
 * for anybody, so the map would draw a route while the ports stayed invisible.
 */
export function cachedVoyageFor(shipKey: string): ShipVoyage | null {
  const imo = shipImo(shipKey);
  if (!imo) return null;
  return voyages.get(imo)?.value ?? null;
}

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
/**
 * One vessel near a point, of any cruise line — including the ones we cannot
 * serve a clock for, which is the entire point of asking.
 */
export interface NearbyVessel {
  imo: string;
  name: string | null;
  line: string | null;
  lat: number;
  lon: number;
  /** Knots. 0 means alongside or at anchor. */
  sog: number | null;
  /** Unix SECONDS of the AIS fix, as upstream reports it. */
  tst: number | null;
}

/**
 * Every vessel within reach of a position.
 *
 * Not cached client-side on purpose. The Worker snaps the box to a grid and
 * caches per cell, so every guest aboard one ship shares a single upstream
 * response — caching again here would only add a second staleness to reason
 * about, and this is asked at most once a minute.
 *
 * Null on any failure, which the caller must read as "unknown", never as
 * "no vessels nearby".
 */
export async function nearbyVessels(lat: number, lon: number): Promise<NearbyVessel[] | null> {
  if (!shipTrackAvailable()) return null;
  const path = `/nearby?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;
  const payload = await get<{ vessels?: NearbyVessel[] }>(path);
  if (!payload || !Array.isArray(payload.vessels)) return null;
  return payload.vessels.filter(
    (v) => typeof v?.imo === 'string' && Number.isFinite(v?.lat) && Number.isFinite(v?.lon),
  );
}

export function fleetFixes(force = false): Promise<Map<string, ShipFix>> {
  const fresh = fleet && Date.now() - fleet.at < FLEET_MAX_AGE_MS;
  if (fresh && !force) return Promise.resolve(fleet!.value);
  if (fleetInFlight) return fleetInFlight;

  fleetInFlight = (async () => {
    const payload = await get<{ ships: ShipFix[] }>('/fleet');
    if (!payload?.ships?.length) return fleet?.value ?? new Map<string, ShipFix>();

    const byImo = new Map(payload.ships.map((ship) => [ship.imo, ship]));
    fleet = { at: Date.now(), value: byImo };
    writeCache(FLEET_CACHE_KEY, [...byImo]);
    return byImo;
  })();

  // Cleared in a separate link so the value still reaches every caller.
  void fleetInFlight.finally(() => { fleetInFlight = null; });
  return fleetInFlight;
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
export function voyageForShip(shipKey: string, force = false): Promise<ShipVoyage | null> {
  const imo = shipImo(shipKey);
  if (!imo) return Promise.resolve(null);   // no identity, no map layer

  const cached = voyages.get(imo);
  if (cached && !force && Date.now() - cached.at < VOYAGE_MAX_AGE_MS) {
    return Promise.resolve(cached.value);
  }
  // The map fit and the chart both want this the moment a ship is selected.
  const already = voyagesInFlight.get(imo);
  if (already) return already;

  const request = fetchVoyage(imo, cached);
  voyagesInFlight.set(imo, request);
  void request.finally(() => { voyagesInFlight.delete(imo); });
  return request;
}

async function fetchVoyage(
  imo: string,
  cached: Cached<ShipVoyage> | undefined
): Promise<ShipVoyage | null> {
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
 * The arithmetic is in wake.ts so it can be tested; this is the adapter. See
 * voyageSlice for why it takes both the day labels and the geometry, and why
 * neither on its own gets turnaround day right.
 */
export function voyageTrack(voyage: ShipVoyage): Array<[number, number]> {
  return voyageSlice(
    voyage.track,
    voyage.route[0],
    voyage.dayMarks ?? [],
    voyage.voyage.startDate
  );
}


/**
 * The fresh voyage, keeping the old track when the new one is missing.
 *
 * The narrow rule, and it took real data to get here. Upstream drops the track
 * intermittently — observed on a vessel that had 720 points hours earlier while
 * its route and position kept working — so a response that is a success by every
 * other measure must not be allowed to erase history we already hold.
 *
 * What this deliberately does NOT do is merge the two. That was the first
 * attempt, splicing retained history onto the fresh window at their overlap, and
 * two real consecutive captures of the same ship disproved it: they are
 * index-aligned and differ in 274 of 720 points, sharing no exact run at all.
 * Upstream is not serving a sliding window that can be spliced — it re-decimates
 * the whole span to a 720-point cap on every request, so each response is
 * already a complete picture of the voyage at slightly different sampling.
 * Splicing them produced 1440 points: the same track drawn twice, once per
 * sampling.
 *
 * So anything non-empty from upstream is both complete and newer, and simply
 * wins. Only emptiness is a reason to look backwards.
 *
 * Guarded on the sailing, because a track kept across a voyage boundary would
 * draw somebody else's wake under this one's route — precisely the confusion
 * that clipping the track exists to remove.
 */
function withRetainedTrack(fresh: ShipVoyage, previous: ShipVoyage | undefined): ShipVoyage {
  if (fresh.track.length > 0) return fresh;
  if (!previous || previous.track.length === 0) return fresh;
  if (previous.voyage.startDate !== fresh.voyage.startDate) return fresh;

  return { ...fresh, track: previous.track, trackRetained: true };
}

/**
 * Under way or not.
 *
 * Not zero, because AIS reports a tenth of a knot of drift on a moored hull and
 * a hard zero would flicker between fixes. A null speed is not under way either
 * — unknown is not a claim.
 */
export const ALONGSIDE_KNOTS = 0.7;

/** True when her speed is a real speed and not a moored hull's drift. */
export function makingWay(fix: ShipFix): boolean {
  return fix.sog !== null && fix.sog > ALONGSIDE_KNOTS;
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
