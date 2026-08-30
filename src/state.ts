// src/state.ts

import { syncWidgetTimezones } from './widget';

export interface AppState {
    timeOffset: number;
    localTimezone: string | null;
    deviceTimezone: string | null;   // OS timezone reported by native (may differ from localTimezone)
    gpsTzid: string | null;
    /**
     * Nearest town to the GPS fix inside the GPS zone; null when none is close.
     * Persisted so a relaunch can hand the widget the last known place instead
     * of blanking it until a fresh fix arrives.
     */
    localPlaceName: string | null;
    addedTimezones: string[];
    /**
     * Zone id -> the place the user actually picked. Searching "Nelson" stores
     * America/Vancouver but should keep saying Nelson; without this every clock
     * is named after whichever city happens to name its zone.
     */
    zoneLabels: Record<string, string>;
    clocksInterval: number | null;
    locationMap: google.maps.Map | null;
    timezoneMap: google.maps.Map | null;
    locationMarker: google.maps.Marker | null;
    timezoneMapMarker: google.maps.Marker | null;
    accuracyCircle: google.maps.Circle | null;
    locationAvailable: boolean;
    initialLocationSet: boolean;
    mapsReady: boolean;
    lastFetchedCoords: { lat: number, lon: number } | null;
    geoJsonData: any | null;
    geoJsonLoaded: boolean;
    // Zones are identified by IANA id, not by current UTC offset. Two zones can
    // share an offset today and diverge in November; keying on the offset made
    // them interchangeable and let the map overwrite a specific choice
    // (America/Vancouver) with a band's representative zone.
    hoveredTzid: string | null;
    selectedTzid: string | null;
    temporaryTimezone: string | null;
    gpsTimezoneSelected: boolean;
    timezonesFromUrl: string[] | null;
}

export interface StoredZone {
    tz: string;
    label?: string;
}

/**
 * Repairs a stored zone list written by older builds.
 *
 * Pre-rebuild the app synthesised `Etc/GMT±N.N` ids for map features that had no
 * name and a fractional offset. Those are not valid tzdb ids — `Intl` throws on
 * them — so they were carried by hand-written parsers on three platforms. They
 * are rounded to the nearest valid whole-hour zone here and the parsers dropped.
 */
export function migrateStoredTimezones(raw: unknown): StoredZone[] {
    if (!Array.isArray(raw)) return [];
    const out: StoredZone[] = [];
    for (const entry of raw) {
        // Older builds stored bare id strings; newer ones store {tz, label}.
        const source = typeof entry === 'string' ? { tz: entry } : entry;
        if (!source || typeof source.tz !== 'string' || !source.tz.trim()) continue;

        let id = source.tz;
        const fractional = id.match(/^Etc\/GMT([+-])(\d+)\.\d+$/);
        if (fractional) id = `Etc/GMT${fractional[1]}${fractional[2]}`;
        try {
            new Intl.DateTimeFormat('en-US', { timeZone: id });
        } catch {
            continue; // unrecoverable; drop rather than poison the widget
        }
        if (out.some((z) => z.tz === id)) continue;
        out.push(typeof source.label === 'string' && source.label.trim()
            ? { tz: id, label: source.label }
            : { tz: id });
    }
    return out;
}

function loadStoredTimezones(): StoredZone[] {
    try {
        return migrateStoredTimezones(JSON.parse(localStorage.getItem('worldClocks') || '[]'));
    } catch {
        return [];
    }
}

const stored = loadStoredTimezones();

export const state: AppState = {
    timeOffset: 0,
    localTimezone: null,
    deviceTimezone: null,
    gpsTzid: null,
    localPlaceName: localStorage.getItem('localPlaceName') || null,
    addedTimezones: stored.map((z) => z.tz),
    zoneLabels: Object.fromEntries(
        stored.flatMap((z) => (z.label ? [[z.tz, z.label]] : []))),
    clocksInterval: null,
    locationMap: null,
    timezoneMap: null,
    locationMarker: null,
    timezoneMapMarker: null,
    accuracyCircle: null,
    locationAvailable: false,
    initialLocationSet: false,
    mapsReady: false,
    lastFetchedCoords: null,
    geoJsonData: null,
    geoJsonLoaded: false,
    hoveredTzid: null,
    selectedTzid: null,
    temporaryTimezone: null,
    gpsTimezoneSelected: false,
    timezonesFromUrl: null,
};

// Single write path for the saved timezone list: updates state, persists to
// localStorage, and mirrors the list to the native home-screen widgets.
export function persistTimezones(timezones: string[]): void {
    state.addedTimezones = timezones;

    // Drop labels for zones no longer on the list, so removing and re-adding a
    // zone doesn't resurrect an old name.
    for (const tz of Object.keys(state.zoneLabels)) {
        if (!timezones.includes(tz)) delete state.zoneLabels[tz];
    }

    const payload: StoredZone[] = timezones.map((tz) =>
        state.zoneLabels[tz] ? { tz, label: state.zoneLabels[tz] } : { tz });
    localStorage.setItem('worldClocks', JSON.stringify(payload));

    // The widgets take plain ids. Labels reach them in the widget work; sending
    // the richer shape now would break the build already on people's phones.
    syncWidgetTimezones(timezones, state.localTimezone, state.localPlaceName, state.zoneLabels);
}

/** Single write path for the resolved local place name (see AppState). */
export function setLocalPlaceName(name: string | null): void {
    state.localPlaceName = name;
    if (name) localStorage.setItem('localPlaceName', name);
    else localStorage.removeItem('localPlaceName');
}

/** Records the name the user picked for a zone (see AppState.zoneLabels). */
export function setZoneLabel(tzid: string, label: string | undefined): void {
    if (label && label !== tzid) state.zoneLabels[tzid] = label;
    else delete state.zoneLabels[tzid];
}
