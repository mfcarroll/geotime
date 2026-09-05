// src/ports.ts
//
// Ports of call, made searchable.
//
// A ship's itinerary names the places she is going, and those places keep
// ordinary shore time — so someone aboard wants Cozumel on the clock list the
// same way they want Vancouver. Before this they could not have it: the port was
// visible on the map and named on the row, but typing it into the search box
// found nothing, because the city index only carries places above a population
// floor and a tender port is often well under it.
//
// The zone is derived from the port's own coordinates rather than looked up by
// name. That is the whole reason the boundary data had to get better: at 0.2%
// detail a small island port resolved to the ocean band around it, which is a
// fixed offset that happens to be right in winter and an hour wrong all summer.

import type { ShipPort, ShipVoyage } from './shiptrack';

/** A port of call, resolved to the zone it keeps time by. */
export interface PortRef {
  /** As the itinerary names it: "Cozumel". */
  name: string;
  /** IANA zone the port stands in. */
  tzid: string;
  /** The ship whose itinerary this came from, for the row underneath. */
  ship: string;
  lat: number;
  lon: number;
}

/**
 * True when a resolved zone is a nautical band rather than a real place.
 *
 * A port that resolves to Etc/GMT-5 has not been located — it has fallen through
 * to the water around it. That happens when the itinerary's coordinates land
 * offshore, which is common for tender ports where the anchorage is the marked
 * position. A fixed offset is a plausible-looking wrong answer: it matches the
 * shore in winter and is an hour out all summer, wherever the shore keeps DST.
 * Better to leave the port unsearchable than to name it and be wrong in July.
 */
export function isUnlocatedZone(tzid: string | null): boolean {
  return !tzid || /^Etc\//.test(tzid);
}

/**
 * Every port worth offering, from the voyages given.
 *
 * `resolve` is passed in rather than imported so this stays testable without a
 * DOM — findTimezoneFromGeoJSON lives in time.ts, which reaches for `document`.
 *
 * Last one wins on a name collision. Two ships calling at the same port give the
 * same answer, so the tie does not matter; two ports sharing a name across
 * itineraries is rare enough that picking is better than showing both, and the
 * later itinerary is the more recently loaded one.
 */
export function portRefsFrom(
  voyages: Array<{ ship: string; voyage: ShipVoyage | null }>,
  resolve: (lat: number, lon: number) => string | null,
): PortRef[] {
  const byName = new Map<string, PortRef>();

  for (const { ship, voyage } of voyages) {
    for (const port of voyage?.ports ?? []) {
      if (!port.name) continue;                 // scraped markup; often absent
      if (!Number.isFinite(port.lat) || !Number.isFinite(port.lon)) continue;
      const tzid = resolve(port.lat, port.lon);
      if (isUnlocatedZone(tzid)) continue;
      byName.set(port.name.toLowerCase(),
        { name: port.name, tzid: tzid!, ship, lat: port.lat, lon: port.lon });
    }
  }

  return [...byName.values()];
}

/** Ports whose folded name matches a query, in the same three tiers as cities. */
export function matchPortTiers(query: string, ports: PortRef[], fold: (s: string) => string): PortRef[][] {
  const q = fold(query.trim());
  const tiers: PortRef[][] = [[], [], []];
  if (!q) return tiers;

  for (const port of ports) {
    const name = fold(port.name);
    if (name === q) tiers[0].push(port);
    else if (name.startsWith(q)) tiers[1].push(port);
    else if (name.includes(q)) tiers[2].push(port);
  }
  return tiers;
}

/** Ports from a voyage, for callers that already hold one. */
export function portsOf(voyage: ShipVoyage | null): ShipPort[] {
  return voyage?.ports ?? [];
}
