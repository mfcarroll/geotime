import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { brighter } from './utils';

describe('brighter', () => {
    it('keeps a hue rather than replacing it with white', () => {
        // The fault: a gold port ring turned white under the pointer, which is
        // the colour that means "this call keeps the ship's time" being
        // overwritten by the colour that means "you are pointing at something".
        const gold = brighter('#FFD700');
        assert.notEqual(gold, '#FFFFFF');
        assert.match(gold, /^#FF[0-9A-F]{4}$/, 'still gold, further up the scale');
    });

    it('lifts every colour by the same amount of the room it has', () => {
        // Green and gold sit at different lightnesses; both should move a
        // comparable distance toward the top rather than to a shared endpoint.
        for (const hex of ['#FFD700', '#34C759', '#DC2A5B']) {
            const lit = brighter(hex);
            assert.notEqual(lit, hex);
            assert.notEqual(lit, '#FFFFFF');
        }
    });

    it('takes a colour that is already nearly white to white', () => {
        // PORT_PLAIN is 93% light: a proportional lift moves it three points
        // and nothing visible happens. White is the brighter version of
        // near-white, and only there.
        assert.equal(brighter('#E8EEF4'), '#FFFFFF');
    });

    it('leaves black able to move', () => {
        assert.notEqual(brighter('#000000'), '#000000');
    });

    it('gives white back for something it cannot read', () => {
        assert.equal(brighter('rgb(1,2,3)'), '#FFFFFF');
        assert.equal(brighter(''), '#FFFFFF');
    });
});
