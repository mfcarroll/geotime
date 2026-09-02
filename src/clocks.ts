// src/clocks.ts
//
// One shape for the two things that can sit on the World Clock list: a timezone
// and a ship. They are stored separately and for good reason — a ship carries an
// offset and a provenance no zone id can hold — but the list has to sort, render
// and address them uniformly, and that is what this module is for.
//
// Note the render key. A ship's key is "ship:R/ST", and that prefix exists only
// in a `data-` attribute: it is never stored and never crosses to native. This
// is deliberately not the synthetic-zone-id approach — nothing here is ever
// handed to Intl or to TimeZone(identifier:) — it is just a string that
// identifies a row in the DOM.

// time.ts imports this module and this module imports time.ts. The cycle is
// benign because every reference is inside a function body rather than at module
// initialisation, so both are fully evaluated before either is called — but keep
// it that way: a top-level call across this boundary would break at load.
import { state } from './state';
import { getUtcOffset, getZoneLabel } from './time';
import { getDisplayTimezoneName, fold } from './utils';
import { shipKey, type ShipClock } from './ships';
import { shipTimeAvailable } from './rccl';

export type ClockEntry =
  | { kind: 'zone'; tzid: string }
  | { kind: 'ship'; ship: ShipClock };

/** Stable per-row identity, for `data-clock-key` and for dedupe. */
export function clockKey(entry: ClockEntry): string {
  return entry.kind === 'ship' ? `ship:${shipKey(entry.ship)}` : entry.tzid;
}

/**
 * Current offset from UTC in hours.
 *
 * A zone asks the platform, which knows its DST rules. A ship just reports the
 * offset the crew set — there are no rules to apply, which is the whole reason a
 * ship cannot be modelled as a zone.
 */
export function clockOffset(entry: ClockEntry): number {
  return entry.kind === 'ship' ? entry.ship.offsetHours ?? 0 : getUtcOffset(entry.tzid);
}

/**
 * The name on the row: the place or ship the user picked.
 *
 * Always the full ship name — "Star of the Seas". The row wraps to a second
 * line rather than truncating, so there is no width to run out of and nothing to
 * abbreviate. Only the widget needs the short form, because a widget cannot
 * grow; it reads `ShipClock.short` directly.
 */
export function clockLabel(entry: ClockEntry): string {
  return entry.kind === 'ship' ? entry.ship.name : getZoneLabel(entry.tzid);
}


/**
 * The smaller line underneath, or '' when it would only repeat the name.
 *
 * For a zone this names the zone the place keeps time by, bracketed so that
 * "Los Angeles" under "San Francisco" doesn't read as a second place. For a ship
 * there is no zone to name, so it says whose ship it is — which is also what
 * distinguishes the row from the town of the same name, since "Independence" is
 * both a vessel and six real places.
 */
export function clockSubLabel(entry: ClockEntry): string {
  if (entry.kind === 'ship') {
    const line = entry.ship.brand === 'C' ? 'Celebrity' : 'Royal Caribbean';
    // Suppressed when the name already says it: every Celebrity vessel is
    // "Celebrity <something>", so "(Celebrity)" underneath would just repeat the
    // first word. Same principle as the zone case below.
    return fold(entry.ship.name).startsWith(fold(line)) ? '' : `(${line})`;
  }
  const zoneName = getDisplayTimezoneName(entry.tzid);
  // Accents aside, "Reykjavík" and the zone "Reykjavik" are the same place —
  // naming it twice would just look like a mistake.
  return fold(zoneName) === fold(getZoneLabel(entry.tzid)) ? '' : `(${zoneName})`;
}

/** True when this row is a ship whose offset we have never resolved. */
export function isUnresolved(entry: ClockEntry): boolean {
  return entry.kind === 'ship' && entry.ship.offsetHours === null;
}

/**
 * Formats the time on a fixed UTC offset, honouring the device's locale and
 * 12/24-hour preference.
 *
 * Shifts the instant and formats it in UTC rather than inventing a zone id,
 * which keeps this exact for fractional offsets and needs no tzdb entry to
 * exist for the value the crew happened to pick.
 */
export function formatFixedOffsetTime(
  offsetHours: number,
  options: Intl.DateTimeFormatOptions = {}
): string {
  const shifted = new Date(Date.now() + state.timeOffset + offsetHours * 3600_000);
  return shifted.toLocaleTimeString(undefined, { timeZone: 'UTC', ...options });
}

/** The weekday on a fixed UTC offset, for the "different day over there" line. */
export function fixedOffsetWeekday(offsetHours: number, format: 'short' | 'long' = 'short'): string {
  const shifted = new Date(Date.now() + state.timeOffset + offsetHours * 3600_000);
  return shifted.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: format });
}

/**
 * The rows to render, zones and ships interleaved by offset.
 *
 * `temporaryTimezone` is the map's transient selection, which appears in the
 * list without being saved; it only ever names a zone, since a ship has no place
 * on the map.
 */
export function visibleClocks(): ClockEntry[] {
  const entries: ClockEntry[] = state.addedTimezones.map((tzid) => ({ kind: 'zone', tzid }));

  if (state.temporaryTimezone && !state.addedTimezones.includes(state.temporaryTimezone)) {
    entries.push({ kind: 'zone', tzid: state.temporaryTimezone });
  }
  // Ships are withheld entirely when the feature is disabled — no key means no
  // offset can ever be resolved or refreshed, so a stored one would be a clock
  // slowly going wrong with no way to correct it.
  for (const ship of shipTimeAvailable() ? state.shipClocks : []) {
    // The ship we are aboard collapses into the Ship Time section and does not
    // also appear here — exactly as the GPS zone never gets a row of its own,
    // because it already *is* the Local Time card. Step ashore and the marker
    // stops arriving, so the same stored ship reappears in this list.
    if (shipKey(ship) === state.aboardShipKey) continue;
    entries.push({ kind: 'ship', ship });
  }

  return entries.sort((a, b) => {
    // An unresolved ship has no offset to sort by, so it sits at the end rather
    // than pretending to be UTC.
    const unresolvedA = isUnresolved(a) ? 1 : 0;
    const unresolvedB = isUnresolved(b) ? 1 : 0;
    if (unresolvedA !== unresolvedB) return unresolvedA - unresolvedB;

    return clockOffset(a) - clockOffset(b)
      || clockLabel(a).localeCompare(clockLabel(b));
  });
}
