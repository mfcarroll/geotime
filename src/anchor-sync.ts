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

import { anchorFrom, anchorSubLabel, profileNeedsPush, reconcileProfile, shouldPush, type Anchor, type SharedProfile } from './anchor';
import { getDisplayTimezoneName } from './utils';
import {
    acknowledgedProfile,
    dropAlphaAccount,
    rememberAcknowledgedProfile,
    storedDevice,
    storedToken,
} from './account';
import { fetchFollowing, fetchMe, pushAnchor, revokeShare, updateProfile, type Me } from './anchor-share';
import { mergeFollowed } from './people';
import { aboardShip, persistFollowedPeople, setSharePrefs, state } from './state';

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
    // localPlaceName is deliberately NOT passed, and anchorFrom has nowhere to
    // put it. This device knows its nearest town and its own widget draws it;
    // that is where the knowledge stops. See ZoneAnchor.
    return anchorFrom(aboardShip(), state.localTimezone);
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

// ---------------------------------------------------------------------------
// This device, among the account's others
// ---------------------------------------------------------------------------

/** What the relay last said about this device and its account. Null until asked. */
let me: Me | null = null;

export function currentMe(): Me | null {
    return me;
}

/**
 * Whether this device is the one that shares its owner's time.
 *
 * True before there is any account at all, because the first device to share
 * becomes the primary: what it would share is its own time, and that is what
 * the preview should show. After that, what the relay last said.
 */
export function isPrimaryDevice(): boolean {
    return !storedToken() || (storedDevice()?.primary ?? false);
}

/**
 * The anchor followers are given for this account — this device's own when it
 * is the one sharing, otherwise whatever the primary last reported.
 *
 * For the sharing card's preview. A tablet's own location is not what anybody
 * following this person sees, and a preview drawn from it would be a promise
 * about somebody else's screen that is not true.
 */
export function sharedAnchor(): Anchor | null {
    if (isPrimaryDevice()) return myAnchor();
    return me?.status === 'active' ? me.anchor : null;
}

/**
 * Asks the relay who this device is, and brings the profile into line.
 *
 * Kept when the relay cannot be reached: the last answer is a better guess
 * than none, for the same reason the followed rows keep their last time.
 */
async function refreshMe(): Promise<Me | null> {
    if (!storedToken()) {
        me = null;
        return null;
    }
    const answer = await fetchMe();
    if (answer) me = answer;
    if (answer?.status === 'active') adoptProfile(answer);
    return answer;
}

/**
 * Takes the account's name and switch when another device changed them.
 *
 * See reconcileProfile. Only 'adopt' changes anything here; 'push' is left for
 * pushProfile, which runs next in the same sync.
 */
function adoptProfile(answer: Extract<Me, { status: 'active' }>): void {
    const remote: SharedProfile = { name: answer.name ?? '', shareExact: answer.shareExact };
    const local: SharedProfile = { name: state.shareName ?? '', shareExact: state.shareExact };
    const decision = reconcileProfile(local, acknowledgedProfile(), remote);
    if (decision === 'push') return;

    if (decision === 'adopt') {
        setSharePrefs({ name: remote.name || null, exact: remote.shareExact });
        document.dispatchEvent(new CustomEvent('shareprefschanged'));
    }
    rememberAcknowledgedProfile(remote);
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
    // Only the device that shares its owner's time says what that time is.
    // The relay refuses the rest anyway; asking first saves it the refusal.
    if (!storedToken() || !isPrimaryDevice()) return false;

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
    if (!storedToken() || me?.status === 'pending') return false;

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
        // Their own name for themselves, which the relay hands over with the
        // row. "Someone" is the last resort for a share whose other end never
        // set one — better than a row you cannot see, which is a share you
        // cannot revoke.
        people.push({
            shareId,
            name: row.name ?? 'Someone',
            anchor: row.anchor,
            updatedAt: row.updatedAt,
        });
    }

    persistFollowedPeople(people);
    return true;
}

