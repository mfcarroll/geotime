// src/anchor-sync.ts
//
// When to tell the relay, and when to ask it.
//
// anchor-share.ts is the transport and knows nothing about when; this is the
// other half. It sits between the app's own state and that transport, and it
// exists as its own module because "what time is it here" and "what time is it
// for them" are two different jobs that happen to share a server.
//
// The decisions are pure functions at the top — what this device's anchor IS,
// whether it has changed, and whether it is due — so the policy can be tested
// without a network, a clock or a DOM. The wiring underneath is the part that
// cannot be.
//
// NOTHING here creates an account. An install that has never paired has no
// identity on the relay and must not acquire one by opening the app; see
// ensureAccount. Every function below is a no-op until somebody actually pairs.

import { Capacitor } from '@capacitor/core';

import { anchorFrom, anchorSubLabel, shouldPush, type Anchor } from './anchor';
import { storedAccountId } from './account';
import { fetchFollowing, pushAnchor, revokeShare } from './anchor-share';
import { mergeFollowed } from './people';
import { aboardShip, persistFollowedPeople, state } from './state';

/**
 * How often the anchor is re-examined while the app is open.
 *
 * Not how often anything is sent. shouldPush compares first, so the ordinary
 * outcome of a tick is a string comparison and nothing else. The interval is
 * what catches the changes no event announces — a DST transition, a device
 * carried across a border, midnight passing while the phone sits on a table.
 */
const TICK_MS = 5 * 60 * 1000;

/** Where the last successful push is remembered, so a relaunch does not repeat it. */
const PUSHED_KEY = 'anchorPushed';

/**
 * Shares this device has asked to end and not had confirmed.
 *
 * Kept because the removal is local and instant while the revoke is neither.
 * Without this list, a × tapped with no signal removes the row here, fails
 * quietly at the relay, and then the next foreground fetch finds a share the
 * relay still lists with no local name for it — and puts the row back, called
 * "Someone". The user's one deliberate act, undone and renamed.
 */
const REVOKED_KEY = 'anchorRevoked';

/** This device's anchor right now. */
export function myAnchor(): Anchor | null {
    return anchorFrom(aboardShip(), state.localTimezone, state.localPlaceName);
}

/** What was last accepted by the relay, as this device remembers it. */
function lastPushed(): { anchor: Anchor | null; at: number | null } {
    try {
        const raw = JSON.parse(localStorage.getItem(PUSHED_KEY) || 'null') as unknown;
        if (!raw || typeof raw !== 'object') return { anchor: null, at: null };
        const at = Number((raw as { at?: unknown }).at);
        return {
            anchor: ((raw as { anchor?: Anchor }).anchor) ?? null,
            at: Number.isFinite(at) ? at : null,
        };
    } catch {
        return { anchor: null, at: null };
    }
}

function rememberPushed(anchor: Anchor, at: number): void {
    try {
        localStorage.setItem(PUSHED_KEY, JSON.stringify({ anchor, at }));
    } catch { /* private mode; the worst case is pushing again next tick */ }
}

/**
 * Sends this device's anchor if it is due.
 *
 * Recorded only on success, so a failed push is retried on the next tick rather
 * than being remembered as done. That is also why the stamp is this device's
 * clock and not the relay's: it governs when to try again, and nothing else.
 * The age a follower sees is stamped at the relay, which is the only clock both
 * ends agree on.
 */
export async function pushMyAnchor(): Promise<boolean> {
    if (!storedAccountId()) return false;

    const next = myAnchor();
    const { anchor, at } = lastPushed();
    if (!shouldPush(next, anchor, at, Date.now())) return false;

    if (!await pushAnchor(next!)) return false;
    rememberPushed(next!, Date.now());
    return true;
}

/** Shares asked to end and not yet confirmed. */
function pendingRevokes(): Set<string> {
    try {
        const raw = JSON.parse(localStorage.getItem(REVOKED_KEY) || '[]') as unknown;
        return new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []);
    } catch {
        return new Set();
    }
}

function rememberRevokes(ids: ReadonlySet<string>): void {
    try {
        if (ids.size === 0) localStorage.removeItem(REVOKED_KEY);
        else localStorage.setItem(REVOKED_KEY, JSON.stringify([...ids]));
    } catch { /* private mode; the worst case is a retry that never happens */ }
}

