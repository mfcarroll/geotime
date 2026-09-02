// src/cities.ts
//
// City search. The index is a separate static asset (public/cities.json, ~615 KB
// gzipped) fetched the first time someone opens the search, not part of the JS
// bundle — the app still starts instantly, and the service worker keeps the file
// afterwards. On iOS/Android it ships inside the app package, so there is no
// download at all.

import { fold, distance, getDisplayTimezoneName, isValidTimezone } from './utils';
import { matchShipTiers, shipKey, type ShipRef } from './ships';

interface PlaceBase {
  /** Name to store and show on the clock — the place, not the zone. */
  label: string;
  /** Main line: "Nelson, BC, Canada". */
  primary: string;
  /** Smaller line underneath: the zone the place actually keeps time by. */
  secondary: string;
}

/** A zone id, searched straight from the map data. */
export interface ZonePlace extends PlaceBase {
  kind: 'zone';
  /** IANA zone this place resolves to. */
  tzid: string;
}

/** A town or city, resolving to the zone it keeps time by. */
export interface CityPlace extends PlaceBase {
  kind: 'city';
  /** IANA zone this place resolves to. */
  tzid: string;
}

/**
 * A cruise ship, which has no zone at all — its clock is set by the crew.
 *
 * A union rather than an optional `tzid` because the difference is real and
 * callers must handle it: there is nothing sensible to put in a zone field for a
 * vessel, and a placeholder would be the first step back towards synthetic zone
 * ids. TypeScript narrows on `kind`, so the compiler enforces the split.
 */
export interface ShipPlace extends PlaceBase {
  kind: 'ship';
  ship: ShipRef;
}

export type PlaceResult = ZonePlace | CityPlace | ShipPlace;

interface CityIndex {
  zones: string[];
  regions: string[];
  names: string[];
  /** Lowercased, diacritics stripped — what queries are matched against. */
  folded: string[];
  regionOf: Int32Array;
  zoneOf: Int32Array;
  /** Region centroids, [lat, lon] pairs parallel to `regions`. */
  regionAt: Float64Array;
  /** City positions, [lat, lon] pairs parallel to `names`. */
  cityAt: Float64Array;
  /** Centroid of each zone's largest city's region, parallel to `zones`. */
  zoneAt: Float64Array;
}

export interface Origin {
  lat: number;
  lon: number;
}

let indexPromise: Promise<CityIndex | null> | null = null;

/** Idempotent; concurrent callers share one fetch. */
export function loadCityIndex(): Promise<CityIndex | null> {
  indexPromise ??= (async () => {
    try {
      const response = await fetch('cities.json');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const raw = await response.json();

      const names: string[] = raw.n.split('\n');
      const folded = names.map(fold);
      const regionOf = Int32Array.from(raw.ri.split(','), Number);
      const zoneOf = Int32Array.from(raw.zi.split(','), Number);

      const regionAt = Float64Array.from(raw.ra.split(','), (n: string) => Number(n) / 100);

      // Positions are stored as hundredths-of-a-degree offsets from the city's
      // region centroid; small numbers gzip far better than absolute coordinates.
      const dLat = raw.la.split(',');
      const dLon = raw.lo.split(',');
      const cityAt = new Float64Array(names.length * 2);
      for (let i = 0; i < names.length; i++) {
        const r = regionOf[i] * 2;
        cityAt[i * 2] = regionAt[r] + Number(dLat[i]) / 100;
        cityAt[i * 2 + 1] = regionAt[r + 1] + Number(dLon[i]) / 100;
      }

      if (regionOf.length !== names.length || zoneOf.length !== names.length) {
        throw new Error('city index arrays are out of step');
      }
      if (regionAt.length !== raw.r.length * 2) {
        throw new Error('region centroids are out of step with the region list');
      }
      if (dLat.length !== names.length || dLon.length !== names.length) {
        throw new Error('city coordinates are out of step with the name list');
      }

      // A zone borrows the centroid of its largest city's region. Cities are in
      // population order, so the first one seen for a zone is that city.
      const zoneAt = new Float64Array(raw.z.length * 2).fill(NaN);
      for (let i = 0; i < names.length; i++) {
        const z = zoneOf[i] * 2;
        if (!Number.isNaN(zoneAt[z])) continue;
        zoneAt[z] = regionAt[regionOf[i] * 2];
        zoneAt[z + 1] = regionAt[regionOf[i] * 2 + 1];
      }

      return { zones: raw.z, regions: raw.r, names, folded, regionOf, zoneOf, regionAt, cityAt, zoneAt };
    } catch (error) {
      // Zone-id search still works without this, so degrade rather than fail.
      console.warn('Could not load the city index:', error);
      return null;
    }
  })();
  return indexPromise;
}

