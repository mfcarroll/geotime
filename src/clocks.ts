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
import { correctedNow, getUtcOffset } from './time';
import { getDisplayTimezoneName, fold } from './utils';
import { shipKey, type ShipClock } from './ships';
import { zoneKey, type StoredZone } from './stored-zones';
import { shipTimeAvailable } from './rccl';

export type ClockEntry =
  | { kind: 'zone'; zone: StoredZone }
  | { kind: 'ship'; ship: ShipClock };

/** The zone a row keeps time by, whichever kind of row it is. */
export function clockZone(entry: ClockEntry): string | null {
  return entry.kind === 'zone' ? entry.zone.tz : null;
}

/**
 * Stable per-row identity, for `data-clock-key` and for dedupe.
 *
 * A zone row is keyed by its PLACE, not by its zone — see zoneKey — because two
 * of them may share a zone and updateAllClocks finds each row's element by this
 * string. Two rows with one key means one of them silently never has a time
 * written into it.
 */
export function clockKey(entry: ClockEntry): string {
  return entry.kind === 'ship' ? `ship:${shipKey(entry.ship)}` : zoneKey(entry.zone);
}

/**
 * Current offset from UTC in hours.
 *
 * A zone asks the platform, which knows its DST rules. A ship just reports the
 * offset the crew set — there are no rules to apply, which is the whole reason a
 * ship cannot be modelled as a zone.
 */
export function clockOffset(entry: ClockEntry): number {
  return entry.kind === 'ship' ? entry.ship.offsetHours ?? 0 : getUtcOffset(entry.zone.tz);
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
  if (entry.kind === 'ship') return entry.ship.name;
  return entry.zone.label ?? getDisplayTimezoneName(entry.zone.tz);
}


/**
 * The smaller line underneath, or '' when it would only repeat the name.
 *
 * For a zone this names the zone the place keeps time by; for a ship, whose
 * ship it is — which is also what distinguishes the row from the town of the
 * same name, since "Independence" is both a vessel and six real places.
 *
 *     Seattle                      Symphony of the Seas
 *     Timezone: Los Angeles        Royal Caribbean
 *
 * The brackets are gone from both. They were doing the work of a label without
 * being one: "(Los Angeles)" under "Seattle" reads as an aside about the name
 * above it — the same thing "(Royal Caribbean)" means — when what it actually
 * says is which clock the row keeps. Naming the relationship says that outright,
 * and costs a character less than bracketing the alternative wording did.
 *
 * Only the zone line is labelled. "Timezone:" answers a question a reader might
 * have about a place name; nobody wonders what "Royal Caribbean" is doing under
 * a ship.
 */
export type ZoneLabelWord = 'Timezone' | 'Zone' | 'TZ';

export function clockSubLabel(entry: ClockEntry, word: ZoneLabelWord = 'Timezone'): string {
  if (entry.kind === 'ship') {
    const line = entry.ship.brand === 'C' ? 'Celebrity' : 'Royal Caribbean';
    // Suppressed when the name already says it: every Celebrity vessel is
    // "Celebrity <something>", so the line underneath would just repeat the
    // first word. Same principle as the zone case below.
    return fold(entry.ship.name).startsWith(fold(line)) ? '' : line;
  }
  const zoneName = getDisplayTimezoneName(entry.zone.tz);
  // Accents aside, "Reykjavík" and the zone "Reykjavik" are the same place —
  // naming it twice would just look like a mistake.
  return fold(zoneName) === fold(clockLabel(entry)) ? '' : `${word}: ${zoneName}`;
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
  options: Intl.DateTimeFormatOptions = {},
  at: Date = correctedNow()
): string {
  return shiftTo(offsetHours, at).toLocaleTimeString(undefined, { timeZone: 'UTC', ...options });
}

/**
 * The instant re-expressed on a fixed offset, ready to be formatted in UTC.
 *
 * `at` is the whole point of the parameter: a caller rendering a list passes the
 * same instant to every row, so no two rows can be a second apart. Defaulting it
 * keeps the one-off callers honest without making them care.
 */
function shiftTo(offsetHours: number, at: Date): Date {
  return new Date(at.getTime() + offsetHours * 3600_000);
}

/** The weekday on a fixed UTC offset, for the "different day over there" line. */
export function fixedOffsetWeekday(
  offsetHours: number,
  format: 'short' | 'long' = 'short',
  at: Date = correctedNow()
): string {
  return shiftTo(offsetHours, at).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: format });
}

/** The written-out date on a fixed UTC offset, for the Ship Time card. */
export function formatFixedOffsetDate(offsetHours: number, at: Date = correctedNow()): string {
  return shiftTo(offsetHours, at).toLocaleDateString('en-US', {
    timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

/**
 * The rows to render, zones and ships interleaved by offset.
 *
 * `temporaryZone` is the map's transient selection, which appears in the
 * list without being saved; it only ever names a zone, since a ship has no place
 * on the map.
 */
export function visibleClocks(): ClockEntry[] {
  const entries: ClockEntry[] = state.savedZones.map((zone) => ({ kind: 'zone', zone }));

  // The transient row, when what was picked is not already kept. Compared by
  // PLACE: picking Tampa while America/New_York is already on the list is a new
  // row, not a repeat of one.
  const temporary = state.temporaryZone;
  if (temporary && !state.savedZones.some((zone) => zoneKey(zone) === zoneKey(temporary))) {
    entries.push({ kind: 'zone', zone: temporary });
  }
  // Ships are withheld entirely when the feature is disabled — no key means no
  // offset can ever be resolved or refreshed, so a stored one would be a clock
  // slowly going wrong with no way to correct it.
  // Including the ship we are aboard, which also has the Ship Time card above.
  // Appearing in both places is not duplication, it is the same treatment the
  // local zone already gets: a Local Time card AND a row labelled "Local time".
  //
  // It used to be withheld here, on the reasoning that it had collapsed into the
  // card the way the GPS zone collapses into Local Time. The GPS zone does no
  // such thing — it is auto-added to the list and keeps its row. So the aboard
  // ship was the only thing in the app to get a card INSTEAD of a row, which
  // read as "not saved" for the one clock in the app that cannot be re-derived
  // offline and therefore most needs to look saved. It also made adding your own
  // ship from the search box do nothing visible, which is indistinguishable from
  // a bug.
  for (const ship of shipTimeAvailable() ? state.shipClocks : []) {
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
