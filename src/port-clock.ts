// src/port-clock.ts
//
// What instant a scraped port time actually refers to.
//
// The itinerary states its times as bare wall clocks — "2026-09-06 17:00:00" —
// with no zone attached, and they are the PORT's wall clock. That is the
// operator's convention and the conventional reading of a departure: a ship
// leaving Coco Cay at five leaves at five in the Bahamas, not five wherever the
// reader happens to be standing.
//
// Reading them as anything else is a silent error the size of the difference
// between the two zones, and it lands squarely on the hours right after a
// departure — exactly when the map has to know she has gone. From Vancouver a
// Caribbean call read three hours astern of the truth: the ship was forty
// kilometres past Coco Cay making nineteen knots for Cozumel, and every test
// that asked "has she left?" said no. What that drew was a route ahead that ran
// BACKWARDS to the port she had just sailed from before turning for the next
// one, on Harmony, Jewel and anything else within a few hours of a call.
//
// Its own module because it is pure and worth testing, and because two very
// different callers need the same answer — the card's third line and the chart's
// route-ahead. Same reason wake.ts, clock-offset.ts and ship-position.ts live
// apart from their callers.

/** A wall clock with no zone attached, which is all the itinerary gives us. */
export interface Wall {
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
export function instantOf(w: Wall, zoneOffsetHours: number, fallbackYear: number): number {
  return Date.UTC(w.year ?? fallbackYear, w.month - 1, w.day, w.hour, w.minute)
    - zoneOffsetHours * 3600_000;
}

/** The year the ETA leaves out, taken from the voyage it belongs to. */
export function voyageYear(startDate: string | null, endDate: string | null): number {
  const stamped = (startDate ?? endDate ?? '').match(/(\d{4})/);
  return stamped ? Number(stamped[1]) : new Date().getFullYear();
}

/**
 * When a port call ends, as an instant, or null if it does not say.
 *
 * Null is a real answer rather than a failure: the last call of an itinerary
 * carries no departure because nobody leaves again, and every caller has to
 * treat that as "not departed" rather than as "departed long ago".
 *
 * `zoneOffsetHours` is passed in rather than looked up here for the same reason
 * `resolve` is passed into portRefsFrom — the lookup lives in time.ts, which
 * reaches for `document`, and this stays testable without a DOM.
 */
export function departsAt(
  depart: string | null,
  zoneOffsetHours: number,
  fallbackYear: number,
): number | null {
  const wall = parseWall(depart);
  return wall ? instantOf(wall, zoneOffsetHours, fallbackYear) : null;
}
