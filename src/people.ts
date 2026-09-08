// src/people.ts
//
// Somebody else's clock, as this device keeps it.
//
// The relay is the source of truth for what time it is for them, and this is
// the copy held here — so that a launch with no signal still shows the rows,
// aged, rather than an empty list. The same bargain the app already makes with
// ship positions and the fleet cache: last known, with its age, beats nothing.
//
// Two halves, from two places, and the split is the whole shape of the record.
// The NAME is yours: you called them "Dad", the relay has never heard of it and
// never will, and it never leaves this device. Everything else is theirs and
// arrives over the wire. A person who changes ship, or flies home, changes
// their half; nothing they do can rename their own row on your screen.
//
// Both directions of a share live here, because they are one idea seen from two
// ends: a FollowedPerson is somebody whose time reaches you, and an invitation
// is somebody whose you reach. They share their arithmetic — how old is this,
// and what does the row say about it — and splitting them would have meant
// describeAge in two files.
//
// Free of the DOM for the same reason stored-zones.ts is: it is the one thing
// the followed list is read through, and it stays testable.

import { anchorIsStale, validateAnchor, type Anchor } from './anchor';

export interface FollowedPerson {
    /** The share this came from. Identity here, and what revoking names. */
    shareId: string;
    /** What YOU call them. Never sent anywhere. */
    name: string;
    /**
     * The last anchor the relay gave for them, or null before their first push.
     *
     * Null is not an error and not a gap to hide: a pairing that worked but
     * whose other end has not opened their app yet is a real state, and worth
     * showing as a row that says so rather than one that is missing.
     */
    anchor: Anchor | null;
    /** Epoch ms, stamped by the relay. Null alongside a null anchor. */
    updatedAt: number | null;
}

/** Names are shown on your own screen, so this is a sanity bound, not a defence. */
const MAX_NAME = 40;

/**
 * The followed list, rebuilt field by field.
 *
 * Rebuilt rather than parsed-and-trusted, exactly as migrateStoredTimezones is:
 * half of every record came off a network, and a store that has been edited,
 * corrupted or downgraded should degrade to fewer good rows rather than to one
 * bad one. A person whose anchor no longer validates keeps their row and loses
 * the anchor — you still know you follow them.
 */
export function migrateFollowedPeople(raw: unknown): FollowedPerson[] {
    if (!Array.isArray(raw)) return [];

    const out: FollowedPerson[] = [];
    const seen = new Set<string>();

    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const source = entry as Record<string, unknown>;

        const shareId = typeof source.shareId === 'string' ? source.shareId.trim() : '';
        if (!shareId || seen.has(shareId)) continue;

        const name = typeof source.name === 'string' ? source.name.trim().slice(0, MAX_NAME) : '';
        if (!name) continue;   // a row with nothing to call it is not a row

        const anchor = validateAnchor(source.anchor);
        const updatedAt = Number(source.updatedAt);

        seen.add(shareId);
        out.push({
            shareId,
            name,
            anchor,
            // A stamp without an anchor says nothing, and an anchor without a
            // stamp cannot be aged — so they stand or fall together.
            updatedAt: anchor && Number.isFinite(updatedAt) ? updatedAt : null,
        });
    }
    return out;
}

/**
 * What the row says underneath the name, given how old the answer is.
 *
 * Never "" and never hidden. A followed row exists because somebody chose to
 * follow somebody, and the honest failure is to say what is not known rather
 * than to quietly stop rendering — which would be the app claiming they are
 * gone when all it knows is that it has not heard.
 */
export function personSubLabel(
    person: FollowedPerson,
    where: string | null,
    now = Date.now(),
): string {
    if (!person.anchor || person.updatedAt === null) return 'Not shared yet';
    if (!anchorIsStale(person.updatedAt, now)) return where ?? '';
    const age = describeAge(now - person.updatedAt);
    return where ? `${where} · ${age}` : age;
}

/**
 * How long ago, in the coarsest terms that are still true.
 *
 * Coarse on purpose. The number is not a measurement — the relay only hears
 * when a device has signal — so a row that says "2 days ago" is honest where
 * "51 hours ago" implies a precision nobody has.
 */
export function describeAge(ms: number): string {
    const days = Math.floor(ms / (24 * 60 * 60 * 1000));
    if (days >= 14) return `${Math.floor(days / 7)} weeks ago`;
    if (days >= 2) return `${days} days ago`;
    if (days >= 1) return 'yesterday';
    return `${Math.max(1, Math.floor(ms / (60 * 60 * 1000)))} hours ago`;
}

