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
import { anchorOffsetHours, utcOffsetForCoordinates } from './time';
import { distance, fold } from './utils';
import { ALONGSIDE_KNOTS, fixForShip, type ShipFix, type ShipPort, type ShipVoyage } from './shiptrack';
import { instantOf, localDate, parseWall, timeWithDay, voyageYear } from './port-clock';

/**
 * How near a port still counts as being at it.
 *
 * Generous on purpose: several Caribbean calls are tender ports where the ship
 * anchors offshore and never touches a pier. A vessel doing under a knot this
 * close to a scheduled call is at that call, not passing it — the speed test is
 * what makes the distance able to be loose.
 */
const ALONGSIDE_KM = 10;

/** UTC offset of the zone a port stands in, or null out at sea. */
function portOffsetHours(port: ShipPort): number | null {
  return utcOffsetForCoordinates(port.lat, port.lon);
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
  const year = voyageYear(voyage.voyage.startDate, voyage.voyage.endDate);
  const now = Date.now() + state.timeOffset;
  // The day these times fall on, when it is not the reader's own day.
  //
  // A bare clock reads as today, and on a cruise it very often is not: an ETA
  // two nights away said "11:00 AM" and looked like this morning. "Thu 11:00
  // AM" costs four characters on a line that had room for them. Today is the
  // ANCHOR's day throughout — the ship's while aboard, the ground's ashore —
  // because that is the clock the reader is living by.
  const today = localDate(now, anchorOffsetHours());

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

    return `${name} · Dep. ${timeWithDay(wall, today, year)}${basisSuffix(portOffset, shipOffset)}`;
  }

  // Under way. Where she is going, named by the itinerary rather than by the
  // AIS set — see destinationPort — and due when the operator says.
  const target = destinationPort(voyage, shipOffset, now);
  const name = target?.name ?? voyage.destination;
  if (!name) return '';

  const wall = parseWall(voyage.eta);
  if (!wall) return `→ ${name}`;

  const portOffset = target ? portOffsetHours(target) : null;
  return `→ ${name} · ETA ${timeWithDay(wall, today, year)}${basisSuffix(portOffset, shipOffset)}`;
}

/**
 * The port she is standing off, as a call on her itinerary.
 *
 * `destination` is free text an officer types into the AIS set, and a good deal
 * of it is not a place name at all. The Worker already drops the shapes it can
 * recognise as codes — bare LOCODEs, "MX COZ" — but the fleet produces plenty
 * it cannot: "Bas Nas" for Bahamas/Nassau, "Nas>mia" for Nassau to Miami, "Us
 * Pcv >>> Bs Coc". Widening that filter is how you lose New York, which has the
 * same shape as a code and is a place.
 *
 * So the itinerary answers instead, because it is a list of real names for the
 * places this ship is actually going. Matched by name first, which honours a
 * crew who typed something recognisable — and where they did not, the next call
 * she has not yet sailed from is where she is going, by definition.
 *
 * Null only for a voyage with no itinerary at all, where the typed string is
 * still better than saying nothing.
 */
export function destinationPort(
  voyage: ShipVoyage, shipOffset: number | null, now: number
): ShipPort | null {
  const stated = fold(voyage.destination ?? '');
  const named = stated
    ? voyage.ports.find((p) => p.name && fold(p.name) === stated)
    : undefined;
  if (named) return named;

  const year = voyageYear(voyage.voyage.startDate, voyage.voyage.endDate);
  for (const port of voyage.ports) {
    // The final call states no departure — nobody leaves again — so reaching it
    // means every other call is behind her and this is the one ahead.
    if (!port.depart) return port;
    const wall = parseWall(port.depart);
    if (!wall) continue;
    if (instantOf(wall, portOffsetHours(port) ?? shipOffset ?? 0, year) > now) return port;
  }
  return null;
}
