// src/state.ts

import { syncWidgetTimezones } from './widget';

export interface AppState {
    timeOffset: number;
    localTimezone: string | null;
    deviceTimezone: string | null;   // OS timezone reported by native (may differ from localTimezone)
    gpsTzid: string | null;
    addedTimezones: string[];
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

/**
 * Repairs a stored zone list written by older builds.
 *
 * Pre-rebuild the app synthesised `Etc/GMT±N.N` ids for map features that had no
 * name and a fractional offset. Those are not valid tzdb ids — `Intl` throws on
 * them — so they were carried by hand-written parsers on three platforms. They
 * are rounded to the nearest valid whole-hour zone here and the parsers dropped.
 */
export function migrateStoredTimezones(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'string' || !entry.trim()) continue;
        let id = entry;
        const fractional = id.match(/^Etc\/GMT([+-])(\d+)\.\d+$/);
        if (fractional) id = `Etc/GMT${fractional[1]}${fractional[2]}`;
        try {
            new Intl.DateTimeFormat('en-US', { timeZone: id });
        } catch {
            continue; // unrecoverable; drop rather than poison the widget
        }
        if (!out.includes(id)) out.push(id);
    }
    return out;
}

function loadStoredTimezones(): string[] {
    try {
        return migrateStoredTimezones(JSON.parse(localStorage.getItem('worldClocks') || '[]'));
    } catch {
        return [];
    }
}

export const state: AppState = {
    timeOffset: 0,
    localTimezone: null,
    deviceTimezone: null,
    gpsTzid: null,
    addedTimezones: loadStoredTimezones(),
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
    localStorage.setItem('worldClocks', JSON.stringify(timezones));
    syncWidgetTimezones(timezones, state.localTimezone);
}