// The second line is always the IANA id, on every row and for both kinds of
// result. It used to show the zone's *city name* ("Vancouver") and swap to the
// id only when that would have repeated the place name — so the same slot meant
// "the zone's name" on one row and "the zone's identifier" on the next, which
// read as arbitrary. One meaning throughout is worth a little more text.
function cityResult(index: CityIndex, i: number): CityPlace {
  const name = index.names[i];
  return {
    tzid: index.zones[index.zoneOf[i]],
    label: name,
    primary: `${name}, ${index.regions[index.regionOf[i]]}`,
    secondary: index.zones[index.zoneOf[i]],
    kind: 'city',
  };
}

function zoneResult(tzid: string): ZonePlace {
  return {
    tzid,
    label: getDisplayTimezoneName(tzid),
    primary: getDisplayTimezoneName(tzid),
    secondary: tzid,
    kind: 'zone',
  };
}

/**
 * The primary line is the full name people search for — "Celebrity Apex" — while
 * `label` is the short one a clock row shows. That mirrors how a city behaves:
 * the dropdown says "Nelson, BC, Canada" and the row says "Nelson".
 */
function shipResult(ship: ShipRef): ShipPlace {
  return {
    label: ship.short,
    primary: ship.name,
    secondary: ship.brand === 'C' ? 'Celebrity Cruises' : 'Royal Caribbean',
    kind: 'ship',
    ship,
  };
}

/** One row per place. Ships have no zone, so they key on brand and code. */
function resultKey(result: PlaceResult): string {
  return result.kind === 'ship'
    ? `ship:${shipKey(result.ship)}`
    : `${result.tzid}|${result.label}`;
}

/**
 * Distance from the origin to each region's centroid.
 *
 * Cities share a region, so this is 3,190 distance calculations per search
 * instead of one per match — and the result is cached, because the origin only
 * changes when the user physically moves.
 */
let distanceCache: { origin: Origin; km: Float64Array } | null = null;

function regionDistances(index: CityIndex, origin: Origin): Float64Array {
  if (distanceCache && distanceCache.origin.lat === origin.lat
      && distanceCache.origin.lon === origin.lon) {
    return distanceCache.km;
  }
  const { regionAt } = index;
  const km = new Float64Array(regionAt.length / 2);
  for (let r = 0; r < km.length; r++) {
    km[r] = distance(origin.lat, origin.lon, regionAt[r * 2], regionAt[r * 2 + 1]);
  }
  distanceCache = { origin, km };
  return km;
}

/** The `k` lowest-scoring entries, in order. Linear, with no full sort. */
function bestBy(items: number[], k: number, score: (item: number) => number): number[] {
  if (items.length <= k) {
    return items.map((i) => [i, score(i)] as const)
      .sort((a, b) => a[1] - b[1]).map(([i]) => i);
  }
  const top: { item: number; score: number }[] = [];
  let worst = Infinity;
  for (const item of items) {
    const s = score(item);
    if (top.length === k && s >= worst) continue;
    let at = top.length;
    while (at > 0 && top[at - 1].score > s) at--;
    top.splice(at, 0, { item, score: s });
    if (top.length > k) top.pop();
    worst = top[top.length - 1].score;
  }
  return top.map((entry) => entry.item);
}

