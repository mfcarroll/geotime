// src/account.ts
//
// This device's standing with the relay: its credential, and the little it
// remembers about what the relay was last told.
//
// The credential is a random token the relay minted, sent as the bearer. It
// belongs to this DEVICE. The account behind it may have others — a tablet, a
// browser on a computer — each with a token of its own, any of which can be
// removed without the rest noticing. The relay keeps only a hash of each.
//
// The alpha kept the ACCOUNT id here and used that as the token, which could
// not stretch to a second device, and would have meant handing billing a
// password: Apple's appAccountToken and Google's obfuscatedAccountId are to be
// the account id. That key is dropped on update; see dropAlphaAccount.
//
// WHERE IT LIVES, and a compromise worth naming. The plan said the Keychain and
// the Keystore, and this is localStorage — the same place the clock list and
// the ship list already live. On a device that is what the WebView gives you
// without a new plugin on both platforms, and it is inside the app's sandbox
// either way. The difference that matters is encryption at rest, and the secret
// being protected is permission to read the timezones of people who chose to
// share theirs with you. In a browser it is the page's own storage, which is
// the reason a browser can only ever be linked to an account, and never be the
// device that shares its owner's time.
//
// Isolated here so that changing where it lives is changing this file.

import type { SharedProfile } from './anchor';

const TOKEN_KEY = 'anchorShareToken';
/** This device's id on the relay, and whether it is the one that shares. */
const DEVICE_KEY = 'anchorShareDevice';
/** The profile the relay last acknowledged, and which token it was for. */
const PROFILE_KEY = 'anchorProfilePushed';
const ALPHA_ACCOUNT_KEY = 'anchorShareAccount';

export interface DeviceStanding {
    deviceId: string;
    /** The device that shares this person's time. See `devices` in schema.sql. */
    primary: boolean;
}

function read(key: string): string | null {
    try {
        const value = localStorage.getItem(key);
        return value && value.trim() ? value.trim() : null;
    } catch {
        // Private browsing, or storage disabled. The feature is unavailable
        // rather than broken — every caller treats null as "not paired yet".
        return null;
    }
}

function write(key: string, value: string | null): void {
    try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch {
        // Nothing to do but carry on. Worth no louder a failure than this: the
        // app's whole other surface still works.
    }
}

/**
 * The token, or null when this device is not linked to an account.
 *
 * Null is the ordinary state, not an error: the app works entirely without an
 * account, and one is only minted when somebody first shares or follows.
 */
export function storedToken(): string | null {
    return read(TOKEN_KEY);
}

export function storedDevice(): DeviceStanding | null {
    try {
        const raw = JSON.parse(read(DEVICE_KEY) ?? 'null') as DeviceStanding | null;
        return raw && typeof raw.deviceId === 'string' ? { deviceId: raw.deviceId, primary: !!raw.primary } : null;
    } catch {
        return null;
    }
}

export function rememberCredential(token: string, device: DeviceStanding): void {
    write(TOKEN_KEY, token);
    write(DEVICE_KEY, JSON.stringify(device));
}

/** Whether this device shares its owner's time, as the relay last said. */
export function rememberPrimary(primary: boolean): void {
    const device = storedDevice();
    if (device && device.primary !== primary) write(DEVICE_KEY, JSON.stringify({ ...device, primary }));
}

/**
 * Forgets the credential, which is what makes the account unreachable from here.
 *
 * Not on its own a deletion — the relay still holds the rows until it is told
 * otherwise, which is what `DELETE /v1/me` is for. Call that first; this is the
 * local half.
 */
export function forgetCredential(): void {
    write(TOKEN_KEY, null);
    write(DEVICE_KEY, null);
    write(PROFILE_KEY, null);
}

/**
 * The name and switch the relay last acknowledged, for THIS credential.
 *
 * Kept per token so that a device linked to a new account — or re-linked —
 * starts from "the relay has told this device nothing", which reconcileProfile
 * reads as: take the account's, do not push your own. See anchor.ts.
 */
export function acknowledgedProfile(): SharedProfile | null {
    const token = storedToken();
    if (!token) return null;
    try {
        const raw = JSON.parse(read(PROFILE_KEY) ?? 'null') as { token?: string; profile?: SharedProfile } | null;
        if (!raw || raw.token !== token || !raw.profile) return null;
        return { name: String(raw.profile.name ?? ''), shareExact: !!raw.profile.shareExact };
    } catch {
        return null;
    }
}

export function rememberAcknowledgedProfile(profile: SharedProfile): void {
    const token = storedToken();
    if (token) write(PROFILE_KEY, JSON.stringify({ token, profile }));
}

/**
 * Drops the alpha's account id, which nothing can sign in with any more.
 *
 * True when there was one, so the caller can drop the rows that came with it:
 * people followed through an account this device can no longer reach, whose
 * times will never update and who could never be stopped from here.
 */
export function dropAlphaAccount(): boolean {
    if (!read(ALPHA_ACCOUNT_KEY)) return false;
    write(ALPHA_ACCOUNT_KEY, null);
    return true;
}
