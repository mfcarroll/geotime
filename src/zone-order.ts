// src/zone-order.ts
//
// The order the boundary features get tested in when resolving a coordinate.
//
// Three places on Earth are inside two IANA zones at once. They are not data
// errors and they are not artefacts of simplification — they are in the
// unsimplified timezone-boundary-builder output too, because two authorities
// claim the same ground and tzdb carries a zone for each:
//
//     Asia/Urumqi   inside Asia/Shanghai    Xinjiang, 100% contained
//     Asia/Thimphu  meets  Asia/Shanghai    Doklam, 2.8% of Bhutan
//     Asia/Tbilisi  meets  Europe/Moscow    Abkhazia and South Ossetia, 17.6%
//
// Measured over 400,000 random points: those three, and nothing else. Everywhere
// else exactly one zone claims the point, so the scan order cannot change any
// other answer — which is what makes this safe to reorder at all.
//
// The lookup returns the first feature that contains the point, so whichever of
// an overlapping pair is tested first wins. Left to the order the file happens
// to be in, that is an accident: Asia/Shanghai sits at index 271 and Asia/Urumqi
// at 282, so Shanghai won for no reason anyone chose. Sorting by area makes the
// smaller — the more specific — zone win, and makes it a decision.

/** A feature we can order: we only need its id and its geometry. */
export interface OrderableFeature {
  properties: { tzid: string };
  geometry: {
    type: string;
    coordinates: any[];
  } | null;
}

const EARTH_RADIUS_KM = 6371.0088;
const RAD = Math.PI / 180;

/**
 * Area of one ring on a sphere, in km². Signed, so a hole (wound the other way)
 * comes back negative and subtracts from the polygon that contains it.
 *
 * This is the standard spherical-excess sum rather than anything projected: the
 * zones here span whole continents and reach the poles, where a planar area is
 * not wrong by a little but by multiples.
 */
function ringAreaKm2(ring: number[][]): number {
  if (ring.length < 3) return 0;
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const [lonA, latA] = ring[i];
    const [lonB, latB] = ring[(i + 1) % ring.length];
    total += (lonB - lonA) * RAD * (2 + Math.sin(latA * RAD) + Math.sin(latB * RAD));
  }
  return (total * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2;
}

/** Area of a Polygon or MultiPolygon in km², holes removed. */
export function areaKm2(geometry: OrderableFeature['geometry']): number {
  if (!geometry) return 0;
  const polygons: number[][][][] =
    geometry.type === 'Polygon' ? [geometry.coordinates as number[][][]]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates as number[][][][]
    : [];

  let total = 0;
  for (const rings of polygons) {
    // First ring is the outer boundary, the rest are holes. Taking absolute
    // values per ring and subtracting is more robust than trusting the winding,
    // which round-trips through mapshaper and topojson before it gets here.
    total += Math.abs(ringAreaKm2(rings[0] ?? []));
    for (let i = 1; i < rings.length; i++) total -= Math.abs(ringAreaKm2(rings[i]));
  }
  return total;
}

/**
 * The nautical zones the --oceans build adds: Etc/GMT±N and Etc/UTC.
 *
 * These exist to cover water, and they are drawn as plain longitude bands with
 * land cut out of them. Where that cut is imprecise the band laps over the
 * shore, so a named zone and a band both claim a coastal strip — 48 such pairs
 * in the shipped data, all under 1 km², plus larger ones at Antarctic stations.
 *
 * A named zone always describes the place better than a band does, so a band
 * never wins. Size alone would not guarantee that: Etc/UTC is tiny and six bands
 * rank ahead of the largest land zones, so this has to be said explicitly.
 */
export function isNauticalZone(tzid: string): boolean {
  return /^Etc\//.test(tzid);
}

/**
 * Overlaps where the SMALLER zone must not win, despite being more specific.
 *
 * Each key is deliberate and needs a reason, because the default already handles
 * the general case. The value is the zone it must lose to; the key is then
 * ordered as though it were slightly larger than that zone, so the scan reaches
 * the winner first.
 *
 * Empty by default: "the more specific zone wins" is the rule, and an entry here
 * is an argument that a particular pair is an exception to it.
 */
export const DEFER_TO: Record<string, string> = {
  // Abkhazia keeps Moscow time. Georgia is UTC+4 (GET) and Abkhazia is UTC+3
  // (MSK) — checked against timeanddate, an hour apart on the same evening.
  //
  // tzdb has no zone for Abkhazia, only Asia/Tbilisi, so following the smaller
  // zone here means showing someone in Sukhumi an hour they are not keeping.
  // The boundary data carries both claims — Sukhumi is inside Asia/Tbilisi (de
  // jure) and inside Europe/Moscow (de facto) — so the map can express what the
  // zone list cannot, and this picks the clock actually kept there.
  //
  // Note this is not "the larger zone wins": it is the same principle as
  // Xinjiang, where the SMALLER zone wins because Asia/Urumqi (+6) is the clock
  // kept locally, against China's official nationwide +8. Both entries answer
  // "what does a clock there read", which is the question the app exists to ask.
  //
  // Only Abkhazia is affected. South Ossetia is not: Tskhinvali is inside
  // Asia/Tbilisi alone, so there is no second claim to choose between, and
  // Georgia proper is nowhere inside Europe/Moscow.
  'Asia/Tbilisi': 'Europe/Moscow',
};

/**
 * Boundary features ordered so the first one containing a point is the one we
 * want: smallest first, except where DEFER_TO says otherwise.
 *
 * Returns a new array — the caller's own order is left alone, because the map
 * renders from it and draw order is not ours to disturb.
 */
export function lookupOrder<T extends OrderableFeature>(features: readonly T[]): T[] {
  const areas = new Map<string, number>();
  for (const f of features) {
    const tzid = f.properties?.tzid;
    if (!tzid) continue;
    // A zone can appear more than once; it is the whole zone's size that ranks it.
    areas.set(tzid, (areas.get(tzid) ?? 0) + areaKm2(f.geometry));
  }

  const rankOf = (tzid: string): number => {
    const target = DEFER_TO[tzid];
    if (target !== undefined && areas.has(target)) {
      // Just past the zone it must lose to, so that one is tested first.
      return areas.get(target)! + 1;
    }
    const area = areas.get(tzid);
    // A zone with no geometry has no size, and zero would sort it in front of
    // everything real. It matches nothing, so it belongs at the back.
    return area === undefined || area <= 0 ? Infinity : area;
  };

  // Land before water, then smallest first within each. Two tiers rather than
  // one number, because "a band never beats a named zone" is a rule about what
  // the zones ARE, and expressing it as an area adjustment would make it look
  // like a coincidence of size that a future rebuild could quietly undo.
  const tierOf = (tzid: string): number => (isNauticalZone(tzid) ? 1 : 0);

  // Decorated sort: rank and original position computed once each, rather than
  // recomputed inside the comparator, which would make this quadratic.
  return features
    .map((f, at) => {
      const tzid = f.properties?.tzid;
      return { f, at, tier: tierOf(tzid), rank: rankOf(tzid) };
    })
    .sort((a, b) => (a.tier - b.tier) || (a.rank - b.rank) || (a.at - b.at))
    .map((d) => d.f);
}
