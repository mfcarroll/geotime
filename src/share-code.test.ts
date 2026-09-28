import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SHARE_CODE_ALPHABET,
    SHARE_CODE_LENGTH,
    formatShareCode,
    mintShareCode,
    normaliseShareCode,
    findShareCode,
    shapeCodeField,
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

// What the share sheet sends — keep in step with sendCode() in pairing.ts.
const message = (name: string) =>
    `${name} wants to share their time with you on GeoTime.\n\n`
    + 'Tap to follow: https://geotime.app/f/AH90M8FX\n\n'
    + 'Or open GeoTime, tap "Follow someone" and enter AH90-M8FX.';

test('the code is found in the whole message, not in the hostname', () => {
    assert.equal(findShareCode(message('Matthew')), 'AH90M8FX');
    assert.equal(findShareCode(message('Christopher')), 'AH90M8FX');
    // The old rule took the first eight letters in a row, which found "matthewc"
    // in the link's host before it found the code. Any long enough host would.
    assert.equal(findShareCode(message('Matthew').replace('geotime.app', 'geotime-api.matthewcarroll.ca')), 'AH90M8FX');
});

test('the code is found in a link, a printed code, or on its own', () => {
    assert.equal(findShareCode('https://geotime.app/f/AH90-M8FX'), 'AH90M8FX');
    assert.equal(findShareCode('enter ah90-m8fx please'), 'AH90M8FX');
    assert.equal(findShareCode('  AH90 M8FX '), 'AH90M8FX');
});

test('a long word that merely has eight letters is not a code', () => {
    assert.equal(findShareCode('Christopher says hello'), null);
    assert.equal(findShareCode('AH90M8FXAH90M8FX'), null);
});

test('the box takes a code being typed, with the hyphen once it is due', () => {
    assert.equal(shapeCodeField('ah9'), 'AH9');
    assert.equal(shapeCodeField('AH90'), 'AH90');
    assert.equal(shapeCodeField('AH90M'), 'AH90-M');
    assert.equal(shapeCodeField('AH90-M8'), 'AH90-M8');
    assert.equal(shapeCodeField('AH90-'), 'AH90');     // backspacing past the hyphen
});

test('the box stops at a code\'s worth', () => {
    // Typed twice by mistake: the second copy has nowhere to go.
    assert.equal(shapeCodeField('AH90M8FXAH90M8FX'), 'AH90-M8FX');
});

test('the box maps lookalikes and drops what a code cannot contain', () => {
    assert.equal(shapeCodeField('oh9o'), '0H90');
    assert.equal(shapeCodeField('AH!9?0'), 'AH90');
});

test('pasting the whole message into the box gives the code', () => {
    assert.equal(shapeCodeField(message('Matthew')), 'AH90-M8FX');
});
