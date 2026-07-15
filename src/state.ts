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
    hoveredZone: number | null;
    selectedZone: number | null;
    gpsZone: number | null;
    temporaryTimezone: string | null;
    hoveredTimezoneName: string | null;
    gpsTimezoneSelected: boolean;
    timezonesFromUrl: string[] | null;
}

export const state: AppState = {
    timeOffset: 0,
    localTimezone: null,
    deviceTimezone: null,
    gpsTzid: null,
    addedTimezones: JSON.parse(localStorage.getItem('worldClocks') || '[]'),
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
    hoveredZone: null,
    selectedZone: null,
    gpsZone: null,
    temporaryTimezone: null,
    hoveredTimezoneName: null,
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