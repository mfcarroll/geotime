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

/** Where a call sits relative to now. */
export type CallPhase = 'ahead' | 'alongside' | 'departed';

/** One port call, with its stated times and those times resolved. */
export interface PortCall {
    /** Voyage day, 1-based, skipping days at sea. */
    day: number | null;
    /** As the itinerary states them; null where it states nothing. */
    arrive: string | null;
    depart: string | null;
    /** The same two as instants, resolved in the PORT's zone by the caller. */
    arrivesAt: number | null;
    departsAt: number | null;
}

/**
 * Ahead of her, under her, or behind her.
 *
 * By the schedule rather than by the hull's position, and that is deliberate:
 * this decides what a call SAYS about itself, and what it should say is what the
 * itinerary promises. A ship an hour late is still "arrives 08:00" until she is
 * there, which is the honest reading of a printed time.
 *
 * A call with no stated arrival can never read as alongside — it goes straight
 * from ahead to departed. That is the right degradation: without an arrival
 * there is nothing to say about being there, and claiming she has arrived
 * because her departure has not passed would be inventing the fact.
 */
export function callPhase(call: PortCall, now: number): CallPhase {
    if (call.departsAt !== null && call.departsAt <= now) return 'departed';
    if (call.arrivesAt !== null && call.arrivesAt <= now) return 'alongside';
    return 'ahead';
}

/**
 * The calendar date an instant falls on, at a given offset: "2026-09-06".
 *
 * The offset is the ANCHOR's — the clock the reader is living by — because
 * "today" is a fact about the reader, not about the port. Aboard that is the
 * ship's; ashore it is the ground's.
 */
export function localDate(at: number, offsetHours: number): string {
    const shifted = new Date(at + offsetHours * 3600_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * A stated time, with its day in front when that day is not today.
 *
 * "5:00 PM" while it is happening today, "Tue 5:00 PM" when it is not — because
 * a bare clock time on a card reads as today, and on a cruise the next call is
 * as often the day after tomorrow. Three letters is the whole cost, and an
 * itinerary never spans enough weeks for a weekday to be ambiguous.
 */
export function timeWithDay(wall: Wall, todayDate: string, fallbackYear: number): string {
    const clock = clock12(wall);
    if (wallDate(wall, fallbackYear) === todayDate) return clock;
    const year = wall.year ?? fallbackYear;
    const weekday = WEEKDAYS[new Date(Date.UTC(year, wall.month - 1, wall.day)).getUTCDay()];
    return `${weekday} ${clock}`;
}

/** The calendar date a stated time falls on, as its own clock states it. */
export function wallDate(wall: Wall, fallbackYear: number): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${wall.year ?? fallbackYear}-${pad(wall.month)}-${pad(wall.day)}`;
}

/**
 * What a call says about itself: "day 4 · arrives Tue 8:00 AM".
 *
 * The three phases say three different things, and only one of them is about a
 * departure.
 *
 *   AHEAD      when she gets there, which is the half a reader looking at a
 *              future call wants and the half we could not say until the
 *              itinerary's arrival times were being read at all.
 *   ALONGSIDE  when she leaves, which is now the useful one.
 *   DEPARTED   nothing, in almost every case. A call three days astern with a
 *              departure time on it is reciting the itinerary at somebody who
 *              watched it happen; the day number is the whole of what still
 *              matters about it.
 *
 * The exception is the call she has most recently left, on the day she left it —
 * "departed 4:00 PM" is then a fact about where she has just come from, and it
 * is the sentence that explains the wake leading away from that port. By
 * tomorrow it is history too.
 */
export function callNote(call: PortCall, opts: {
    now: number;
    /** The anchor's calendar date, from localDate(). */
    todayDate: string;
    /** True only for the most recently departed call of the voyage. */
    latestDeparture: boolean;
    /** The year to lend a stated time that omits one. */
    year: number;
}): string {
    const parts: string[] = [];
    if (call.day !== null) parts.push(`day ${call.day}`);

    const phase = callPhase(call, opts.now);
    const arrive = parseWall(call.arrive);
    const depart = parseWall(call.depart);

    if (phase === 'departed') {
        if (opts.latestDeparture && depart && wallDate(depart, opts.year) === opts.todayDate) {
            parts.push(`departed ${clock12(depart)}`);
        }
    } else if (phase === 'alongside') {
        if (depart) parts.push(`departs ${timeWithDay(depart, opts.todayDate, opts.year)}`);
    } else if (arrive) {
        parts.push(`arrives ${timeWithDay(arrive, opts.todayDate, opts.year)}`);
    } else if (depart) {
        // No arrival to state — an older Worker, or the embarkation call. The
        // departure is still worth having, and still worth dating.
        parts.push(`departs ${timeWithDay(depart, opts.todayDate, opts.year)}`);
    }

    return parts.join(' · ');
}