/**
 * Everything, in the order that makes the answer include this device's own news.
 *
 * Who this device is comes first: whether it is still linked, whether it is the
 * one that shares, and whether another device changed the name or the switch.
 * A device still waiting to be approved stops there, since that question is
 * the only one the relay will answer for it.
 *
 * Exported for the moment a link is approved, when waiting for the next tick
 * would leave the new device empty for five minutes.
 */
export async function syncNow(): Promise<void> {
    const standing = await refreshMe();
    if (standing?.status === 'pending') {
        document.dispatchEvent(new CustomEvent('anchorsynced'));
        return;
    }
    // The profile next: it decides what a follower's next read of the anchor
    // below is reduced to.
    await pushProfile();
    await pushMyAnchor();
    await refreshFollowing();
    // For what else is worth refreshing on the same beat — the list of who can
    // see your time, which lives in pairing.ts and so cannot be called from here.
    document.dispatchEvent(new CustomEvent('anchorsynced'));
}

/**
 * Sends this device's anchor whether or not it is due.
 *
 * For the one moment when "due" is the wrong question: an account has just
 * been created, so the relay has never heard this device's time, and somebody
 * is about to read a code out loud. Waiting for the next tick meant the person
 * on the other end redeemed and then watched "Not shared yet" for up to five
 * minutes — the feature's first impression, and it looked broken.
 */
export async function pushMyAnchorNow(): Promise<boolean> {
    if (!storedToken() || !isPrimaryDevice()) return false;

    const anchor = myAnchor();
    if (!anchor) return false;
    if (!await pushAnchor(anchor)) return false;

    rememberPushed(anchor, Date.now());
    return true;
}

/**
 * Puts the name and the privacy switch where the relay can see them, until it has.
 *
 * Kept on the device either way, so the switch works before anybody has an
 * account, and goes up once there is one. Called on every sync as well as on
 * every change, and only remembered once the relay says yes, so a change made
 * with no signal keeps being sent until it lands. Until then the relay goes on
 * applying whatever it was last told — which for the switch is the one lag that
 * matters, and why this does not wait to be asked.
 *
 * Does nothing without an account, like updateProfile, rather than minting one.
 */
export async function pushProfile(): Promise<boolean> {
    const token = storedToken();
    if (!token || me?.status === 'pending') return false;

    const profile: SharedProfile = { name: state.shareName ?? '', shareExact: state.shareExact };
    const acknowledged = acknowledgedProfile();
    if (!profileNeedsPush(profile, acknowledged ? { account: token, profile: acknowledged } : null, token)) {
        return true;
    }
    if (!await updateProfile(profile)) return false;

    rememberAcknowledgedProfile(profile);
    return true;
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

    // People followed through an alpha account, which nothing can sign in as
    // any more: their rows could never update again, and never be stopped.
    if (dropAlphaAccount()) persistFollowedPeople([]);
    // Removed from another device, turned down, or deleted elsewhere: the
    // people followed through that account are no longer this device's to see.
    document.addEventListener('anchorsignedout', () => {
        me = null;
        persistFollowedPeople([]);
    });

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
    // Not a zone means aboard a ship, since anchorFrom builds nothing else —
    // an OffsetAnchor is the relay's to make, never this device's.
    if (anchor.kind !== 'zone') return anchorSubLabel(anchor);

    // "the Vancouver timezone", not "Vancouver" and not "America/Vancouver".
    //
    // The raw id is what anchorSubLabel returns, because that function is
    // compiled into the Worker too and cannot reach the display-name table. It
    // is also the wrong thing to show somebody: they are being told how they
    // look to other people, and this is the one line where the answer and the
    // reassurance are the same sentence. A ZONE is what goes out — not a town,
    // not a city — and saying "timezone" out loud here is cheaper than any
    // amount of explaining elsewhere.
    return `the ${getDisplayTimezoneName(anchor.tz)} timezone`;
}

/**
 * Whether this is a browser, which can be linked to an account but never share
 * its owner's time or start an account of its own. See the pairing UI.
 */
export function isBrowser(): boolean {
    return !Capacitor.isNativePlatform();
}
