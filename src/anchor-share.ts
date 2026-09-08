// src/anchor-share.ts
//
// Talking to the relay.
//
// The transport, and nothing else: no state, no rendering, no decisions about
// when to call any of it. What it owes its callers is the house rule every
// other network module here follows — never throw, and answer null when the
// answer is unknown, so that "offline" and "nobody is sharing with you" can
// never be confused for one another. The app's job on a null is to keep showing
// what it last knew.
//
// The rule has one exception, and it is the pairing screen: somebody is
// standing there having just tapped a button or typed a code, and "something
// went wrong" is not an answer to a person who is waiting. Those two calls
// return a reason instead of a null, so the screen can say whether the code was
// wrong, whether the account is full, or whether the server simply could not be
// reached — three states that want three different sentences and, more to the
// point, three different next moves.

import { Capacitor, CapacitorHttp } from '@capacitor/core';

import { forgetAccountId, rememberAccountId, storedAccountId } from './account';
import { validateAnchor, type Anchor } from './anchor';

/**
 * Must match the default in vite.config.js, which builds the CSP from it — a
 * client that calls somewhere the page is not allowed to reach fails only in a
 * browser, which is the one place this is quickest to test.
 */
const BASE =
    // Optional-chained so this module can be imported outside Vite, where
    // `import.meta.env` does not exist at all. That is not a nicety: it is the
    // difference between this being testable against a real relay and being
    // testable only through a browser.
    import.meta.env?.VITE_ANCHOR_SHARE
    ?? 'https://geotime-api.matthewcarroll.ca/anchor';

/** One person you follow, as the relay describes them. */
export interface Followed {
    shareId: string;
    /**
     * What they call themselves, offered as the label for their row.
     *
     * Only ever a suggestion: the row's name is the follower's own, and
     * replacing it with "Mum" is the expected thing to do. Null when they never
     * set one.
     */
    name: string | null;
    /**
     * Null when the pairing worked but they have not pushed an anchor yet.
     *
     * A ZoneAnchor here means they have "share my exact timezone" on. An
     * OffsetAnchor means they have not, and it is all anybody gets — see
     * anchorAsSeen in the relay, which is where that decision is enforced
     * rather than merely respected.
     */
    anchor: Anchor | null;
    /** Epoch ms, stamped by the relay. Null alongside a null anchor. */
    updatedAt: number | null;
}

/** One code you have handed out, or are about to. */
export interface Invitation {
    shareId: string;
    /** Who took it up, by the name they chose. Null while it is unredeemed. */
    name: string | null;
    /** Null once somebody has redeemed it, or once it has expired. */
    code: string | null;
    createdAt: number;
    redeemedAt: number | null;
}

/** Why a code did not work, for a person who is standing there waiting. */
export type RedeemResult =
    | { ok: true; shareId: string; name: string | null }
    | { ok: false; reason: 'invalid' | 'yourself' | 'full' | 'unreachable' };

/**
 * Why a code could not be minted. Same bargain as RedeemResult.
 *
 * The code is narrowed to a string here, where Invitation allows null: a
 * listed invitation may have been redeemed and spent its code, but one that
 * has just been minted has one by definition. Saying so in the type saves the
 * caller — whose entire job is to put that code on a screen — from asserting
 * past a null that cannot happen.
 */
export type InviteResult =
    | { ok: true; invitation: Invitation & { code: string } }
    | { ok: false; reason: 'full' | 'unreachable' };

interface Sent {
    status: number;
    body: unknown;
}

/**
 * One request, never throwing.
 *
 * CapacitorHttp on native for the reason src/rccl.ts and src/shiptrack.ts use
 * it — it bypasses the WebView's CORS enforcement, which the app's origin gives
 * it no way to satisfy. On the web the Worker's own headers make fetch work.
 *
 * A status of 0 is this module's own "never arrived", which is distinct from
 * every status the relay can return.
 */
async function send(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    token: string | null,
    body?: unknown,
): Promise<Sent> {
    const url = `${BASE}${path}`;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    try {
        if (Capacitor.isNativePlatform()) {
            const response = await CapacitorHttp.request({
                url, method, headers,
                data: body === undefined ? undefined : body,
            });
            // CapacitorHttp parses JSON itself, and hands back a string when the
            // content type surprises it.
            const parsed = typeof response.data === 'string'
                ? safeParse(response.data)
                : response.data;
            return { status: response.status, body: parsed };
        }

        const response = await fetch(url, {
            method, headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: safeParse(await response.text()) };
    } catch {
        return { status: 0, body: null };
    }
}

function safeParse(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return null;
    }
}

