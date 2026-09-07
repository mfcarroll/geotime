// src/time.ts

import * as dom from './dom';
import { aboardShip, state } from './state';
import { msUntilNextSecond, serverClockOffset, type ServerTimeReading } from './clock-offset';
import { getDisplayTimezoneName, isValidTimezone } from './utils';
import { clockKey, fixedOffsetWeekday, formatFixedOffsetDate, formatFixedOffsetTime, isUnresolved, visibleClocks } from './clocks';
import { fitSecondLines, type SecondLineRow } from './second-line';
import { shipKey } from './ships';
import { isUnresolvable } from './shiptime';
import { point as turfPoint } from '@turf/helpers';
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';
import { lookupOrder } from './zone-order';

// Zone naming is pure and lives in utils so it can be used (and tested)
// without pulling in the DOM; re-exported here for existing callers.
export { getDisplayTimezoneName, isValidTimezone } from './utils';

/**
 * The name for a clock the user added: the place they picked if there is one
 * (searching "Mumbai" keeps saying Mumbai, not Kolkata), else the zone's own
 * name.
 *
 * Scope matters. Labels belong to rows in the World Clock list. Anything
 * describing *where you are* or *which zone is on the map* uses
 * getDisplayTimezoneName instead — otherwise labelling a clock "Nelson" renames
 * the Local Time card too, and the app claims you're somewhere you aren't.
 */
export function getZoneLabel(tz: string): string {
    return state.zoneLabels[tz] ?? getDisplayTimezoneName(tz);
}

/**
 * Current UTC offset in hours (may be fractional: +5.75 for Kathmandu).
 *
 * Asks Intl for the offset directly rather than formatting a date and re-parsing
 * our own output, which was accurate only to the second and silently returned a
 * sentinel on failure.
 */
export function getUtcOffset(timeZone: string): number {
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone,
            timeZoneName: 'longOffset',
        }).formatToParts(new Date(Date.now() + state.timeOffset));
        const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
        // "GMT+05:45", or plain "GMT" at UTC.
        const m = name.match(/GMT([+-])(\d{2}):(\d{2})/);
        if (!m) return 0;
        const sign = m[1] === '+' ? 1 : -1;
        return sign * (parseInt(m[2], 10) + parseInt(m[3], 10) / 60);
    } catch {
        return 0;
    }
}

/**
 * Resolves coordinates to an IANA zone from the bundled boundaries. The data is
 * timezone-boundary-builder with ocean zones, so every feature carries a real
 * IANA id and the whole globe is covered — there is no "no match" case at sea.
 */
// Ordering the features costs one pass over the geometry, so it is done once per
// loaded dataset rather than per lookup. Keyed on the object itself: a reload
// replaces it and the order is rebuilt, and nothing has to remember to clear it.
let orderedFrom: unknown = null;
let orderedFeatures: any[] = [];

export function findTimezoneFromGeoJSON(lat: number, lon: number): string | null {
    if (!state.geoJsonData) return null;

    if (orderedFrom !== state.geoJsonData) {
        orderedFeatures = lookupOrder(state.geoJsonData.features);
        orderedFrom = state.geoJsonData;
    }

    const searchPoint = turfPoint([lon, lat]);

    // Smallest zone first, so the first hit is the most specific one. Only three
    // points on Earth are claimed by two zones at once — see zone-order.ts — and
    // everywhere else this order is indistinguishable from any other.
    for (const feature of orderedFeatures) {
        if (feature.geometry && booleanPointInPolygon(searchPoint, feature.geometry)) {
            return feature.properties.tzid as string;
        }
    }

    return null;
}

/**
 * Now, as this app believes it — the device clock plus whatever correction the
 * last trusted server reading bought.
 *
 * Every rendered clock resolves through here, and every caller inside one paint
 * should call it ONCE and pass the result down. Reading it per clock is what put
 * the cards a second apart: `updateAllClocks` used to take six independent
 * readings, and any two of them landing either side of a second boundary showed
 * up as two clocks disagreeing — a second on the cards, which show seconds, and
 * a whole minute on the rows, which show h:mm and so disagree at the minute
 * boundary instead.
 */
export function correctedNow(): Date {
  return new Date(Date.now() + state.timeOffset);
}