/**
 * How much a place's prominence is discounted by being far away.
 *
 * Both terms are log-scaled and weighted equally, which lands where it should:
 * searching "Nelson" from Nelson BC puts the local one first even though Nelson
 * NZ is five times larger, while searching "London" from BC still puts London
 * England ahead of London Ontario — 8.9 million people outweighs 4,500 km.
 * Distance in km; lower score sorts first.
 */
function rankScore(populationRank: number, km: number): number {
  return Math.log10(1 + populationRank) + Math.log10(1 + km / 50);
}

/**
 * Ranked matches for a query.
 *
 * Zone ids are searched from `zoneIds` (every zone on the map) and cities from
 * the downloaded index, so a zone with no town over the population floor —
 * America/Creston — stays findable even before the index loads.
 *
 * `origin` is the user's position when known. Without it, results fall back to
 * pure prominence, which is the order the index is already stored in.
 */
export function searchPlaces(
  query: string,
  zoneIds: string[],
  index: CityIndex | null,
  origin: Origin | null = null,
  ships: ShipRef[] = [],
  limit = 8
): PlaceResult[] {
  const q = fold(query.trim());
  if (!q) return [];

  // Whole-string equality, then prefix, then anywhere. Cities are collected as
  // indices and only turned into results once the tier has been ranked — the
  // whole list has to be scanned, because a nearby small town can outrank a
  // distant large one and an early cut-off would never see it.
  const cityTiers: number[][] = [[], [], []];
  const zoneTiers: ZonePlace[][] = [[], [], []];
  const shipTiers = matchShipTiers(query, ships);

  for (const tzid of zoneIds) {
    const segment = fold(getDisplayTimezoneName(tzid));
    const full = fold(tzid);
    if (segment === q) zoneTiers[0].push(zoneResult(tzid));
    else if (segment.startsWith(q) || full.startsWith(q)) zoneTiers[1].push(zoneResult(tzid));
    else if (full.includes(q)) zoneTiers[2].push(zoneResult(tzid));
  }

  if (index) {
    const { folded } = index;
    for (let i = 0; i < folded.length; i++) {
      const name = folded[i];
      if (!name.includes(q)) continue;               // cheap rejection first
      if (name === q) cityTiers[0].push(i);
      else if (name.startsWith(q)) cityTiers[1].push(i);
      else cityTiers[2].push(i);
    }
  }

  if (origin && index) {
    const { regionOf, zones, zoneAt } = index;
    const regionKm = regionDistances(index, origin);
    const zoneIndexOf = new Map(zones.map((z, i) => [z, i]));

    // Top-k selection, not a sort: a one-letter query matches tens of thousands
    // of cities and only eight are ever drawn, so sorting them all is wasted.
    for (let t = 0; t < cityTiers.length; t++) {
      cityTiers[t] = bestBy(cityTiers[t], limit, (i) => rankScore(i, regionKm[regionOf[i]]));
    }

    // Zones only need ordering among themselves, so distance alone decides.
    for (const tier of zoneTiers) {
      const scored = new Map(tier.map((r) => {
        const z = (zoneIndexOf.get(r.tzid) ?? -1) * 2;
        return [r, z < 0 || Number.isNaN(zoneAt[z])
          ? Infinity
          : distance(origin.lat, origin.lon, zoneAt[z], zoneAt[z + 1])];
      }));
      tier.sort((a, b) => scored.get(a)! - scored.get(b)!);
    }
  }

  const seen = new Set<string>();
  const results: PlaceResult[] = [];
  // Cities ahead of zones within each tier. A zone named after its city
  // ("Creston") collides with the city itself, and the city row is the better
  // one to keep — it says where the place is.
  //
  // Ships lead their tier only on an exact match, and follow the cities
  // otherwise. Typing "independence" in full is a specific enough act to put
  // the vessel first; typing "inde" is not. Either way both appear, because
  // these names genuinely collide — "Independence" is also six real towns, one
  // of them 120,000 people — and the ship icon is what resolves it, not the
  // ordering. Nothing is ever silently picked.
  for (let tier = 0; tier < 3 && results.length < limit; tier++) {
    // Only the leading slice is materialised — a broad query like "san" matches
    // thousands, and building a result object for each would be wasted work.
    const ranked = cityTiers[tier].slice(0, limit).map((i) => cityResult(index!, i));
    const shipsHere = shipTiers[tier].map(shipResult);
    const ordered: PlaceResult[] = tier === 0
      ? [...shipsHere, ...ranked, ...zoneTiers[tier]]
      : [...ranked, ...shipsHere, ...zoneTiers[tier]];

    for (const candidate of ordered) {
      // One row per place: the same city name can repeat across regions, but an
      // identical name *and* zone is a duplicate as far as the user is concerned.
      const key = resultKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(candidate);
      if (results.length >= limit) break;
    }
  }

  // A matched ship is never invisible. Ordering ships below cities on a partial
  // match was meant to express a preference, not to drop them: "inde" matches
  // seven towns before Independence of the Seas, and one more town would have
  // pushed the vessel off the end of the list entirely. Someone typing part of a
  // ship's name would then see no ship at all and reasonably conclude the app
  // does not know it. So if any ship matched and none survived the cut, the last
  // row gives way to the best-matching one.
  if (!results.some((r) => r.kind === 'ship')) {
    const bestShip = shipTiers.flat()[0];
    if (bestShip) {
      if (results.length >= limit) results.pop();
      results.push(shipResult(bestShip));
    }
  }

  return results;
}

