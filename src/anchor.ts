// src/anchor.ts
//
// The anchor, as it crosses the wire.
//
// One definition, used at both ends: the app builds it, the relay validates and
// stores it, another app reads it. Living in src/ rather than in the Worker is
// what keeps it one definition — the Worker imports this file, so there is no
// second copy to drift, and it can be tested here with the runner every other
// pure module uses.
//
// Which means this file must stay free of the DOM. It is compiled twice: once
// with the app's lib, and once under workers/tsconfig.json, whose libs are
// ES2022 and @cloudflare/workers-types and nothing else. Reaching for `window`,
// `localStorage` or a `document` here breaks a Worker build rather than this
// one, which is a confusing place to find out.
//
// What is NOT in here is a position. The anchor is what time it is for someone,
// never where they are: a zone id, or an offset and a name. That line is the
// whole difference between this feature and location sharing, and it is drawn
// in the type — there is nowhere to put a latitude.
//
// Ashore the ZONE ID travels, not the offset. The follower's own device knows
// when America/Vancouver leaves daylight time, so the relay never has to, and a
// row that was written in July is still right in December. Aboard there is no
// id to send: a ship's clock is set by her crew and belongs to no region, so
// the offset goes instead — the same split the app already lives with everywhere else.

/** Ashore: the region whose time you are keeping. */
export interface ZoneAnchor {
    kind: 'zone';
    /** IANA id, e.g. "America/Vancouver". */
    tz: string;
    /** The town, where the device knows one. "Nelson". */
    place?: string;
}

/** Aboard: a clock the crew set, belonging to no region. */
export interface ShipAnchor {
    kind: 'ship';
    /** Minutes from UTC. No zone exists to derive this from. */
    offsetMinutes: number;
    /** "Wonder of the Seas". */
    name: string;
    /** "Wonder" — the form a narrow row uses, when it differs. */
    short?: string;
}

export type Anchor = ZoneAnchor | ShipAnchor;

/** An anchor as it comes back from the relay, with the age it was stamped. */
export interface SharedAnchor {
    /** Identifies the share, so it can be revoked or renamed. */
    shareId: string;
    anchor: Anchor;
    /** Epoch ms, stamped by the relay — never by the device that sent it. */
    updatedAt: number;
}

/**
 * Long enough that a row is worth doubting.
 *
 * A day. Under it, a clock that has not moved is almost certainly still right —
 * a timezone changes when someone travels, and a ship's once a night at most.
 * Over it, the honest thing is to say how old the answer is rather than to keep
 * presenting it as current.
 */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** True when a row should say how old it is. It is never a reason to hide it. */
export function anchorIsStale(updatedAt: number, now = Date.now()): boolean {
    return !Number.isFinite(updatedAt) || now - updatedAt >= STALE_AFTER_MS;
}

/**
 * Names are shown on other people's screens and stored in someone else's
 * database, so they are bounded here rather than trusted.
 */
const MAX_NAME = 60;

/** The real range of UTC offsets, which is not symmetric: -12:00 to +14:00. */
const MIN_OFFSET_MINUTES = -12 * 60;
const MAX_OFFSET_MINUTES = 14 * 60;

function cleanName(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_NAME) return null;
    return trimmed;
}

/**
 * True when this is an IANA id the runtime can actually resolve.
 *
 * Asked of Intl rather than of a pattern, because the question is not whether
 * the string looks like a zone id but whether the device reading it can turn it
 * into a time. Both ends have Intl — browsers, and the Workers runtime — so
 * both can ask.
 */
function isResolvableZone(tz: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

/**
 * An anchor rebuilt field by field, or null.
 *
 * Rebuilt rather than spread, the same way the saved clock list is: this
 * arrives over a network from a device that is not ours, and a shape that is
 * merely CHECKED still carries whatever else was attached to it into the
 * database and out onto someone's home screen. Only the fields named here
 * survive the trip.
 */
export function validateAnchor(raw: unknown): Anchor | null {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw as Record<string, unknown>;

    if (source.kind === 'zone') {
        const tz = typeof source.tz === 'string' ? source.tz.trim() : '';
        if (!tz || tz.length > MAX_NAME || !isResolvableZone(tz)) return null;

        const anchor: ZoneAnchor = { kind: 'zone', tz };
        const place = cleanName(source.place);
        if (place) anchor.place = place;
        return anchor;
    }

    if (source.kind === 'ship') {
        const offset = Number(source.offsetMinutes);
        if (!Number.isInteger(offset)) return null;
        if (offset < MIN_OFFSET_MINUTES || offset > MAX_OFFSET_MINUTES) return null;

        const name = cleanName(source.name);
        if (!name) return null;

        const anchor: ShipAnchor = { kind: 'ship', offsetMinutes: offset, name };
        // Only when it says something the full name does not. A `short` equal to
        // the name is a byte of payload and a chance for the two to disagree.
        const short = cleanName(source.short);
        if (short && short !== name) anchor.short = short;
        return anchor;
    }

    return null;
}

/**
 * What a row for this anchor is called.
 *
 * The person's name is not in here — that belongs to whoever is following them,
 * who names the row themselves the way they name any saved place. This is the
 * line UNDERNEATH: where they are, or which ship they are on.
 */
export function anchorSubLabel(anchor: Anchor): string {
    return anchor.kind === 'ship' ? (anchor.short ?? anchor.name) : (anchor.place ?? anchor.tz);
}
