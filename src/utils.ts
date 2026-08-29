// src/utils.ts

/**
 * Calculates the distance between two geographical coordinates in kilometers.
 * @param lat1 Latitude of the first point.
 * @param lon1 Longitude of the first point.
 * @param lat2 Latitude of the second point.
 * @param lon2 Longitude of the second point.
 * @returns The distance in kilometers.
 */
export function distance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // Radius of the Earth in km
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in km
}

/**
 * Formats the accuracy value for display.
 * @param accuracy The accuracy in meters.
 * @returns A formatted string (e.g., "7m", "94m", "560m", "3.0km", "2,100km").
 */
export function formatAccuracy(accuracy: number): string {
    if (accuracy < 1000) {
        return `${Math.round(accuracy)}m`;
    } else {
        const accuracyInKm = accuracy / 1000;
        const fixed = accuracyInKm < 10 ? 1 : 0;
        return `${accuracyInKm.toLocaleString(undefined, { minimumFractionDigits: fixed, maximumFractionDigits: fixed })}km`;
    }
}
const ASCII_ONLY = /^[\x20-\x7E]*$/;

/**
 * Lowercase and strip diacritics, for comparing and matching names — so a query
 * for "zurich" finds "Zürich", and "Reykjavík" is recognised as the same place
 * as the zone named "Reykjavik".
 */
export function fold(value: string): string {
    const lower = value.toLowerCase();
    // 81% of city names are plain ASCII; normalize() is comparatively slow.
    if (ASCII_ONLY.test(lower)) return lower;
    return lower.normalize('NFD').replace(/\p{Mn}+/gu, '');
}

/** A zone's own name, derived from its IANA id. */
export function getDisplayTimezoneName(tz: string): string {
    const gmt = parseEtcGmt(tz);
    if (gmt !== null) return `UTC${gmt >= 0 ? '+' : ''}${gmt}`;
    return tz.split('/').pop()?.replace(/_/g, ' ') || tz;
}

/**
 * POSIX sign inversion: `Etc/GMT+5` is UTC-5. Returns null for everything else.
 * Only whole-hour ids exist in tzdb — the fractional `Etc/GMT+5.5` ids the app
 * used to synthesise were never valid, and are repaired on load (see state.ts).
 */
function parseEtcGmt(timeZone: string): number | null {
    const m = timeZone.match(/^Etc\/GMT([+-])(\d+)$/);
    if (!m) return null;
    return (m[1] === '+' ? -1 : 1) * parseInt(m[2], 10);
}

/** True if the runtime can actually format in this zone. */
export function isValidTimezone(tz: string): boolean {
    if (!tz || !tz.trim()) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}
