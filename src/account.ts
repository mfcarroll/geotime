// src/account.ts
//
// Who this install is, to the relay.
//
// One opaque id, minted by the server and kept here. It is the bearer token —
// there is no password, no email, nothing to recover, because there is nothing
// behind it worth any of that: it grants writing your own anchor and reading
// the anchors of people who deliberately gave you a code.
//
// It is also the hook billing will need. Apple's `appAccountToken` and Google's
// `obfuscatedAccountId` both want a stable opaque id at purchase time, and this
// is the one they will get. Nothing charges for anything in 2.0.0; minting it
// now is what makes that possible later without a migration.
//
// WHERE IT LIVES, and a compromise worth naming. The plan said the Keychain and
// the Keystore, and this is localStorage — the same place the clock list and
// the ship list already live. On a device that is what the WebView gives you
// without a new plugin on both platforms, and it is inside the app's sandbox
// either way. The difference that matters is encryption at rest, and the secret
// being protected is permission to read somebody's timezone.
//
// It is a deliberate shortcut for the alpha rather than an oversight, and it is
// isolated here so that changing it is changing this file: three functions, no
// caller anywhere that knows where the bytes are.

/** Alongside `worldClocks` and `shipClocks`, and named like them. */
const ACCOUNT_KEY = 'anchorShareAccount';

/**
 * The id, or null when this install has never spoken to the relay.
 *
 * Null is the ordinary state, not an error: the app works entirely without an
 * account, and one is only minted when somebody first shares or follows.
 */
export function storedAccountId(): string | null {
    try {
        const id = localStorage.getItem(ACCOUNT_KEY);
        return id && id.trim() ? id.trim() : null;
    } catch {
        // Private browsing, or storage disabled. The feature is unavailable
        // rather than broken — every caller treats null as "not paired yet".
        return null;
    }
}

export function rememberAccountId(id: string): void {
    try {
        localStorage.setItem(ACCOUNT_KEY, id);
    } catch {
        // Nothing to do but carry on unpaired. Worth no louder a failure than
        // this: the app's whole other surface still works.
    }
}

/**
 * Forgets the id, which is what makes the account unreachable from here.
 *
 * Not on its own a deletion — the relay still holds the rows until it is told
 * otherwise, which is what `DELETE /v1/me` is for. Call that first; this is the
 * local half.
 */
export function forgetAccountId(): void {
    try {
        localStorage.removeItem(ACCOUNT_KEY);
    } catch {
        // Already gone, for the purposes of anyone asking.
    }
}
