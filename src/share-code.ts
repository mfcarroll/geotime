// src/share-code.ts
//
// The code one person reads out and another types in.
//
// Shared between the relay that mints it and the app that shows and accepts it,
// for the same reason the anchor is: one definition, no second copy to drift.
//
// Crockford's base32, which exists for exactly this job — a human reading
// characters aloud, or off a screen, into another device. Its alphabet leaves
// out I, L, O and U: the first three because they are indistinguishable from 1
// and 0 in most typefaces, and U so that no code is ever an accidental
// obscenity. What it does instead of forbidding the lookalikes is MAP them, so
// somebody who types the letter O where a zero was printed is simply right.
//
// Eight characters is forty bits. The codes are single-use, expire unredeemed
// within a day, and redemption is rate-limited, so forty bits is not protecting
// a secret so much as making a guess pointless.

/** Crockford's base32: ten digits and twenty-two letters, less I, L, O and U. */
export const SHARE_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Long enough that guessing is pointless, short enough to read aloud. */
export const SHARE_CODE_LENGTH = 8;

/**
 * A code, from a source of randomness the caller provides.
 *
 * The randomness is an argument so this can be tested against a known sequence
 * rather than against chance. Callers pass `crypto.getRandomValues`.
 *
 * Rejection sampling rather than a modulo: 256 is not a multiple of 32 — it is,
 * in fact, exactly eight times — so a modulo would be uniform here by luck. The
 * alphabet is a constant somebody may reasonably shorten one day, and a bias
 * that appears silently when they do is worse than the loop.
 */
export function mintShareCode(
    randomBytes: (n: number) => Uint8Array,
    length = SHARE_CODE_LENGTH,
): string {
    const alphabet = SHARE_CODE_ALPHABET;
    const limit = Math.floor(256 / alphabet.length) * alphabet.length;
    let code = '';

    while (code.length < length) {
        // A block at a time; most bytes are usable, so this rarely goes twice.
        for (const byte of randomBytes(length)) {
            if (byte >= limit) continue;              // biased tail, thrown back
            code += alphabet[byte % alphabet.length];
            if (code.length === length) break;
        }
    }
    return code;
}

/**
 * What was typed, as the code it was meant to be — or null.
 *
 * Forgiving about everything that does not carry meaning. Case is not
 * significant; neither are spaces, hyphens or the grouping the app prints, so a
 * code copied with its dash, or typed without one, or pasted with a stray space
 * from a chat app, all arrive at the same place.
 *
 * The lookalikes are mapped rather than refused, which is Crockford's whole
 * point: I and L become 1, O becomes 0. Somebody reading "0" aloud as "oh" and
 * somebody typing what they hear should not be a failed pairing.
 */
export function normaliseShareCode(typed: string): string | null {
    if (typeof typed !== 'string') return null;

    let code = '';
    for (const ch of typed.toUpperCase()) {
        if (ch === '-' || ch === ' ' || ch === '\t') continue;
        const mapped = ch === 'I' || ch === 'L' ? '1' : ch === 'O' ? '0' : ch;
        if (!SHARE_CODE_ALPHABET.includes(mapped)) return null;   // U, punctuation, emoji
        code += mapped;
        if (code.length > SHARE_CODE_LENGTH) return null;
    }
    return code.length === SHARE_CODE_LENGTH ? code : null;
}

/**
 * The code as it should be shown: "ABCD-EFGH".
 *
 * One break in the middle. Two groups of four is the length people read back
 * accurately without losing their place, and the hyphen is thrown away again on
 * the way in, so it costs the person typing it nothing.
 */
export function formatShareCode(code: string): string {
    const half = Math.ceil(code.length / 2);
    return `${code.slice(0, half)}-${code.slice(half)}`;
}