export function getFormattedTime(
  tz: string,
  options: Intl.DateTimeFormatOptions = {},
  at: Date = correctedNow()
): string {
  try {
    // undefined locale: follow the device's locale and 12/24h preference
    return at.toLocaleTimeString(undefined, { timeZone: tz, ...options });
  } catch (e) {
    return "Invalid";
  }
}

/**
 * Records a trusted UTC reading from a server, whatever the source.
 *
 * A correct timezone still renders the wrong time if "what is UTC right now" is
 * wrong, and the device clock is exactly what this app declines to trust. So
 * every server that tells us the time feeds the same correction here.
 *
 * The RCCL API is one such server, and a notably good one at sea: every response
 * carries a `date` header, it is reachable from a ship's network without an
 * internet package, and the request was being made anyway. The Cloud Run
 * function below remains the general path, since no RCCL call happens for a user
 * who never touches a ship.
 *
 * The 500 ms deadband is kept from the original: below that the difference is
 * indistinguishable from round-trip latency, which on a satellite link is the
 * dominant error in either source.
 *
 * Latency and timestamp granularity are undone in clock-offset.ts, which is
 * where the arithmetic and its reasoning live.
 */
export function noteServerTime(serverUtcMs: number, reading: ServerTimeReading = {}): void {
  state.timeOffset = serverClockOffset(serverUtcMs, reading);
}

/**
 * When the clock was last agreed with a server, so a resume does not re-ask on
 * every tab switch. Epoch ms on the DEVICE clock, which is fine for measuring an
 * interval — the correction cancels out of a subtraction.
 */
let lastSyncAt = 0;

/**
 * Not less often than this, and not more.
 *
 * The clock used to be set once at launch and then trusted forever: a session
 * left open for a day rode entirely on the device's own crystal, and a phone
 * whose clock drifts is the failure this app exists to catch. Resume is the
 * right trigger for the same reason it is for ship time — it is the moment
 * something could newly have changed, and the moment the user is about to look.
 *
 * Fifteen minutes is a floor, not a schedule: still no timer, so a session left
 * in the foreground makes no requests at all. The Worker is a few hundred bytes
 * and no-store, so the cost of asking is a round trip and nothing else.
 */
const RESYNC_AFTER_MS = 15 * 60 * 1000;

export function startClockWatch(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastSyncAt < RESYNC_AFTER_MS) return;
    void syncClock();
  });
}

export async function syncClock() {
  try {
    // Cloudflare Worker (workers/utc-time), with the original Cloud Run
    // function as a fallback. Both return { dateTime: <ISO 8601> }.
    //
    // The fallback is a migration aid, not a permanent arrangement: the Cloud
    // Run function was created in the console with no source control, and the
    // point of the Worker is to retire it. Drop the second URL once a release
    // has shipped on the first.
    const SOURCES = [
      import.meta.env.VITE_UTC_TIME_URL
        ?? 'https://geotime-utc-time.matthew-carroll.workers.dev/',
      'https://get-utc-time-100547663673.us-west1.run.app/',
    ].filter(Boolean) as string[];

    let noted = false;
    for (const url of SOURCES) {
      try {
        const sentAt = Date.now();
        const response = await fetch(url);
        if (!response.ok) continue;
        const data = await response.json();
        // Stamped after decoding rather than on first byte, which overstates the
        // trip slightly and so errs towards trusting the device — the safer
        // direction, since the correction is the thing being justified.
        const receivedAt = Date.now();
        const serverMs = new Date(data.dateTime).getTime();
        if (!Number.isFinite(serverMs)) continue;
        noteServerTime(serverMs, { sentAt, receivedAt });
        noted = true;
        break;
      } catch {
        // Try the next source.
      }
    }
    if (!noted) throw new Error('No UTC source answered.');
    lastSyncAt = Date.now();
  } catch (error) {
    console.error('Could not synchronize clock:', error);
    // Left alone rather than zeroed. A failed re-sync is not evidence the
    // previous correction was wrong, and throwing it away would silently hand a
    // known-bad device clock back to a user who is mid-voyage — which is the one
    // situation where reaching a server is least likely and being right matters
    // most. `lastSyncAt` is deliberately not advanced, so the next resume
    // retries immediately.
    if (lastSyncAt === 0) state.timeOffset = 0;
  }
}