/**
 * The followed list with fresh news folded in, keeping the names.
 *
 * The relay knows who you follow and what time it is for them; it does not know
 * what you called them. So a merge rather than a replacement: rows that are
 * still shared keep their name and take the new anchor, rows the relay no
 * longer lists are gone — revoked from either end — and rows the relay lists
 * that are new here arrive unnamed for the caller to name.
 *
 * Pure, and given the incoming list rather than fetching it, so the merge can
 * be tested without a network.
 */
export function mergeFollowed(
    known: FollowedPerson[],
    incoming: ReadonlyArray<{ shareId: string; anchor: Anchor | null; updatedAt: number | null }>,
    revoked: ReadonlySet<string> = new Set(),
): { people: FollowedPerson[]; unnamed: string[] } {
    const byId = new Map(known.map((person) => [person.shareId, person]));
    const people: FollowedPerson[] = [];
    const unnamed: string[] = [];

    for (const row of incoming) {
        // A share this device has asked to end, whose revoke has not been
        // confirmed yet. Neither kept nor reported: it has no local row to keep,
        // and reporting it unnamed is precisely how the removed row came BACK
        // on the next foreground calling itself "Someone" — the app undoing the
        // one thing the user actually asked it to do, and renaming it on the
        // way. The relay is the authority on who, EXCEPT about the requests it
        // has not answered yet.
        if (revoked.has(row.shareId)) continue;

        const existing = byId.get(row.shareId);
        if (!existing) {
            unnamed.push(row.shareId);
            continue;
        }
        people.push({
            shareId: row.shareId,
            name: existing.name,
            // An anchor that has gone missing upstream leaves the last one
            // standing, to age. The relay saying nothing about somebody is not
            // the same as the relay saying they have no time.
            anchor: row.anchor ?? existing.anchor,
            updatedAt: row.anchor ? row.updatedAt : existing.updatedAt,
        });
    }
    return { people, unnamed };
}

/**
 * What one code you handed out currently says about itself.
 *
 * The mirror of personSubLabel, and the thinner half of it on purpose: you know
 * who you follow, because you named them, but you do NOT know who redeemed your
 * code. Nothing about a follower crosses back — no name, no device, no zone —
 * so the honest answer is "somebody", and the row's real job is to carry the ×
 * that ends it.
 *
 * Three states, from two nullable fields, which is why this is a function and
 * not a template: a live code, a share somebody took up, and a code that
 * expired with nobody using it. The last one is not a failure worth an alarm —
 * it is the ordinary end of a code read out over a bad line — but it IS a row
 * that should say so rather than sit there looking live.
 *
 * Structural in its parameter rather than importing Invitation, so this module
 * stays clear of anchor-share.ts and the transport it drags in with it.
 */
export function describeInvitation(
    invitation: { code: string | null; createdAt: number; redeemedAt: number | null },
    now = Date.now(),
): { text: string; code: string | null } {
    if (invitation.code) {
        return { text: 'Waiting for them to enter it', code: invitation.code };
    }
    if (invitation.redeemedAt !== null) {
        return { text: `Following you · shared ${describeAge(now - invitation.createdAt)}`, code: null };
    }
    // No code left and nobody took it up: it timed out. See CODE_TTL_MS.
    return { text: 'Code expired, never used', code: null };
}

/**
 * A followed person's anchor, as the native widgets need it.
 *
 * A SWITCH AND NOT TERNARIES, deliberately, and the `never` at the end is the
 * whole reason. This started life as two independent conditional expressions —
 * "zone ? tz : ''" beside "ship ? offsetMinutes : 0" — which was correct while
 * an anchor was one of two things. Adding OffsetAnchor made a third, which
 * matched neither, fell through both, and arrived at the widget as an empty
 * zone with a zero offset: every followed person drawn at UTC on somebody's
 * home screen, in the DEFAULT sharing mode, confidently and wrongly.
 *
 * A fourth kind now fails to compile instead.
 *
 * `tz` empty means "use the offset"; the native side reads it that way. A zone
 * sends no offset because the phone works it out from the id, which is the
 * point of sending an id at all.
 */
export function anchorForWidget(
    anchor: Anchor,
): { tz: string; offsetMinutes: number; short: string } {
    switch (anchor.kind) {
        case 'zone':
            return { tz: anchor.tz, offsetMinutes: 0, short: '' };
        case 'ship':
            return { tz: '', offsetMinutes: anchor.offsetMinutes, short: anchor.short ?? '' };
        case 'offset':
            return { tz: '', offsetMinutes: anchor.offsetMinutes, short: '' };
        default: {
            const unhandled: never = anchor;
            return unhandled;
        }
    }
}
