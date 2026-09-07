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

/**
 * Whether a `?debug=` flag is set.
 *
 * Comma-separated, so `?debug=ships,geometry` turns on both. It used to be a
 * bare equality test against one word, which made the flags mutually exclusive
 * for no reason other than how the check was written.
 *
 * Everything behind one of these is a development aid: none of it is reachable
 * without typing the parameter, and none of it changes what a normal load does.
 */
export function debugFlag(name: string): boolean {
    const raw = new URLSearchParams(window.location.search).get('debug') ?? '';
    return raw.split(',').some((flag) => flag.trim().toLowerCase() === name);
}

/**
 * The same colour with the light turned up — hover, in the hue the thing
 * already is.
 *
 * White was the first answer and it was wrong for half the cases. A port ring
 * carries a MEANING in its colour: gold says this call keeps the ship's time,
 * pale says it does not. Painting hover white overwrites the answer with the
 * question, and the gold rings visibly changed category under the pointer
 * rather than merely lighting up. Zones do not do this — a hovered zone keeps
 * its band and gains an outline — so neither should these.
 *
 * Lightness only, in HSL, so hue and saturation survive: gold goes to a paler
 * gold, green to a paler green, and the transition is the same size in each.
 *
 * The clamp is for colours that are already nearly white. #E8EEF4 is 93%
 * light, so a proportional lift moves it three points and nothing visibly
 * happens; white is the brighter version of near-white, and only there.
 */
export function brighter(hex: string, lift = 0.45): string {
    const rgb = hexToRgb(hex);
    if (!rgb) return '#FFFFFF';
    const [h, s, l] = rgbToHsl(rgb);
    const lifted = l + (100 - l) * lift;
    if (lifted - l < 6) return '#FFFFFF';
    return hslToHex(h, s, lifted);
}

function hexToRgb(hex: string): [number, number, number] | null {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
    const [rr, gg, bb] = [r / 255, g / 255, b / 255];
    const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l * 100];
    const d = max - min;
    const s = d / (l > 0.5 ? 2 - max - min : max + min);
    const h = max === rr ? ((gg - bb) / d + (gg < bb ? 6 : 0))
        : max === gg ? (bb - rr) / d + 2
        : (rr - gg) / d + 4;
    return [h * 60, s * 100, l * 100];
}

function hslToHex(h: number, s: number, l: number): string {
    const sat = s / 100, light = l / 100;
    const c = (1 - Math.abs(2 * light - 1)) * sat;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = light - c / 2;
    const sextant = Math.floor(((h % 360) + 360) % 360 / 60);
    const [r, g, b] = [
        [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
    ][sextant];
    const byte = (v: number) =>
        Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return `#${byte(r)}${byte(g)}${byte(b)}`.toUpperCase();
}
