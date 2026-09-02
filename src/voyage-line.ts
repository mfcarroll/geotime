// src/voyage-line.ts
//
// The third line of the selected-ship card: where she is, or where she is going.
//
// This used to be one thing — "→ Cozumel · ETA September 2, 11:15" — and it was
// wrong in three ways at once while alongside in Cozumel. It answered a question
// that was already settled, it quoted an arrival five hours in the past as
// though it were a prediction, and it gave a time with no AM/PM in an app whose
// every other clock is twelve-hour.
//
// The fix is to notice she is in port. Nothing new is fetched for it: the fleet
// feed already carries speed over ground, whose own definition is "0 means
// alongside or at anchor", and the itinerary already carries a departure time
// per port. Both were arriving and neither was read.
//
// WHICH CLOCK THESE TIMES ARE IN
//
// Port time. That is the operator's own convention for an itinerary, it is the
// conventional reading of an arrival or departure at a place, and it is the
// decision this card already documented before any of this was written.
//
// So the times are shown as stated rather than converted — but they are now
// LABELLED when the port's clock and the ship's disagree, which is the case a
// passenger would otherwise misread. Alongside, the two normally match and the
// label stays off; a shift at sea before an early arrival is where it earns its
// place. An unqualified time is the one thing this app spends the rest of its
// surface avoiding, and this line was the last place still doing it.

import { state } from './state';
import { shipKey } from './ships';
import { findTimezoneFromGeoJSON, getUtcOffset } from './time';
import { distance } from './utils';
import { fixForShip, type ShipFix, type ShipPort, type ShipVoyage } from './shiptrack';

/**
 * Under way or not.
 *
 * Not zero, because AIS reports a tenth of a knot of drift on a moored hull and
 * a hard zero would flicker the line on and off between fixes.
 */
const ALONGSIDE_KNOTS = 0.7;

/**
 * How near a port still counts as being at it.
 *
 * Generous on purpose: several Caribbean calls are tender ports where the ship
 * anchors offshore and never touches a pier. A vessel doing under a knot this
 * close to a scheduled call is at that call, not passing it — the speed test is
 * what makes the distance able to be loose.
 */
const ALONGSIDE_KM = 10;

/** A wall clock with no zone attached, which is all the itinerary gives us. */
interface Wall {
  /** Null for the ETA format, which omits the year. */
  year: number | null;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/**
 * Parses the two shapes upstream uses, and nothing else.
 *
 *   "2026-09-02 17:00:00"   port departures
 *   "September 3, 12:15"    the destination ETA
 *
 * Deliberately strict. These strings are scraped from someone else's markup, so
 * a shape we have not seen is likelier to be a surprise than a near-miss worth
 * salvaging, and the caller can say less rather than say something wrong.
 */
export function parseWall(raw: string | null): Wall | null {
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  if (iso) {
    return {
      year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]),
      hour: Number(iso[4]), minute: Number(iso[5]),
    };
  }

  const named = raw.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{1,2}):(\d{2})/);
  if (named) {
    const month = MONTHS.indexOf(named[1].toLowerCase()) + 1;
    if (month === 0) return null;
    return {
      year: null, month, day: Number(named[2]),
      hour: Number(named[3]), minute: Number(named[4]),
    };
  }

  return null;
}

/** "17:00" -> "5:00 PM". The whole point of the exercise. */
export function clock12(w: Wall): string {
  const suffix = w.hour < 12 ? 'AM' : 'PM';
  const hour = w.hour % 12 === 0 ? 12 : w.hour % 12;
  return `${hour}:${String(w.minute).padStart(2, '0')} ${suffix}`;
}

/**
 * The instant a wall clock refers to, given the zone it is stated in.
 *
 * Uses the zone's CURRENT offset rather than its offset on the date in question.
 * These times are hours to days away, so the two differ only across a DST
 * boundary, and the only thing this feeds is a has-it-passed test where an
 * hour's error changes nothing.
 */
