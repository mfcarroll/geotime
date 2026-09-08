// src/state.ts

import { migrateFollowedPeople, type FollowedPerson } from './people';
import { migrateStoredTimezones, zoneKey, type StoredZone } from './stored-zones';
export { migrateStoredTimezones, type StoredZone };
export type { FollowedPerson };
import { syncWidgetTimezones } from './widget';
import { loadShipRoster, newShipClock, shipKey, type ShipClock, type ShipRef } from './ships';
import type { DeviceFix } from './ship-position';
import { debugFlag } from './utils';

export interface AppState {
    timeOffset: number;
    localTimezone: string | null;
    deviceTimezone: string | null;   // OS timezone reported by native (may differ from localTimezone)
    gpsTzid: string | null;
    /**
     * The last device fix, kept for position-based ship detection.
     *
     * Not persisted: a fix from a previous session says where the device was,
     * and the one question this answers is where it is now. Stale here would
     * mean claiming to be aboard a ship left yesterday.
     */
    deviceFix: DeviceFix | null;
    /**
     * Nearest town to the GPS fix inside the GPS zone; null when none is close.
     * Persisted so a relaunch can hand the widget the last known place instead
     * of blanking it until a fresh fix arrives.
     */
    localPlaceName: string | null;
    /**
     * The World Clock list: one record per PLACE, in the order added.
     *
     * A LIST, not a set of zones, and that is the whole of the model. Tampa is
     * a city in the New York timezone; it is not a name for the New York
     * timezone. While this was `string[]` with a label map beside it, saying
     * "Tampa" renamed America/New_York on every surface — the row, the map
     * card, both widgets — and adding New York afterwards silently replaced it.
     * Tapping a port on the map did the same to whatever zone it stood in,
     * which is how "Cabo San Lucas" came to be the name of a timezone.
     *
     * Identity is zoneKey(): the zone where the row IS the zone, the zone plus
     * the name where it is a place inside one.
     */
    savedZones: StoredZone[];
    /**
     * Ships on the clock list. Kept apart from `savedZones` because a ship
     * is not a zone: it carries an offset, a provenance and a freshness that no
     * id string can hold, and mixing them would mean a synthetic zone id parsed
     * by hand on three platforms — the exact thing 1.3.0 removed.
     */
    shipClocks: ShipClock[];
    /**
     * What you call yourself to the people you share with.
     *
     * The only thing about you that this app ever sends anywhere by name, and
     * it is sent because the alternative is worse: a row arriving on somebody's
     * phone with nothing on it but a clock. Whatever they end up calling you is
     * then theirs to choose.
     *
     * Null until asked for, which is the first time somebody shares.
     */
    shareName: string | null;
    /**
     * Whether followers are told WHICH timezone, or only how far from UTC.
     *
     * False by default, and the default is the point: an offset says what time
     * it is for you and nothing about where on earth you are. True hands over
     * the zone id, which is a region rather than a place but is still more than
     * nothing — so it is a choice, made once, applying to everybody.
     *
     * Enforced at the relay rather than here; see anchorAsSeen. This copy is
     * what the switch on screen reads and what gets pushed.
     */
    shareExact: boolean;
    /**
     * People whose anchor is shared with this device.
     *
     * Held here, not fetched on demand, for the reason the fleet cache is: a
     * launch with no signal should show the rows it had, aged, rather than an
     * empty list. Half of each record is yours — the name — and never leaves
     * the device; see people.ts.
     */
    followedPeople: FollowedPerson[];
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
    /** Handle for the self-rescheduling clock tick; see scheduleNextTick. */
    clocksInterval: number | null;
    locationMap: google.maps.Map | null;
    timezoneMap: google.maps.Map | null;
    locationMarker: google.maps.marker.AdvancedMarkerElement | null;
    timezoneMapMarker: google.maps.marker.AdvancedMarkerElement | null;
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
    /**
     * The BAND the pointer is over, when there is one without a zone to name.
     *
     * Ordinarily it is just the hovered zone's own band and moves with it. The
     * case it exists for is a followed person: their band should light and
     * their zone must not be named, because the app knows they are somewhere at
     * UTC−8 and deliberately declines to say Vancouver or Seattle. See
     * resolveZoneStyle, where an outline is the thing that names one zone.
     */
    hoveredOffset: number | null;
    /**
     * The hull the pointer is over, beside the zone it is over.
     *
     * Here rather than in map.ts because the marker layer has to style itself from
     * it and must not import from map.ts — map.ts imports from IT. Same reason
     * hoveredTzid sits here.
     */
    hoveredShipKey: string | null;
    selectedTzid: string | null;
    /**
     * The followed person whose band is on the map, by share id.
     *
     * A key rather than the record, so it cannot go stale against the list the
     * relay keeps rewriting underneath it. Mutually exclusive with every other
     * selection, as they all are with each other.
     */
    selectedPersonKey: string | null;
    /**
     * A place picked on the map but not kept, shown as one extra row with a pin.
     *
     * A whole record rather than a zone id, which is what stops a look costing a
     * rename: showing "Cabo San Lucas" for a moment used to mean WRITING that
     * name onto its zone, because the row could only be named through the label
     * map. Now the transient row carries its own name and goes when it goes.
     */
    temporaryZone: StoredZone | null;
    gpsTimezoneSelected: boolean;
    /**
     * Ship whose band is highlighted, as a "R/ST" key, or null.
     *
     * Mutually exclusive with the zone selection above — selecting either clears
     * the other, because the map paints one gold band and there is only one
     * "selected" card to name it. Deliberately NOT persisted: a highlight is a
     * question you are asking right now, not a preference.
     */
    selectedShipKey: string | null;
    /**
     * The port of call the user picked, or null.
     *
     * Deliberately NOT a zone selection. A port is a point, and lighting the
     * whole of America/Cancun gold because someone tapped Cozumel answers a
     * question they did not ask — the zone is not the place. It is also
     * deliberately not exclusive with `selectedShipKey`: a port belongs to an
     * itinerary, so picking one is a request to see that cruise rather than to
     * dismiss it.
     */
    selectedPlace: { tzid: string; name: string; lat: number; lon: number } | null;
    timezonesFromUrl: StoredZone[] | null;
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
    deviceFix: null,
    localPlaceName: localStorage.getItem('localPlaceName') || null,
    savedZones: stored,
    shipClocks: loadStoredShips(),
    followedPeople: loadFollowedPeople(),
    shareName: localStorage.getItem('shareName') || null,
    shareExact: localStorage.getItem('shareExact') === '1',
    aboardShipKey: localStorage.getItem('aboardShipKey') || null,
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
    hoveredOffset: null,
    hoveredShipKey: null,
    selectedTzid: null,
    selectedPersonKey: null,
    temporaryZone: null,
    gpsTimezoneSelected: false,
    selectedShipKey: null,
    selectedPlace: null,
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
        zones: state.savedZones,
        localTimezone: state.localTimezone,
        localPlaceName: state.localPlaceName,
        ships: state.shipClocks,
        people: state.followedPeople,
        aboardShipKey: state.aboardShipKey,
    });
}

