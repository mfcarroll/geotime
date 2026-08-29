// src/cities.ts
//
// City search. The index is a separate static asset (public/cities.json, ~615 KB
// gzipped) fetched the first time someone opens the search, not part of the JS
// bundle — the app still starts instantly, and the service worker keeps the file
// afterwards. On iOS/Android it ships inside the app package, so there is no
// download at all.

import { getDisplayTimezoneName, isValidTimezone } from './time';
import { fold } from './utils';

export interface PlaceResult {
  /** IANA zone this place resolves to. */
  tzid: string;
  /** Name to store and show on the clock — the place, not the zone. */
  label: string;
  /** Main line: "Nelson, BC, Canada". */
  primary: string;
  /** Smaller line underneath: the zone the place actually keeps time by. */
  secondary: string;
  kind: 'city' | 'zone';
}

interface CityIndex {
  zones: string[];
  regions: string[];
  names: string[];
  /** Lowercased, diacritics stripped — what queries are matched against. */
  folded: string[];
  regionOf: Int32Array;
  zoneOf: Int32Array;
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

      if (regionOf.length !== names.length || zoneOf.length !== names.length) {
        throw new Error('city index arrays are out of step');
      }
      return { zones: raw.z, regions: raw.r, names, folded, regionOf, zoneOf };
    } catch (error) {
      // Zone-id search still works without this, so degrade rather than fail.
      console.warn('Could not load the city index:', error);
      return null;
    }
  })();
  return indexPromise;
}

function cityResult(index: CityIndex, i: number): PlaceResult {
  const name = index.names[i];
  const tzid = index.zones[index.zoneOf[i]];
  const zoneName = getDisplayTimezoneName(tzid);
  return {
    tzid,
    label: name,
    primary: `${name}, ${index.regions[index.regionOf[i]]}`,
    // When the place *is* the zone's namesake, the zone name adds nothing —
    // show the identifier instead, which does.
    secondary: fold(zoneName) === fold(name) ? tzid : zoneName,
    kind: 'city',
  };
}

function zoneResult(tzid: string): PlaceResult {
  return {
    tzid,
    label: getDisplayTimezoneName(tzid),
    primary: getDisplayTimezoneName(tzid),
    secondary: tzid,
    kind: 'zone',
  };
}

/**
 * Ranked matches for a query.
 *
 * Zone ids are searched from `zoneIds` (every zone on the map) and cities from
 * the downloaded index, so a zone with no town over the population floor —
 * America/Creston — stays findable even before the index loads.
 */
export function searchPlaces(
  query: string,
  zoneIds: string[],
  index: CityIndex | null,
  limit = 8
): PlaceResult[] {
  const q = fold(query.trim());
  if (!q) return [];

  // Whole-string equality, then prefix, then anywhere. Within a tier the index
  // is already population-ordered, so first-found is the best answer.
  const cityExact: PlaceResult[] = [];
  const cityPrefix: PlaceResult[] = [];
  const cityContains: PlaceResult[] = [];
  const zoneExact: PlaceResult[] = [];
  const zonePrefix: PlaceResult[] = [];
  const zoneContains: PlaceResult[] = [];

  for (const tzid of zoneIds) {
    const segment = fold(getDisplayTimezoneName(tzid));
    const full = fold(tzid);
    if (segment === q) zoneExact.push(zoneResult(tzid));
    else if (segment.startsWith(q) || full.startsWith(q)) zonePrefix.push(zoneResult(tzid));
    else if (full.includes(q)) zoneContains.push(zoneResult(tzid));
  }

  if (index) {
    const { folded } = index;
    for (let i = 0; i < folded.length; i++) {
      const name = folded[i];
      // Cheap rejection first: most entries fail this.
      if (!name.includes(q)) continue;
      if (name === q) cityExact.push(cityResult(index, i));
      else if (name.startsWith(q)) cityPrefix.push(cityResult(index, i));
      else cityContains.push(cityResult(index, i));
      if (cityExact.length + cityPrefix.length >= limit * 4) break;
    }
  }

  const seen = new Set<string>();
  const results: PlaceResult[] = [];
  // Cities ahead of zones within each tier. A zone named after its city
  // ("Creston") collides with the city itself, and the city row is the better
  // one to keep — it says where the place is.
  const ordered = [...cityExact, ...zoneExact, ...cityPrefix, ...zonePrefix,
                   ...cityContains, ...zoneContains];
  for (const candidate of ordered) {
    // One row per place: the same city name can repeat across regions, but an
    // identical name *and* zone is a duplicate as far as the user is concerned.
    const key = `${candidate.tzid}|${candidate.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(candidate);
    if (results.length >= limit) break;
  }
  return results;
}

/** A raw IANA id typed in full, for anything the index misses. */
export function zoneFromRawInput(query: string): PlaceResult | null {
  const trimmed = query.trim();
  return trimmed.includes('/') && isValidTimezone(trimmed) ? zoneResult(trimmed) : null;
}