function instantOf(w: Wall, zoneOffsetHours: number, fallbackYear: number): number {
  return Date.UTC(w.year ?? fallbackYear, w.month - 1, w.day, w.hour, w.minute)
    - zoneOffsetHours * 3600_000;
}

/** The year the ETA leaves out, taken from the voyage it belongs to. */
function voyageYear(voyage: ShipVoyage): number {
  const stamped = (voyage.voyage.startDate ?? voyage.voyage.endDate ?? '').match(/(\d{4})/);
  return stamped ? Number(stamped[1]) : new Date().getFullYear();
}

/** UTC offset of the zone a port stands in, or null out at sea. */
function portOffsetHours(port: ShipPort): number | null {
  const tz = findTimezoneFromGeoJSON(port.lat, port.lon);
  return tz ? getUtcOffset(tz) : null;
}

/** The ship's own offset, or null before it has ever resolved. */
function shipOffsetHours(key: string): number | null {
  return state.shipClocks.find((s) => shipKey(s) === key)?.offsetHours ?? null;
}

/**
 * " port time", or nothing.
 *
 * Nothing is the common case and the one worth protecting: alongside, a ship
 * usually keeps the port's clock, the two readings coincide, and a qualifier
 * would be noise on a line that is already subordinate.
 */
function basisSuffix(portOffset: number | null, shipOffset: number | null): string {
  if (portOffset === null || shipOffset === null) return '';
  return portOffset === shipOffset ? '' : ' port time';
}

/** The port she is at, if she is at one. */
export function portCall(voyage: ShipVoyage, fix: ShipFix | null): ShipPort | null {
  if (!fix || fix.sog === null || fix.sog > ALONGSIDE_KNOTS) return null;

  let nearest: ShipPort | null = null;
  let nearestKm = Infinity;
  for (const port of voyage.ports) {
    const km = distance(fix.lat, fix.lon, port.lat, port.lon);
    if (km < nearestKm) { nearestKm = km; nearest = port; }
  }

  return nearest && nearestKm <= ALONGSIDE_KM ? nearest : null;
}

/**
 * The line itself. Empty string when there is nothing worth saying, which is
 * common — a third of the fleet reports no usable destination.
 */
export function voyageLine(voyage: ShipVoyage | null, key: string | null): string {
  if (!voyage || !key) return '';

  const fix = fixForShip(key);
  const shipOffset = shipOffsetHours(key);
  const year = voyageYear(voyage);
  const now = Date.now() + state.timeOffset;

  const port = portCall(voyage, fix);
  if (port) {
    const name = port.name ?? voyage.destination;
    if (!name) return '';

    const portOffset = portOffsetHours(port);
    const wall = parseWall(port.depart);

    // The final call has no departure — nobody leaves again — and a call whose
    // departure has already passed is a ship running late or a stale itinerary.
    // Both get the place without a time, which is still the useful half.
    if (!wall) return `In ${name}`;
    const departsAt = instantOf(wall, portOffset ?? shipOffset ?? 0, year);
    if (departsAt < now) return `In ${name}`;

    return `${name} · Dep. ${clock12(wall)}${basisSuffix(portOffset, shipOffset)}`;
  }

  // Under way. The destination and its ETA, as the operator states them.
  if (!voyage.destination) return '';
  const wall = parseWall(voyage.eta);
  if (!wall) return `→ ${voyage.destination}`;

  // The ETA belongs to the port being approached, which is the last one on the
  // route rather than the nearest — so it is matched by name where we can, and
  // left unqualified where we cannot.
  const target = voyage.ports.find((p) => p.name && p.name === voyage.destination) ?? null;
  const portOffset = target ? portOffsetHours(target) : null;

  return `→ ${voyage.destination} · ETA ${clock12(wall)}${basisSuffix(portOffset, shipOffset)}`;
}
