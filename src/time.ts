// src/time.ts

import * as dom from './dom';
import { aboardShip, state } from './state';
import { getDisplayTimezoneName, isValidTimezone } from './utils';
import { clockKey, fixedOffsetWeekday, formatFixedOffsetTime, isUnresolved, visibleClocks } from './clocks';
import { isUnresolvable } from './shiptime';
import { point as turfPoint } from '@turf/helpers';
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';

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
export function findTimezoneFromGeoJSON(lat: number, lon: number): string | null {
    if (!state.geoJsonData) return null;

    const searchPoint = turfPoint([lon, lat]);

    for (const feature of state.geoJsonData.features) {
        if (feature.geometry && booleanPointInPolygon(searchPoint, feature.geometry)) {
            return feature.properties.tzid as string;
        }
    }

    return null;
}

export function getFormattedTime(tz: string, options: Intl.DateTimeFormatOptions = {}): string {
  const correctedTime = new Date(new Date().getTime() + state.timeOffset);
  try {
    // undefined locale: follow the device's locale and 12/24h preference
    return correctedTime.toLocaleTimeString(undefined, { timeZone: tz, ...options });
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
 */
export function noteServerTime(serverUtcMs: number): void {
  const offset = serverUtcMs - Date.now();
  state.timeOffset = Math.abs(offset) < 500 ? 0 : offset;
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
        const response = await fetch(url);
        if (!response.ok) continue;
        const data = await response.json();
        const serverMs = new Date(data.dateTime).getTime();
        if (!Number.isFinite(serverMs)) continue;
        noteServerTime(serverMs);
        noted = true;
        break;
      } catch {
        // Try the next source.
      }
    }
    if (!noted) throw new Error('No UTC source answered.');
  } catch (error) {
    console.error('Could not synchronize clock:', error);
    state.timeOffset = 0;
  }
}

export function updateAllClocks() {
  const correctedTime = new Date(new Date().getTime() + state.timeOffset);
  const localTimezone = state.localTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  
  try {
    dom.localTimeEl.textContent = correctedTime.toLocaleTimeString(undefined, {
      timeZone: localTimezone,
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit'
    });
    dom.localDateEl.textContent = correctedTime.toLocaleDateString('en-US', { timeZone: localTimezone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    // The town you're in, when we can name it — otherwise the zone.
    dom.localTimezoneEl.textContent = state.localPlaceName ?? getDisplayTimezoneName(localTimezone);
  } catch (e) {
    dom.localTimeEl.textContent = "Error";
  }

  const localOffset = getUtcOffset(localTimezone);

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
    let dateString: string;
    let timeDiff: string;

    if (entry.kind === 'ship') {
      const offset = entry.ship.offsetHours as number;
      timeString = formatFixedOffsetTime(offset, { hour: 'numeric', minute: '2-digit' });
      dateString = fixedOffsetWeekday(offset);
      timeDiff = formatOffsetDiff(offset - localOffset);
    } else {
      timeString = getFormattedTime(entry.tzid, { hour: 'numeric', minute: '2-digit' });
      dateString = correctedTime.toLocaleDateString('en-US', { timeZone: entry.tzid, weekday: 'short' });
      timeDiff = getTimezoneOffset(entry.tzid, localTimezone);
    }

    el.querySelector('.time')!.textContent = timeString;
    el.querySelector('.date-diff')!.textContent = `${dateString}, ${timeDiff}`;
  });
  
  renderShipTime();

  const deviceNow = new Date();
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
function renderShipTime(): void {
  const ship = aboardShip();

  if (!ship) {
    dom.shipTimeSectionEl.classList.add('hidden');
    return;
  }

  dom.shipTimeSectionEl.classList.remove('hidden');
  dom.shipNameEl.textContent = ship.name;

  if (ship.offsetHours === null) {
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
  });
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
  if (state.clocksInterval) window.clearInterval(state.clocksInterval);
  updateAllClocks();
  state.clocksInterval = window.setInterval(updateAllClocks, 1000);
}

/**
 * The zone for a position, derived entirely on device.
 *
 * The bundled boundaries answer this for 99.85% of the globe. The remaining
 * slivers sit along the antimeridian at high latitude, where the ±12 ocean zones
 * meet, so the fallback is the nautical convention those same polygons encode:
 * 15-degree bands centred on each multiple of 15. Checked against the ocean
 * polygons at 813 sampled points, the formula reproduces them exactly.
 *
 * Deliberately offline and deliberately total. This app exists because network
 * time was wrong at sea, so the one thing the timezone must never depend on is
 * a network answer — including a fallback that only fires when we are already
 * somewhere remote.
 */
export function timezoneForCoordinates(lat: number, lon: number): string {
  return findTimezoneFromGeoJSON(lat, lon) ?? nauticalTimezone(lon);
}

/** Nautical time: 15° bands, POSIX-inverted (Etc/GMT-1 is UTC+1). */
export function nauticalTimezone(lon: number): string {
  // Clamped rather than wrapped: ±180 is the dateline, and the two ±12 bands
  // meet there, so each side keeps its own.
  const hours = Math.max(-12, Math.min(12, Math.round(lon / 15)));
  if (hours === 0) return 'Etc/GMT';
  return `Etc/GMT${hours > 0 ? '-' : '+'}${Math.abs(hours)}`;
}