/**
 * Single write path for the saved list: state, localStorage, and the widgets.
 *
 * Takes the whole list rather than editing one entry, because every caller
 * already has the list in hand and the alternative — an add, a rename and a
 * remove, each remembering to persist and to sync — is how the label map ended
 * up being written from four places and read from six.
 */
export function persistZones(zones: StoredZone[]): void {
    state.savedZones = zones;
    // Rebuilt field by field to match migrateStoredTimezones on the way back
    // in, so a corrupt or hostile store cannot smuggle a field through and a
    // new field cannot be forgotten silently on one side.
    localStorage.setItem('worldClocks', JSON.stringify(zones.map((zone) => {
        const out: StoredZone = { tz: zone.tz };
        if (zone.label) out.label = zone.label;
        if (zone.kind) out.kind = zone.kind;
        if (zone.region) out.region = zone.region;
        if (zone.country) out.country = zone.country;
        if (zone.at) out.at = zone.at;
        return out;
    })));

    syncWidget();
}

/**
 * Puts every vessel in the roster on the World Clock, for `?debug=ships`.
 *
 * A development aid for looking at tracks: every ship on the list at once, and a
 * marker for each on the map, instead of adding them one at a time to find the
 * one drawing something odd.
 *
 * Deliberately not special: the ships are added exactly as if they had been
 * searched for by hand, so they persist, resolve their offsets and reach the
 * widget like any other. Remove them the same way.
 *
 * Called once the app key has resolved, not during startup. loadShipRoster
 * returns [] when ship features are off and MEMOISES that answer, so asking
 * before the key lands leaves the roster permanently empty for this page —
 * which is what the first version of this did, silently.
 */
