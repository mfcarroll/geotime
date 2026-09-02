// src/state.ts

import { syncWidgetTimezones } from './widget';
import { newShipClock, shipKey, type ShipClock, type ShipRef } from './ships';

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
     * Ships on the clock list. Kept apart from `addedTimezones` because a ship
     * is not a zone: it carries an offset, a provenance and a freshness that no
     * id string can hold, and mixing them would mean a synthetic zone id parsed
     * by hand on three platforms — the exact thing 1.3.0 removed.
     */
    shipClocks: ShipClock[];
    /**
     * The ship we believe the user is currently on, by "brand/code" key.
     *
     * Persisted, and mutated ONLY by a definite gateway marker. Absence of a
     * signal — wi-fi off, a cabin dead spot, a captive portal, no data at all —
     * means *unknown*, never "ashore", so it leaves this untouched. That single
     * rule gives stickiness and liveness at once: the Ship Time section survives
     * a dropped connection aboard, and disappears when a `shore` marker actually
     * arrives, with no threshold to tune.
     *
     * The failure mode also lands the right way up. Someone in a foreign port
     * with a dead phone keeps a prominent ship clock, which is the one number
     * they need — all-aboard time.
     */
    aboardShipKey: string | null;
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

/**
 * Ship records written by a previous run.
 *
 * Validated field by field rather than trusted, because a partially-written or
 * downgraded record must not reach the widget bridge — a ship with a bad offset
 * would render a confident wrong time, which is the one failure this app exists
 * to avoid.
 */
function loadStoredShips(): ShipClock[] {
    try {
        const raw = JSON.parse(localStorage.getItem('shipClocks') || '[]');
        if (!Array.isArray(raw)) return [];
        const out: ShipClock[] = [];
        for (const entry of raw) {
            if (!entry || typeof entry.code !== 'string' || !/^[A-Z]{2}$/.test(entry.code)) continue;
            if (entry.brand !== 'R' && entry.brand !== 'C') continue;
            if (typeof entry.name !== 'string' || !entry.name) continue;
            if (out.some((s) => shipKey(s) === shipKey(entry))) continue;
            out.push({
                code: entry.code,
                brand: entry.brand,
                name: entry.name,
                short: typeof entry.short === 'string' && entry.short ? entry.short : entry.name,
                offsetHours: Number.isFinite(entry.offsetHours) ? entry.offsetHours : null,
                fetchedAt: Number.isFinite(entry.fetchedAt) ? entry.fetchedAt : null,
                source: typeof entry.source === 'string' ? entry.source : null,
                overrideActive: entry.overrideActive === true,
                autoAdded: entry.autoAdded === true,
                voyageEnd: typeof entry.voyageEnd === 'string' && /^\d{8}$/.test(entry.voyageEnd)
                    ? entry.voyageEnd
                    : null,
            });
        }
        return out;
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
    shipClocks: loadStoredShips(),
    aboardShipKey: localStorage.getItem('aboardShipKey') || null,
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

/**
 * Pushes everything the home-screen widgets need, read from state.
 *
 * Takes no arguments on purpose. This used to be called with four parallel
 * arguments from four places, and adding ships as a fifth would have meant every
 * caller remembering to pass them — where forgetting once silently blanks the
 * ships on someone's home screen. Reading state here makes that impossible.
 */
export function syncWidget(): void {
    syncWidgetTimezones({
        timezones: state.addedTimezones,
        labels: state.zoneLabels,
        localTimezone: state.localTimezone,
        localPlaceName: state.localPlaceName,
        ships: state.shipClocks,
    });
}

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

    syncWidget();
}

/** Single write path for the ship list. Mirrors persistTimezones. */
export function persistShipClocks(ships: ShipClock[]): void {
    state.shipClocks = ships;
    localStorage.setItem('shipClocks', JSON.stringify(ships));
    syncWidget();
}

/**
 * Adds a ship, or returns the existing record if it is already on the list.
 *
 * `autoAdded` is never downgraded: a ship the user later searches for by hand
 * stays flagged as detected, because that flag is what bounds the background
 * offset re-check to the voyage they actually boarded.
 */
export function addShipClock(ship: ShipRef, autoAdded = false): ShipClock {
    const existing = state.shipClocks.find((s) => shipKey(s) === shipKey(ship));
    if (existing) return existing;

    const clock = newShipClock(ship, autoAdded);
    persistShipClocks([...state.shipClocks, clock]);
    announceShipClocks();
    return clock;
}

/** Removes a ship by "brand/code" key. */
export function removeShipClock(key: string): void {
    persistShipClocks(state.shipClocks.filter((s) => shipKey(s) !== key));
    announceShipClocks();
}

/**
 * Says the list changed, for anything drawing from it.
 *
 * Only membership, not offset writes — those already announce themselves from
 * shiptime.ts once a resolve pass finishes, and announcing each one here would
 * re-render the list per ship instead of once. The distinction matters because
 * the map's marker layer needs the membership signal and had no way to hear it:
 * adding a ship from the search box goes through here and nowhere near
 * shiptime.ts.
 */
function announceShipClocks(): void {
    document.dispatchEvent(new CustomEvent('shipclockschanged'));
}

/**
 * Writes a resolved offset back, if the ship is still on the list.
 *
 * Guarded because resolution is asynchronous and the user may have removed the
 * row while the request was in flight — re-adding it here would resurrect a
 * clock they had just deleted.
 */
export function updateShipClock(clock: ShipClock): void {
    patchShipClock(shipKey(clock), clock);
}

/**
 * Merges fields into a stored ship record.
 *
 * Merging rather than replacing, because two independent async writers touch the
 * same ship on detection: one pins the voyage and one resolves the offset. Each
 * held a copy captured before the other had written, so the second to finish
 * silently reverted the first — the pinned voyage came back as null. Reading the
 * current record here makes that impossible regardless of ordering.
 *
 * Also guarded on existence: the user may have removed the row while a request
 * was in flight, and re-adding it here would resurrect a clock they just deleted.
 */
export function patchShipClock(key: string, patch: Partial<ShipClock>): void {
    if (!state.shipClocks.some((s) => shipKey(s) === key)) return;
    persistShipClocks(state.shipClocks.map((s) =>
        shipKey(s) === key ? { ...s, ...patch, code: s.code, brand: s.brand } : s));
}

/**
 * Records which ship we are aboard, or clears it.
 *
 * Only ever called with a definite answer. See AppState.aboardShipKey for why
 * "no signal" must not reach this function at all.
 */
export function setAboardShip(key: string | null): void {
    if (state.aboardShipKey === key) return;
    state.aboardShipKey = key;
    if (key) localStorage.setItem('aboardShipKey', key);
    else localStorage.removeItem('aboardShipKey');
    // The widget's row rule depends on this: aboard, an agreeing ship is folded
    // into the base row rather than shown twice.
    syncWidget();
    document.dispatchEvent(new CustomEvent('aboardshipchanged'));
}

/** The ship record we are aboard, if any. */
export function aboardShip(): ShipClock | null {
    if (!state.aboardShipKey) return null;
    return state.shipClocks.find((s) => shipKey(s) === state.aboardShipKey) ?? null;
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
