import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SHARE_CODE_ALPHABET,
    SHARE_CODE_LENGTH,
    formatShareCode,
    mintShareCode,
    normaliseShareCode,
} from './share-code';

/** Bytes in a known order, so a code can be asserted rather than sampled. */
const bytes = (...values: number[]) => {
    let i = 0;
    return (n: number) => Uint8Array.from({ length: n }, () => values[i++ % values.length]);
};

test('minting a code', async (t) => {
    await t.test('is eight characters of the alphabet', () => {
        const code = mintShareCode((n) => crypto.getRandomValues(new Uint8Array(n)));
        assert.equal(code.length, SHARE_CODE_LENGTH);
        for (const ch of code) assert.ok(SHARE_CODE_ALPHABET.includes(ch), ch);
    });

    await t.test('maps each byte to its place in the alphabet', () => {
        assert.equal(mintShareCode(bytes(0, 1, 2, 3, 4, 5, 6, 7)), '01234567');
        assert.equal(mintShareCode(bytes(31, 30, 29, 28, 27, 26, 25, 24)), 'ZYXWVTSR');
    });

    await t.test('throws back the biased tail rather than folding it in', () => {
        // 256 is eight alphabets exactly, so a modulo would be uniform here by
        // luck. The loop is what keeps that true if the alphabet ever changes.
        // 255 is inside the usable range; a hypothetical 250 with a 12-char
        // alphabet would not be, and this is the mechanism that would catch it.
        const code = mintShareCode(bytes(255, 0, 1, 2, 3, 4, 5, 6));
        assert.equal(code.length, SHARE_CODE_LENGTH);
        for (const ch of code) assert.ok(SHARE_CODE_ALPHABET.includes(ch), ch);
    });

    await t.test('never runs short, however unhelpful the randomness', () => {
        // A source that keeps returning the same usable byte still yields a
        // full-length code rather than looping forever or returning a stub.
        assert.equal(mintShareCode(bytes(7)), '77777777');
    });

    await t.test('two codes in a row are not the same code', () => {
        const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
        const seen = new Set(Array.from({ length: 200 }, () => mintShareCode(random)));
        assert.equal(seen.size, 200);
    });
});

test('reading a code back in', async (t) => {
    await t.test('takes it as printed, hyphen and all', () => {
        assert.equal(normaliseShareCode('ABCD-EFGH'), 'ABCDEFGH');
    });

    await t.test('and without, and in lower case, and with stray spaces', () => {
        for (const typed of ['ABCDEFGH', 'abcd-efgh', ' abcdefgh ', 'ABCD EFGH', 'a b c d e f g h']) {
            assert.equal(normaliseShareCode(typed), 'ABCDEFGH', typed);
        }
    });

    await t.test('maps the lookalikes rather than refusing them', () => {
        // Crockford's whole point. Somebody reading "0" aloud as "oh", and
        // somebody typing what they hear, should still pair.
        assert.equal(normaliseShareCode('O123456I'), '01234561');
        assert.equal(normaliseShareCode('L1234567'), '11234567');
        assert.equal(normaliseShareCode('o123456l'), '01234561');
    });

    await t.test('refuses U, which the alphabet leaves out on purpose', () => {
        assert.equal(normaliseShareCode('UBCDEFGH'), null);
    });

    await t.test('refuses anything of the wrong length', () => {
        assert.equal(normaliseShareCode('ABCDEFG'), null);
        assert.equal(normaliseShareCode('ABCDEFGHJ'), null);
        assert.equal(normaliseShareCode(''), null);
        assert.equal(normaliseShareCode('----'), null);
    });

    await t.test('refuses what is not a code at all', () => {
        assert.equal(normaliseShareCode('ABCD!EFG'), null);
        assert.equal(normaliseShareCode('ABCD😀EF'), null);
        assert.equal(normaliseShareCode(42 as unknown as string), null);
    });

    await t.test('takes back everything it mints', () => {
        const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
        for (let i = 0; i < 200; i++) {
            const code = mintShareCode(random);
            assert.equal(normaliseShareCode(formatShareCode(code)), code);
        }
    });
});

test('showing a code', async (t) => {
    await t.test('breaks it once, in the middle', () => {
        assert.equal(formatShareCode('ABCDEFGH'), 'ABCD-EFGH');
    });

    await t.test('and the break costs the person typing it nothing', () => {
        assert.equal(normaliseShareCode(formatShareCode('ABCDEFGH')), 'ABCDEFGH');
    });
});
