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

/**
 * Ashore: the region whose time you are keeping.
 *
 * A zone id and NOTHING ELSE. There is no field for a town here and there must
 * never be one: a zone is thousands of kilometres wide, and that width is the
 * entire privacy story of this feature. The map refuses to paint even the
 * single ZONE within a band for the same reason — Vancouver and Seattle keep
 * one clock and the app declines to say which of them somebody is in — and a
 * town name in the payload would have made that refusal theatre.
 *
 * 2.0.0-alpha carried a `place` for a while, on the argument that "Birmingham"
 * makes a better row than "Europe/London". It does. It also makes the row a
 * location, which this is not, so it is gone: see validateAnchor, which drops
 * it on the way in at BOTH ends, and anchor.test.ts, which fails if it ever
 * comes back.
 */
export interface ZoneAnchor {
    kind: 'zone';
    /** IANA id, e.g. "America/Vancouver". */
    tz: string;
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

/**
 * Neither: a bare number of minutes from UTC, and nothing to call it.
 *
 * The relay makes these; a device never sends one. It is what a follower gets
 * when the person they follow has NOT ticked "share my exact timezone", which
 * is the default — the offset says what time it is for them and says nothing
 * about where on earth that is, which is the whole of what most people want to
 * share and rather less than a zone id gives away.
 *
 * It swallows a ship too, on purpose. "Wonder of the Seas" is a more specific
 * fact about somebody than a timezone is, so a person sharing only their offset
 * should not have their vessel named either. One switch, one meaning: a number.
 *
 * The number is computed at the relay from the zone it holds, at the moment it
 * is asked — see zoneOffsetMinutes. That is what keeps it right through a
 * daylight-saving change without the sharer having to open their app: the thing
 * doing the arithmetic is the thing that knows the rules, and it is awake.
 */
export interface OffsetAnchor {
    kind: 'offset';
    /** Minutes from UTC. There is deliberately nothing else in here. */
    offsetMinutes: number;
}

export type Anchor = ZoneAnchor | ShipAnchor | OffsetAnchor;

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
 * An anchor as a particular follower is allowed to see it.
 *
 * THE PRIVACY MODEL, in one function, and deliberately in this file rather
 * than in the Worker: the relay calls it to decide what to send, and the
 * sharing screen calls it to draw the preview of how they appear. A preview
 * computed by a second implementation would eventually lie, and this is the one
 * screen where a lie would be about somebody's privacy rather than their
 * layout.
 *
 * Without "share my exact timezone" — the
 * default — a follower gets a number of minutes and nothing else: no zone id,
 * no ship name, nothing that narrows the world further than "it is this time
 * for them". With it on, they get what was stored.
 *
 * The number is computed HERE, from the zone, at the moment of the request.
 * That is the point of doing it at the relay rather than on the sharer's
 * device: come November the offset changes on its own, because the thing that
 * knows the daylight-saving rules is also the thing that is awake. A device
 * pushing a bare number would leave the follower an hour wrong until its owner
 * next opened the app.
 *
 * A ship is swallowed by the same rule. Her name is a more specific fact about
 * somebody than a timezone is, so a person sharing only their offset does not
 * have their vessel named either — and her clock has no zone to compute from,
 * so the offset she was pushed with is already the right answer.
 *
 * Returns null where a zone cannot be resolved at all, which drops the row
 * rather than guessing. Better a follower who sees nothing than one who is
 * confidently shown Greenwich.
 */
export function anchorAsSeen(anchor: Anchor | null, exact: boolean): Anchor | null {
  if (!anchor || exact) return anchor;
  if (anchor.kind === 'offset') return anchor;
  if (anchor.kind === 'ship') return { kind: 'offset', offsetMinutes: anchor.offsetMinutes };

  const offsetMinutes = zoneOffsetMinutes(anchor.tz);
  return offsetMinutes === null ? null : { kind: 'offset', offsetMinutes };
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
    // No town, and no parameter to pass one in. The device knows its nearest
    // town — state.localPlaceName, which its own widget uses — and that is
    // where that knowledge stops. See ZoneAnchor.
    return { kind: 'zone', tz };
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
        return a.tz === b.tz;
    }
    if (a.kind === 'offset' && b.kind === 'offset') {
        return a.offsetMinutes === b.offsetMinutes;
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

/**
 * A human-chosen name, trimmed and bounded, or null.
 *
 * Exported because the relay needs the same rule for a display name that it
 * already applies to a ship's: one definition of "a usable name" rather than
 * two that drift. Bounded rather than truncated — a name that will not fit is
 * a mistake worth reporting, not one worth silently editing.
 */
export function cleanDisplayName(value: unknown): string | null {
    return cleanName(value);
}

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
/**
 * A zone's current distance from UTC, in minutes.
 *
 * Here rather than beside the app's other time helpers because the RELAY needs
 * it: a follower who is not being given a zone id is given this number instead,
 * computed at the moment they ask. Doing it there rather than on the sharer's
 * device is what keeps the answer right through a daylight-saving change
 * without the sharer opening their app — the party that knows the rules is also
 * the party that is awake.
 *
 * `shortOffset` gives "GMT-7" or "GMT+5:30" and, at UTC itself, plain "GMT".
 * Parsed rather than trusted to a fixed shape for that last reason.
 */
export function zoneOffsetMinutes(tz: string, at = new Date()): number | null {
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, timeZoneName: 'shortOffset',
        }).formatToParts(at);
        const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
        const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name);
        if (!match) return name === 'GMT' ? 0 : null;
        const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
        return match[1] === '-' ? -minutes : minutes;
    } catch {
        return null;
    }
}

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

        // Two fields out, whatever came in. A payload carrying a `place` — an
        // older build of ours, or anything else — loses it here rather than
        // reaching a database or a home screen. That is the safeguard, and it
        // is one line only because the function rebuilds rather than spreads.
        return { kind: 'zone', tz };
    }

    if (source.kind === 'offset') {
        // Read but never written by a device: the relay is the only thing that
        // makes one of these, and putAnchor refuses one on the way in. A
        // follower has to be able to decode it, which is why it is here.
        const offset = Number(source.offsetMinutes);
        if (!Number.isInteger(offset)) return null;
        if (offset < MIN_OFFSET_MINUTES || offset > MAX_OFFSET_MINUTES) return null;
        return { kind: 'offset', offsetMinutes: offset };
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
    if (anchor.kind === 'ship') return anchor.short ?? anchor.name;
    // An offset has nothing to say on this line, and saying "UTC−7" would be
    // saying the same thing the row's own right-hand column already says. Blank
    // is the honest answer, and it is what makes the privacy setting legible:
    // the line is either a place or it is absent.
    if (anchor.kind === 'offset') return '';
    return anchor.tz;
}