const field = (body: unknown, name: string): unknown =>
    body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;

const stringField = (body: unknown, name: string): string | null => {
    const value = field(body, name);
    return typeof value === 'string' && value ? value : null;
};

/**
 * This install's id, minting one if it has never needed one before.
 *
 * Minting is deliberately lazy. An app that has never shared and never followed
 * has no business having an identity on a server, and the overwhelming majority
 * of installs never will — so nothing is created until the first moment
 * somebody actually asks to pair.
 *
 * Null means the relay could not be reached, which callers must not read as
 * "no account": minting again later is fine, minting twice is not.
 */
let minting: Promise<string | null> | null = null;

export async function ensureAccount(name?: string | null): Promise<string | null> {
    const existing = storedAccountId();
    if (existing) return existing;

    // ONE mint, however many callers. Two concurrent calls used to make two
    // accounts: both read a null id, both posted, and whichever answered last
    // won the stored id — so a share redeemed by the first was bound to an
    // account nothing could name any more. Unreachable, unrevokable, and the
    // code spent. It happened on the very first thing a new install does,
    // because a cold start from a follow link fires appUrlOpen AND resolves
    // getLaunchUrl with the same URL.
    //
    // The in-flight promise is the whole fix. Cleared afterwards so a failed
    // mint can be retried rather than remembered as a permanent null.
    if (!minting) {
        minting = mintAccount(name).finally(() => { minting = null; });
    }
    return minting;
}

async function mintAccount(name?: string | null): Promise<string | null> {
    // The name goes in at creation, because the next thing that happens is a
    // code being minted and a share with no name on it gives the other end a
    // blank row to look at.
    const { status, body } = await send('POST', '/v1/account', null,
                                        name ? { name } : undefined);
    if (status !== 201) return null;

    const id = stringField(body, 'accountId');
    if (!id) return null;

    rememberAccountId(id);
    return id;
}

/**
 * Tells the relay what time it is here now.
 *
 * Does NOT mint an account: somebody who has never paired has nothing to push
 * and nobody to push it to, and creating an identity for them would be creating
 * a server-side record of a person who never asked for one. Silent no-op until
 * an account exists.
 */
export async function pushAnchor(anchor: Anchor): Promise<boolean> {
    const token = storedAccountId();
    if (!token) return false;

    const { status } = await send('PUT', '/v1/anchor', token, anchor);
    return status === 200;
}

/**
 * Mints a code to read out.
 *
 * A refusal is told apart from a failure, because the two want opposite things
 * from the person: being at the cap means stopping somebody first, and being
 * unable to reach the relay means trying again in a minute. Reporting the cap
 * as a network problem sends them to look at their wifi over a limit that has
 * nothing to do with it.
 */
export async function createInvitation(name?: string | null): Promise<InviteResult> {
    const token = await ensureAccount(name);
    if (!token) return { ok: false, reason: 'unreachable' };

    const { status, body } = await send('POST', '/v1/shares', token);
    if (status === 409) return { ok: false, reason: 'full' };
    if (status !== 201) return { ok: false, reason: 'unreachable' };

    const shareId = stringField(body, 'shareId');
    const code = stringField(body, 'code');
    if (!shareId || !code) return { ok: false, reason: 'unreachable' };

    // Nobody has taken it up yet, so there is nobody to name.
    return {
        ok: true,
        invitation: { shareId, name: null, code, createdAt: Date.now(), redeemedAt: null },
    };
}

/**
 * Redeems what somebody typed.
 *
 * The relay is the one that normalises the code — it has to, since it is the
 * one matching against what it stored — so whatever was typed goes as typed.
 */