export interface NearbyPlace {
  /** "Nelson" */
  name: string;
  /** "BC, Canada" */
  region: string;
  km: number;
}

/**
 * How far out of its way the lookup will go for a more recognisable place,
 * in km per tenfold increase in population rank.
 *
 * Purely nearest is worse than it sounds: GeoNames puts Surrey's centroid 9 km
 * from Surrey city hall while the neighbourhood of Fleetwood sits 4 km away, so
 * the literal answer names a place most people there wouldn't use. At 6 the
 * larger, better-known name wins that trade without swallowing genuine small
 * towns — Nelson, Squamish and Creston still name themselves while standing in
 * them. It does mean Brooklyn reports as New York City.
 */
const PROMINENCE_KM_PER_DECADE = 6;

/**
 * The nearest town to `origin` that keeps the same time.
 *
 * Restricted to `tzid` on purpose: naming a town just across a timezone
 * boundary would put a place on the Local Time card that isn't on local time.
 * In north-west Arizona the nearest town outright is Moapa Valley, Nevada, an
 * hour behind — the answer has to be New Kingman-Butler instead.
 *
 * Returns null past `maxKm`, and for zones with no town at all, so callers fall
 * back to naming the zone itself. Every zone that has any town in GeoNames
 * contributes its largest one regardless of size, so Dawson and Cambridge Bay
 * still answer; 26 zones (Adak, Thule, Resolute, ...) genuinely have none.
 */
export function nearestPlace(
  index: CityIndex | null,
  origin: Origin,
  tzid: string,
  maxKm = 150
): NearbyPlace | null {
  if (!index) return null;
  const zoneIdx = index.zones.indexOf(tzid);
  if (zoneIdx < 0) return null;

  const { zoneOf, cityAt } = index;
  let bestIdx = -1;
  let bestKm = Infinity;
  let bestScore = Infinity;
  for (let i = 0; i < zoneOf.length; i++) {
    if (zoneOf[i] !== zoneIdx) continue;
    const km = distance(origin.lat, origin.lon, cityAt[i * 2], cityAt[i * 2 + 1]);
    if (km > maxKm) continue;
    // Index order is population order, so i is the prominence rank.
    const score = km + PROMINENCE_KM_PER_DECADE * Math.log10(1 + i);
    if (score < bestScore) { bestScore = score; bestKm = km; bestIdx = i; }
  }

  if (bestIdx < 0) return null;
  return {
    name: index.names[bestIdx],
    region: index.regions[index.regionOf[bestIdx]],
    km: bestKm,
  };
}

/** A raw IANA id typed in full, for anything the index misses. */
export function zoneFromRawInput(query: string): ZonePlace | null {
  const trimmed = query.trim();
  return trimmed.includes('/') && isValidTimezone(trimmed) ? zoneResult(trimmed) : null;
}