export async function loadDebugFleet(): Promise<boolean> {
    if (!debugFlag('ships')) return false;
    const roster = await loadShipRoster();
    const have = new Set(state.shipClocks.map(shipKey));
    const added = roster.filter((ship) => !have.has(shipKey(ship))).map((ship) => newShipClock(ship));
    if (added.length === 0) return false;

    // One write rather than one per ship: addShipClock would persist and
    // announce forty-four times over.
    persistShipClocks([...state.shipClocks, ...added]);
    announceShipClocks();
    // Whether the caller now has ships that have never been asked the time.
    return true;
}

function loadFollowedPeople(): FollowedPerson[] {
    try {
        return migrateFollowedPeople(JSON.parse(localStorage.getItem('followedPeople') || '[]'));
    } catch {
        return [];
    }
}

/**
 * Single write path for the followed list. Mirrors persistShipClocks.
 *
 * Rebuilt through the migration on the way out as well as in, so that whatever
 * is written is exactly what will be read back — the same symmetry persistZones
 * keeps, and the thing that stops a field being added on one side only.
 */
export function persistFollowedPeople(people: FollowedPerson[]): void {
    state.followedPeople = migrateFollowedPeople(people);
    localStorage.setItem('followedPeople', JSON.stringify(state.followedPeople));
    syncWidget();
    // Here rather than at the call sites, because unlike the ship list this one
    // changes without anybody touching the screen: the relay answering is a
    // membership change nobody asked for, and every writer would otherwise have
    // to remember to say so.
    document.dispatchEvent(new CustomEvent('followedpeoplechanged'));
}

/**
 * Single write path for the two sharing preferences.
 *
 * Local first and unconditionally, so the switch works before anybody has an
 * account and the answer survives a relaunch with no signal. Getting it to the
 * relay is pushProfile's job in anchor-sync.ts — separate because one of these
 * is a fact about this device and the other is a request over a network, and
 * the first must not wait on the second.
 */
export function setSharePrefs(prefs: { name?: string | null; exact?: boolean }): void {
    if (prefs.name !== undefined) {
        state.shareName = prefs.name?.trim() || null;
        if (state.shareName) localStorage.setItem('shareName', state.shareName);
        else localStorage.removeItem('shareName');
    }
    if (prefs.exact !== undefined) {
        state.shareExact = prefs.exact;
        localStorage.setItem('shareExact', prefs.exact ? '1' : '0');
    }
}

/** Single write path for the ship list. Mirrors persistZones. */
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

/**
 * Runs once the world map can do geometry, which is not the moment it exists.
 *
 * fitBounds needs a projection and a laid-out container to work a zoom out of,
 * and before it has them it does nothing AT ALL — no error, no approximation,
 * just a map that stays where it was. Caught by searching for a zone a few
 * seconds into a cold load and watching the card change while the map did not.
 *
 * setCenter and setZoom are exempt, needing neither, which is what makes the
 * failure selective enough to miss.
 *
 * Here rather than in map.ts because ship-markers.ts frames the map too and
 * cannot import from map.ts, which imports from it.
 */
export function whenMapReady(run: (map: google.maps.Map) => void): void {
    const map = state.timezoneMap;
    if (!map) return;
    if (map.getProjection()) { run(map); return; }
    google.maps.event.addListenerOnce(map, 'idle', () => run(map));
}

/** Single write path for the resolved local place name (see AppState). */
export function setLocalPlaceName(name: string | null): void {
    state.localPlaceName = name;
    if (name) localStorage.setItem('localPlaceName', name);
    else localStorage.removeItem('localPlaceName');
}

/**
 * Adds a place to the list, or returns it unchanged if it is already there.
 *
 * Replaces three setters — label, kind and coordinates, each keyed by zone and
 * each able to overwrite a place the user had already saved. There is nothing
 * to overwrite now: a place is added or it is not.
 */
export function addSavedZone(zone: StoredZone): StoredZone[] {
    const key = zoneKey(zone);
    if (state.savedZones.some((saved) => zoneKey(saved) === key)) return state.savedZones;
    return [...state.savedZones, zone];
}

/** The saved place with this key, or undefined. */
export function savedZoneByKey(key: string): StoredZone | undefined {
    return state.savedZones.find((zone) => zoneKey(zone) === key);
}