export async function redeemInvitation(typed: string): Promise<RedeemResult> {
    const token = await ensureAccount();
    if (!token) return { ok: false, reason: 'unreachable' };

    const { status, body } = await send('POST', '/v1/shares/redeem', token, { code: typed });
    if (status === 201) {
        const shareId = stringField(body, 'shareId');
        return shareId
            ? { ok: true, shareId, name: stringField(body, 'name') }
            : { ok: false, reason: 'unreachable' };
    }

    // 400 covers both a code that is not a code and one that is your own, and
    // the two want different words on screen.
    if (stringField(body, 'error') === 'cannot_follow_yourself') {
        return { ok: false, reason: 'yourself' };
    }
    if (status === 409) return { ok: false, reason: 'full' };
    if (status === 400 || status === 404) return { ok: false, reason: 'invalid' };
    return { ok: false, reason: 'unreachable' };
}

/**
 * Everybody you follow, or null if the relay could not be reached.
 *
 * Null is emphatically not an empty list. A follower who loses signal keeps the
 * rows they had, aged — the app's standing rule for anything with a timestamp,
 * and the difference between "they have stopped sharing" and "I cannot ask".
 */
export async function fetchFollowing(): Promise<Followed[] | null> {
    const token = storedAccountId();
    if (!token) return [];

    const { status, body } = await send('GET', '/v1/following', token);
    if (status === 401) {
        // The account is gone from the relay — deleted from another device, or
        // swept. Holding a token it will never honour again helps nobody.
        forgetAccountId();
        return [];
    }
    if (status !== 200) return null;

    const people = field(body, 'people');
    if (!Array.isArray(people)) return null;

    const followed: Followed[] = [];
    for (const row of people) {
        const shareId = stringField(row, 'shareId');
        if (!shareId) continue;

        // Validated here as well as at the relay. It was checked on the way in,
        // and has since crossed a database, a JSON encoding and a network; this
        // is the last place that can decline to put a malformed row on a widget.
        const anchor = validateAnchor(field(row, 'anchor'));
        const updatedAt = Number(field(row, 'updatedAt'));

        followed.push({
            shareId,
            name: stringField(row, 'name'),
            anchor,
            updatedAt: anchor && Number.isFinite(updatedAt) ? updatedAt : null,
        });
    }
    return followed;
}

/**
 * Sets the name a follower is offered, and the one privacy switch.
 *
 * Does NOT mint an account, for the same reason pushAnchor does not: somebody
 * who has never paired has nobody to be named to. The settings live on the
 * device regardless and go up with the account when there first is one.
 */
export async function updateProfile(
    profile: { name?: string; shareExact?: boolean },
): Promise<boolean> {
    const token = storedAccountId();
    if (!token) return false;

    const { status } = await send('PUT', '/v1/profile', token, profile);
    return status === 200;
}

/** Every code you have handed out, so they can be shown or withdrawn. */
export async function fetchInvitations(): Promise<Invitation[] | null> {
    const token = storedAccountId();
    if (!token) return [];

    const { status, body } = await send('GET', '/v1/followers', token);
    if (status !== 200) return null;

    const followers = field(body, 'followers');
    if (!Array.isArray(followers)) return null;

    const out: Invitation[] = [];
    for (const row of followers) {
        const shareId = stringField(row, 'shareId');
        if (!shareId) continue;
        const redeemedAt = Number(field(row, 'redeemedAt'));
        out.push({
            shareId,
            name: stringField(row, 'name'),
            code: stringField(row, 'code'),
            createdAt: Number(field(row, 'createdAt')) || Date.now(),
            redeemedAt: Number.isFinite(redeemedAt) ? redeemedAt : null,
        });
    }
    return out;
}

/**
 * Ends one share, from either end.
 *
 * The same call whether you are the one being read or the one reading: nobody
 * should have to ask permission to stop being followed, and nobody should have
 * to keep a row they no longer want.
 */
export async function revokeShare(shareId: string): Promise<boolean> {
    const token = storedAccountId();
    if (!token) return false;

    const { status } = await send('DELETE', `/v1/shares/${encodeURIComponent(shareId)}`, token);
    // Already gone counts as done. The caller wanted it not to exist.
    return status === 200 || status === 404;
}

/**
 * Deletes everything the relay holds about this install, then forgets the id.
 *
 * In that order, and only forgetting locally if the relay agreed — dropping the
 * token first would leave rows on a server with nothing left that could ever
 * ask for them again.
 */
export async function deleteAccount(): Promise<boolean> {
    const token = storedAccountId();
    if (!token) return true;

    const { status } = await send('DELETE', '/v1/me', token);
    if (status !== 200 && status !== 401) return false;

    forgetAccountId();
    return true;
}
