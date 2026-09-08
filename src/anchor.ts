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
 * How long a pushed anchor may sit before it is sent again unchanged.
 *
 * Deliberately next to STALE_AFTER_MS, because the only thing that makes either
 * number right is its relation to the other. A push is the one event that
 * resets a follower's staleness clock, so an anchor that never changes and is
 * never re-sent would make somebody sitting still look like somebody who has
 * gone quiet. Six hours leaves room for two missed heartbeats inside the day.
 *
 * It does not make a row fresh while the app is closed — nothing pushes in the
 * background in 2.0 — so "stale" honestly means "has not opened their app in a
 * day". That is the truth, and it reads as such.
 */
export const HEARTBEAT_MS = 6 * 60 * 60 * 1000;

/**
 * The anchor a device with these pieces would send.
 *
 * Aboard beats ashore, for the same reason anchorOffsetHours does it: ship time
 * is what every announcement and gangway time aboard is quoted in, while the
 * geographic zone under a hull is often one nobody observes. A ship whose clock
 * has not resolved is not aboard for this purpose — there is no offset to send
 * — so it falls through to the ground.
 *
 * Null when there is nothing worth saying, which is an answer rather than a
 * failure: a device that does not yet know its own zone should send nothing,
 * because sending UTC and having somebody read it is worse than silence.
 *
 * Given its inputs rather than reading state, so it lives here with the rest of
 * the wire format and can be tested with it.
 */
export function anchorFrom(
    ship: { name: string; short: string; offsetHours: number | null } | null,
    tz: string | null,
    place: string | null,
): Anchor | null {
    if (ship && ship.offsetHours !== null) {
        return {
            kind: 'ship',
            offsetMinutes: Math.round(ship.offsetHours * 60),
            name: ship.name,
            // Only when it says something the full name does not. A short form
            // identical to the name is a field that costs bytes and tells the
            // far end nothing it could not work out.
            ...(ship.short && ship.short !== ship.name ? { short: ship.short } : {}),
        };
    }
    if (!tz) return null;
    return { kind: 'zone', tz, ...(place ? { place } : {}) };
}

/**
 * Whether two anchors would read identically on somebody else's screen.
 *
 * Field by field rather than by JSON, because key order is not meaning and a
 * re-serialisation that shuffles them is not a change worth a request. This
 * comparison is the thing that stops the heartbeat becoming a poll.
 */
export function sameAnchor(a: Anchor | null, b: Anchor | null): boolean {
    if (!a || !b) return a === b;
    if (a.kind === 'zone' && b.kind === 'zone') {
        return a.tz === b.tz && (a.place ?? '') === (b.place ?? '');
    }
    if (a.kind === 'ship' && b.kind === 'ship') {
        return a.offsetMinutes === b.offsetMinutes
            && a.name === b.name
            && (a.short ?? '') === (b.short ?? '');
    }
    return false;
}

/**
 * Whether an anchor is due to be sent, given what was last sent and when.
 *
 * Three ways to be due: it changed, it has never been sent, or it is older than
 * the heartbeat. Nothing to send is never due — an anchor that has gone unknown
 * does not retract the last one, because a follower's row ageing visibly is a
 * better answer than that row losing its time.
 */
export function shouldPush(
    next: Anchor | null,
    last: Anchor | null,
    lastAt: number | null,
    now: number,
): boolean {
    if (!next) return false;
    if (!sameAnchor(next, last)) return true;
    if (lastAt === null || !Number.isFinite(lastAt)) return true;
    return now - lastAt >= HEARTBEAT_MS;
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