/**
 * "Saturday, September 5, 2026" in a given zone.
 *
 * One place, because three cards now render this string and two of them exist
 * only to be compared against the third — a formatting difference between them
 * would read as a date difference and show a line that should have stayed
 * hidden.
 */
function writtenDate(at: Date, timeZone: string): string {
  return at.toLocaleDateString('en-US', {
    timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

/**
 * Shows a card's date line only when it disagrees with the ground.
 *
 * Compared as the rendered strings rather than by arithmetic on the instants:
 * the question the line answers is "does this card say a different day from the
 * one above it", which is a question about what is on screen.
 */
function showDateWhenItDiffers(el: HTMLElement, date: string, groundDate: string): void {
  const differs = date !== groundDate;
  el.textContent = differs ? date : '';
  el.classList.toggle('hidden', !differs);
}

export function updateAllClocks() {
  // ONE reading, for everything this paint draws. Both stamps come off the same
  // millisecond, so the Local and Device cards can now differ only by the
  // correction itself — never by a second that was really two clock readings
  // landing either side of a boundary.
  const tickMs = Date.now();
  const correctedTime = new Date(tickMs + state.timeOffset);
  const deviceNow = new Date(tickMs);
  const localTimezone = state.localTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  
  try {
    dom.localTimeEl.textContent = correctedTime.toLocaleTimeString(undefined, {
      timeZone: localTimezone,
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit'
    });
    dom.localDateEl.textContent = writtenDate(correctedTime, localTimezone);
    // The town you're in, when we can name it — otherwise the zone.
    dom.localTimezoneEl.textContent = state.localPlaceName ?? getDisplayTimezoneName(localTimezone);
  } catch (e) {
    dom.localTimeEl.textContent = "Error";
  }


  const secondLines: SecondLineRow[] = [];
  visibleClocks().forEach((entry) => {
    // Looked up by data attribute, not by rebuilding the id — zone ids contain
    // hyphens (America/Port-au-Prince, Etc/GMT-5) that a slug can't round-trip.
    const el = dom.worldClocksContainerEl.querySelector<HTMLElement>(
      `[data-clock-key="${CSS.escape(clockKey(entry))}"]`
    );
    if (!el) return;

    // A ship whose offset has never resolved gets a placeholder rather than a
    // guess. Nothing sensible can be shown, and the embark port's zone — the
    // obvious wrong answer — is not the ship's clock.
    if (isUnresolved(entry)) {
      el.querySelector('.time')!.textContent = '--:--';
      // "Finding" only while it is still plausibly being found. Once a request
      // has come back with nothing, saying so is the honest option — that state
      // can last a whole cruise if the ship is unreachable.
      el.querySelector('.date-diff')!.textContent =
        entry.kind === 'ship' && isUnresolvable(clockKey(entry))
          ? 'Ship time unavailable'
          : 'Finding ship time…';
      return;
    }

    let timeString: string;
    let dayShort: string;
    let dayFull: string;
    let timeDiff: string;

    if (entry.kind === 'ship') {
      const offset = entry.ship.offsetHours as number;
      timeString = formatFixedOffsetTime(offset, { hour: 'numeric', minute: '2-digit' }, correctedTime);
      dayShort = fixedOffsetWeekday(offset, 'short', correctedTime);
      dayFull = fixedOffsetWeekday(offset, 'long', correctedTime);
      timeDiff = relativeTextForShip(entry.ship as { brand: string; code: string; offsetHours: number });
    } else {
      timeString = getFormattedTime(entry.tzid, { hour: 'numeric', minute: '2-digit' }, correctedTime);
      dayShort = correctedTime.toLocaleDateString('en-US', { timeZone: entry.tzid, weekday: 'short' });
      dayFull = correctedTime.toLocaleDateString('en-US', { timeZone: entry.tzid, weekday: 'long' });
      timeDiff = relativeTextForZone(entry.tzid);
    }

    el.querySelector('.time')!.textContent = timeString;
    // The second line is written by fitSecondLines below, which needs every
    // row's candidate strings before it can choose between them.
    secondLines.push({ el, entry, dayShort, dayFull, timeDiff });
  });

  fitSecondLines(secondLines);
  
  renderShipTime(correctedTime);

  // Prefer the native-reported OS timezone; the WebView's own Intl can be stale
  // after an OS timezone change until the process restarts.
  const deviceTz = state.deviceTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  dom.deviceTimeEl.textContent = deviceNow.toLocaleTimeString(undefined, {
    timeZone: deviceTz,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  });
  dom.deviceTimezoneEl.textContent = getDisplayTimezoneName(deviceTz);
  // The date, but only when the device is on a different day from the ground.
  // Crossing a date line or sitting near midnight is exactly when "8:15" on two
  // cards means two different things, and a bare time cannot say so.
  showDateWhenItDiffers(dom.deviceDateEl, writtenDate(deviceNow, deviceTz),
                        dom.localDateEl.textContent ?? '');

  dom.timeLoader.classList.add('hidden');
  dom.timeContent.classList.remove('hidden');
}

/**
 * Renders an hours difference as "+3 hrs" / "−5½ hrs" / "+0 hrs".
 *
 * Split out from getTimezoneOffset so a ship can use it too. A ship's offset is
 * a plain number rather than a zone, so it has no pair of ids to compare — but
 * the presentation has to match the zone rows it sits beside in the same list.
 */
export function formatOffsetDiff(diffHours: number): string {
  if (diffHours === 0) return '+0 hrs';

  const sign = diffHours > 0 ? '+' : '−';
  const absoluteOffset = Math.abs(diffHours);
  const hours = Math.floor(absoluteOffset);
  const fraction = absoluteOffset - hours;
  let hourString = '';

  if (hours > 0) {
    hourString += hours;
  }

  if (fraction === 0.5) {
    hourString += '½';
  } else if (fraction === 0.75) {
    hourString += '¾';
  } else if (fraction === 0.25) {
    hourString += '¼';
  }

  const pluralization = absoluteOffset > 1 ? 's' : '';

  return `${sign}${hourString} hr${pluralization}`;
}

/**
 * The Ship Time section, shown only while a ship is detected.
 *
 * Deliberately does NOT merge with Local Time when the two read the same — that
 * is the widget's behaviour, where a row is worth saving. Here the card has
 * room, and a heading that always means one thing is clearer than one that
 * sometimes means two.
 *
 * Visibility follows `aboardShipKey`, which only ever changes on a definite
 * gateway marker: no signal means unknown, so the section survives wi-fi being
 * off aboard, and disappears when a `shore` marker actually arrives.
 */
function renderShipTime(at: Date): void {
  const ship = aboardShip();

  if (!ship) {
    dom.shipTimeSectionEl.classList.add('hidden');
    return;
  }

  dom.shipTimeSectionEl.classList.remove('hidden');
  dom.shipNameEl.textContent = ship.name;

  if (ship.offsetHours === null) {
    dom.shipDateEl.classList.add('hidden');
    // Detected, but the offset has not resolved. Never fill this with the
    // embark-port zone or any other guess: a blank is honest and
    // self-explanatory, a wrong time is neither.
    dom.shipTimeEl.textContent = '--:--:--';
    return;
  }

  dom.shipTimeEl.textContent = formatFixedOffsetTime(ship.offsetHours, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }, at);
  // Aboard, a ship an hour or two off the ground is routine and a ship on
  // tomorrow's date is the reason anybody misses a gangway.
  showDateWhenItDiffers(dom.shipDateEl, formatFixedOffsetDate(ship.offsetHours, at),
                        dom.localDateEl.textContent ?? '');
}

/**
 * The clock every offset is measured from.
 *
 * Ashore that is the ground you stand on. Aboard — and only when the wifi marker
 * has confirmed it — it is the ship, because ship time is what every
 * announcement, dinner booking and gangway time is quoted in, while the
 * geographic zone under a hull is often one nobody observes.
 *
 * Absolute times are untouched by this. The Local, Ship and Device cards each
 * state a real clock and are labelled; only things expressing a DIFFERENCE
 * re-base, which is what keeps the change to one idea.
 */
export function anchorOffsetHours(): number {
  const ship = aboardShip();
  if (ship && ship.offsetHours !== null) return ship.offsetHours;
  return state.localTimezone ? getUtcOffset(state.localTimezone) : 0;
}

/**
 * What the map is currently reporting as selected.
 *
 * ONE definition, because three layers have to agree about it: the zone shapes
 * paint a band from the offset, the clock rows border from the identity, and
 * the ship markers now colour from the offset too. Two copies of this
 * precedence would drift, and a drift here looks like the map disagreeing with
 * itself about what you just clicked.
 *
 * `tzid` is null for anything that is not a region — a ship keeps a time without
 * occupying a zone, and a port is a point inside one rather than the whole of
 * it. Both still light the BAND, which is the map's way of saying "everywhere
 * that keeps this time"; only a zone selection ever goes solid.
 *
 * Precedence is most-specific-first. A port outranks the ship it belongs to
 * because the port is the thing that was picked and the cruise is the context
 * around it.
 */
export function mapSelection(): { tzid: string | null; offset: number | null } {
  const port = state.selectedPort;
  if (port) return { tzid: null, offset: getUtcOffset(port.tzid) };

  if (state.selectedShipKey) {
    const ship = state.shipClocks.find((s) => shipKey(s) === state.selectedShipKey);
    // No offset until one resolves — otherwise an unresolved ship reads as 0
    // and lights up UTC.
    return { tzid: null, offset: ship?.offsetHours ?? null };
  }

  // The GPS zone is shown as "selected" (gold) while it is the active choice.
  const tzid = state.gpsTimezoneSelected ? state.gpsTzid : state.selectedTzid;
  return { tzid, offset: tzid ? getUtcOffset(tzid) : null };
}

/** A saved zone's standing relative to the anchor. *//** A saved zone's standing relative to the anchor. */
export function relativeTextForZone(tzid: string): string {
  const ship = aboardShip();
  // Ashore the anchor IS the local zone, and the existing helper already says
  // "Local time" rather than "+0 hrs" for it.
  if (!ship || ship.offsetHours === null) return getTimezoneOffset(tzid, state.localTimezone);
  try {
    return formatOffsetDiff(getUtcOffset(tzid) - ship.offsetHours);
  } catch {
    return 'Offset N/A';
  }
}

/** A ship's standing. The one underfoot names itself instead of measuring. */
export function relativeTextForShip(ship: { brand: string; code: string; offsetHours: number }): string {
  const aboard = aboardShip();
  if (aboard && shipKey(aboard) === shipKey(ship)) return 'Ship time';
  return formatOffsetDiff(ship.offsetHours - anchorOffsetHours());
}

export function getTimezoneOffset(tz1: string, tz2: string | null): string {
  if (!tz2) return '';
  if (tz1 === tz2) return 'Local time';

  try {
    return formatOffsetDiff(getUtcOffset(tz1) - getUtcOffset(tz2));
  } catch (e) {
    return 'Offset N/A';
  }
}

export function startClocks() {
  if (state.clocksInterval) window.clearTimeout(state.clocksInterval);
  updateAllClocks();
  scheduleNextTick();
}

/**
 * Repaints just after each second boundary, rather than every 1000 ms from
 * whenever the app happened to start.
 *
 * A free-running interval keeps whatever phase it was created with. Start at
 * .384 of a second and every repaint lands at .384 forever: the digits are
 * correct when they are written, but they are written up to a second after the
 * moment they became true, so the app sits visibly behind a clock that ticks on
 * the boundary — the OS menu bar, or any other clock on the desk. Reported as
 * "about a second off" with all three cards agreeing with each other, which is
 * exactly the signature: one shared phase error, not three disagreeing clocks.
 *
 * Recomputed from the clock each time rather than chained at a fixed 1000 ms, so
 * it cannot accumulate the drift setInterval is prone to, and so a tab that was
 * throttled in the background re-aligns on its first tick back.
 *
 * Measured against the CORRECTED clock, since that is what the app draws: if
 * the device is a quarter-second fast and we know it, the digits should still
 * turn over when the true second does.
 *
 * The few ms past the boundary are deliberate. Timers fire no earlier than
 * asked but routinely a shade late, and landing a hair early would render the
 * second that is about to end — the one failure this is meant to remove.
 */
function scheduleNextTick(): void {
  state.clocksInterval = window.setTimeout(() => {
    updateAllClocks();
    scheduleNextTick();
  }, msUntilNextSecond(Date.now() + state.timeOffset));
}

/**
 * The zone for a position, derived entirely on device.
 *
 * The bundled boundaries answer this essentially everywhere. Sampled at 200,000
 * equal-area points, zero fall outside every polygon — which bounds the total
 * uncovered area at roughly 7,651 km2 (95%, rule of three), or 0.0015% of Earth.
 * The fallback is the nautical convention those same polygons encode: 15-degree
 * bands centred on each multiple of 15. Checked against the ocean polygons at
 * 813 sampled points, the formula reproduces them exactly.
 *
 * This used to claim 99.85% and blame slivers along the antimeridian. Then it
 * claimed 99.998% and blamed four strips off Antarctica. Both were wrong, and
 * wrong because of the measuring, not the data: mapshaper's -erase-from-a-world-
 * rectangle SNAPS slivers away and reports none where real ones exist, while its
 * -mosaic n=0 tiles INVENT them — it labelled 6,314 km2 off Enderby Land
 * uncovered where dense point sampling finds one uncovered sample in 48,000.
 *
 * If you need to check this, ask booleanPointInPolygon, because that is the
 * question the lookup actually asks. Nothing else has been trustworthy here.
 *
 * The fallback stays regardless. A real hole DID appear once, in the
 * Belgium/Germany border near Eupen, cut by a subtractive boolean in the build;
 * point sampling found 3.4% of that area answering nothing. Small holes are
 * invisible to any global sweep, so the fallback is what makes the lookup total
 * rather than merely well-tested.
 *
 * Deliberately offline and deliberately total. This app exists because network
 * time was wrong at sea, so the one thing the timezone must never depend on is
 * a network answer — including a fallback that only fires when we are already
 * somewhere remote.
 */
export function timezoneForCoordinates(lat: number, lon: number): string {
  return findTimezoneFromGeoJSON(lat, lon) ?? nauticalTimezone(lon);
}

/**
 * UTC offset in hours of the zone a coordinate stands in, or null.
 *
 * Null rather than a fallback, because the two callers both need to know they
 * did not get an answer: one omits its " port time" qualifier and the other
 * leans on the ship's own offset instead. Only ever null before the boundary
 * data has loaded — the lookup itself covers the globe.
 */
export function utcOffsetForCoordinates(lat: number, lon: number): number | null {
  const tz = zoneForCoordinates(lat, lon);
  return tz ? getUtcOffset(tz) : null;
}

/**
 * findTimezoneFromGeoJSON with a memo, because the callers repeat themselves.
 *
 * The lookup walks polygons until one contains the point, and the chart asks it
 * for the same handful of ports on every redraw while the card row asks it for
 * every ship on the list on every tick. Same question, same answer, several
 * hundred polygon tests each time.
 *
 * Keyed on the dataset object as well as the point, so a reload replaces the
 * memo along with the data and nothing has to remember to clear it — the same
 * trick the feature ordering above uses.
 */
let zoneMemoFrom: unknown = null;
let zoneMemo = new Map<string, string | null>();

export function zoneForCoordinates(lat: number, lon: number): string | null {
  if (zoneMemoFrom !== state.geoJsonData) {
    zoneMemoFrom = state.geoJsonData;
    zoneMemo = new Map();
  }
  // Four decimals is about 11 m, which is finer than any coordinate we are
  // given and far finer than any zone boundary.
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const hit = zoneMemo.get(key);
  if (hit !== undefined) return hit;
  const tz = findTimezoneFromGeoJSON(lat, lon);
  zoneMemo.set(key, tz);
  return tz;
}

/** Nautical time: 15° bands, POSIX-inverted (Etc/GMT-1 is UTC+1). */
export function nauticalTimezone(lon: number): string {
  // Clamped rather than wrapped: ±180 is the dateline, and the two ±12 bands
  // meet there, so each side keeps its own.
  const hours = Math.max(-12, Math.min(12, Math.round(lon / 15)));
  if (hours === 0) return 'Etc/GMT';
  return `Etc/GMT${hours > 0 ? '-' : '+'}${Math.abs(hours)}`;
}