/**
 * Stops following somebody: here first, then at the relay, then remembered
 * until the relay agrees.
 *
 * Local first so the row goes the instant it is tapped rather than after a
 * round trip, and so it goes with no signal at all — which is exactly when
 * somebody most wants to be rid of a row. The relay is what actually ends the
 * sharing, and until it says so this device keeps asking; see refreshFollowing.
 */
export async function stopFollowing(shareId: string): Promise<void> {
    persistFollowedPeople(state.followedPeople.filter((person) => person.shareId !== shareId));

    const pending = pendingRevokes();
    pending.add(shareId);
    rememberRevokes(pending);

    if (await revokeShare(shareId)) {
        const left = pendingRevokes();
        left.delete(shareId);
        rememberRevokes(left);
    }
}

/**
 * Tries again on every revoke still outstanding, and returns the ones that are.
 *
 * A share the relay no longer lists is done, however it got that way — revoked
 * from the other end, swept, or by a call whose answer this device never saw —
 * so it leaves the list without another request.
 */
async function retryRevokes(
    pending: ReadonlySet<string>,
    listed: ReadonlyArray<{ shareId: string }>,
): Promise<Set<string>> {
    if (pending.size === 0) return new Set();

    const stillThere = new Set(listed.map((row) => row.shareId));
    const left = new Set<string>();
    for (const shareId of pending) {
        if (!stillThere.has(shareId)) continue;
        if (!await revokeShare(shareId)) left.add(shareId);
    }
    return left;
}

/**
 * Asks the relay who is sharing with this device, and folds the answer in.
 *
 * A null answer is unreachable, not empty, and changes nothing — the rows stay
 * exactly as they were and go on ageing. That distinction is the whole reason
 * fetchFollowing returns null rather than [].
 */
export async function refreshFollowing(): Promise<boolean> {
    if (!storedAccountId()) return false;

    const incoming = await fetchFollowing();
    if (!incoming) return false;

    // Everything asked to end is held back from this pass, INCLUDING the ones
    // just confirmed: `incoming` was read before the retries went out, so a
    // share that has this moment been revoked is still in it.
    const asked = pendingRevokes();
    rememberRevokes(await retryRevokes(asked, incoming));

    const { people, unnamed } = mergeFollowed(state.followedPeople, incoming, asked);

    // A share the relay lists that this device has no name for. It should not
    // be possible — the name is written when the code is redeemed, and the
    // account id that asked this question lives in the same store — but if it
    // ever is, the row must appear. Somebody is sharing their time with this
    // device, and a share you cannot see is a share you cannot revoke.
    for (const shareId of unnamed) {
        const row = incoming.find((person) => person.shareId === shareId)!;
        people.push({ shareId, name: 'Someone', anchor: row.anchor, updatedAt: row.updatedAt });
    }

    persistFollowedPeople(people);
    return true;
}

/** Both halves, in the order that makes the answer include this device's own news. */
async function syncNow(): Promise<void> {
    await pushMyAnchor();
    await refreshFollowing();
}

let started = false;

/**
 * Wires the two halves to the moments they can newly matter.
 *
 * Foreground first and foremost: on native it is the only time anything runs at
 * all, and on the web it is when a tab that has been asleep for an afternoon
 * catches up. The ship events are here because boarding, stepping ashore and a
 * crew clock change each rewrite this device's anchor outright, and waiting up
 * to five minutes to notice would be visible to the person on the other end.
 */
export function startAnchorSync(): void {
    if (started) return;
    started = true;

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void syncNow();
    });
    document.addEventListener('aboardshipchanged', () => { void pushMyAnchor(); });
    document.addEventListener('shipclockschanged', () => { void pushMyAnchor(); });

    // Everything no event announces. See TICK_MS.
    setInterval(() => { void syncNow(); }, TICK_MS);

    void syncNow();
}

/**
 * What this device is currently telling people, in words, for the settings row.
 *
 * Present tense on purpose: it describes what a follower's screen says right
 * now, not what was last sent. They are the same thing whenever the relay has
 * heard, and when it has not, what somebody wants to check is whether the app
 * has the right idea of where they are.
 */
export function myAnchorLabel(): string {
    const anchor = myAnchor();
    if (!anchor) return 'Not known yet';
    return anchorSubLabel(anchor);
}

/** True where sharing is offered at all. See the note in the pairing UI. */
export function sharingAvailable(): boolean {
    return Capacitor.isNativePlatform() || import.meta.env?.DEV === true;
}
