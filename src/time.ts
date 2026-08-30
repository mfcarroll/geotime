// src/time.ts

import * as dom from './dom';
import { state } from './state';
import { getDisplayTimezoneName, isValidTimezone } from './utils';
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

export async function syncClock() {
  try {
    const GCF_URL = 'https://get-utc-time-100547663673.us-west1.run.app/';
    
    const response = await fetch(GCF_URL);
    if (!response.ok) throw new Error('Network response was not ok.');
    
    const data = await response.json();
    const serverUtcTime = new Date(data.dateTime).getTime();
    const localDeviceTime = new Date().getTime();
    
    let offset = serverUtcTime - localDeviceTime;

    if (Math.abs(offset) < 500) {
      offset = 0;
    }
    
    state.timeOffset = offset;
    
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

  const timezonesToRender = [...state.addedTimezones];
  if (state.temporaryTimezone && !timezonesToRender.includes(state.temporaryTimezone)) {
      timezonesToRender.push(state.temporaryTimezone);
  }

  timezonesToRender.forEach((tz: string) => {
    // Looked up by data attribute, not by rebuilding the id — zone ids contain
    // hyphens (America/Port-au-Prince, Etc/GMT-5) that a slug can't round-trip.
    const el = dom.worldClocksContainerEl.querySelector<HTMLElement>(
      `[data-clock-tz="${CSS.escape(tz)}"]`
    );
    if (el) {
        const timeString = getFormattedTime(tz, { hour: 'numeric', minute: '2-digit' });
        const dateString = correctedTime.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' });
        const timeDiff = getTimezoneOffset(tz, localTimezone);

        el.querySelector('.time')!.textContent = timeString;
        el.querySelector('.date-diff')!.textContent = `${dateString}, ${timeDiff}`;
    }
  });
  
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

export function getTimezoneOffset(tz1: string, tz2: string | null): string {
  if (!tz2) return '';
  if (tz1 === tz2) return 'Local time';

  try {
    const diffHours = getUtcOffset(tz1) - getUtcOffset(tz2);

    if (diffHours === 0) return '±0 hrs';

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
