import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { serverClockOffset, msUntilNextSecond, DEADBAND_MS } from './clock-offset';

// The failure these guard against is silent and shaped like success: a clock
// that is confidently wrong looks exactly like a clock that is right, on a
// surface whose entire purpose is telling you the time. None of this can be
// caught by eye — a 60 ms bias is invisible and a 500 ms one is a coin toss.

describe('server clock offset', () => {
    describe('latency', () => {
        // The bug this replaced: the device clock was read AFTER the response
        // had arrived, so the server's stamp was credited as if it had
        // travelled instantly and the offset came out low by the downlink leg.
        it('credits the server stamp to the middle of the round trip', () => {
            // Device clock is perfect. Server stamps at the midpoint, 50ms in.
            const sentAt = 10_000;
            const receivedAt = 10_100;
            const serverUtcMs = 10_050;
            assert.equal(serverClockOffset(serverUtcMs, { sentAt, receivedAt }), 0);
        });

        it('does not mistake a slow link for a wrong clock', () => {
            // A satellite round trip: 1.2 s, device clock exactly right.
            const sentAt = 0;
            const receivedAt = 1200;
            const serverUtcMs = 600;              // stamped at the midpoint
            // Read after the fact, the old way, this would have looked like a
            // 600 ms error and been applied. Centred, it is nothing.
            assert.equal(serverClockOffset(serverUtcMs, { sentAt, receivedAt }), 0);
            assert.ok(Math.abs(serverUtcMs - receivedAt) > DEADBAND_MS,
                'the uncentred reading really would have crossed the deadband');
        });

        it('still finds a genuinely wrong clock through a slow link', () => {
            // Same 1.2 s trip, but the device is 5 s fast.
            const sentAt = 5000, receivedAt = 6200, serverUtcMs = 600;
            assert.equal(serverClockOffset(serverUtcMs, { sentAt, receivedAt }), -5000);
        });

        it('falls back to reading the clock when the trip was not stamped', () => {
            assert.equal(
                serverClockOffset(9000, { now: () => 1000 }),
                8000,
            );
        });

        it('ignores a half-stamped trip rather than inventing the other end', () => {
            assert.equal(serverClockOffset(9000, { sentAt: 500, now: () => 1000 }), 8000);
            assert.equal(serverClockOffset(9000, { receivedAt: 1500, now: () => 1000 }), 8000);
        });

        it('ignores stamps that came back out of order', () => {
            // A clock that stepped mid-request would otherwise produce a
            // midpoint that is not inside the trip at all.
            assert.equal(
                serverClockOffset(9000, { sentAt: 2000, receivedAt: 1000, now: () => 1000 }),
                8000,
            );
        });
    });

    describe('timestamp granularity', () => {
        // An HTTP `Date` header is whole seconds by spec, and names the START of
        // its second. Taken at face value it is biased half a second slow —
        // which is exactly one deadband, so it could push a correct clock over
        // the threshold on its own.
        it('centres a whole-second timestamp in the second it names', () => {
            // Device is right; the header says 10 while the true instant is
            // 10.5, because the header was generated at 10.5 and truncated.
            const sentAt = 10_500, receivedAt = 10_500;
            assert.equal(
                serverClockOffset(10_000, { sentAt, receivedAt, resolutionMs: 1000 }),
                0,
            );
        });

        it('would have mis-set the clock without the centring', () => {
            const sentAt = 10_500, receivedAt = 10_500;
            const uncentred = serverClockOffset(10_000, { sentAt, receivedAt });
            assert.equal(uncentred, -500, 'half a second slow, and past the deadband');
        });

        it('leaves a millisecond timestamp alone', () => {
            assert.equal(
                serverClockOffset(10_000, { sentAt: 10_000, receivedAt: 10_000 }),
                0,
            );
        });
    });

    describe('the deadband', () => {
        it('trusts the device inside it', () => {
            assert.equal(serverClockOffset(1499, { sentAt: 1000, receivedAt: 1000 }), 0);
            assert.equal(serverClockOffset(501, { sentAt: 1000, receivedAt: 1000 }), 0);
        });

        it('corrects outside it, in both directions', () => {
            assert.equal(serverClockOffset(1500, { sentAt: 1000, receivedAt: 1000 }), 500);
            assert.equal(serverClockOffset(500, { sentAt: 1000, receivedAt: 1000 }), -500);
        });
    });

    it('returns no correction for a timestamp that did not parse', () => {
        assert.equal(serverClockOffset(NaN, { now: () => 1000 }), 0);
    });
});

describe('tick alignment', () => {
    /** Where in its second an instant lands. JS `%` keeps the dividend's sign. */
    const phaseOf = (ms: number) => ((ms % 1000) + 1000) % 1000;

    // Cannot be observed in a background tab: browsers clamp setTimeout to
    // >=1000ms when the page is hidden, which destroys the phase and makes any
    // measurement there a reading of the clamp rather than of this. Measured
    // here instead, where the arithmetic is all there is.
    it('lands just past the boundary from any starting phase', () => {
        for (const phase of [0, 1, 384, 500, 912, 999]) {
            const now = 1_700_000_000_000 + phase;
            const landing = phaseOf(now + msUntilNextSecond(now));
            assert.equal(landing, 8, `starting at .${phase}`);
        }
    });

    it('never schedules in the past, and never skips a second', () => {
        for (const phase of [0, 1, 384, 912, 999]) {
            const wait = msUntilNextSecond(1_700_000_000_000 + phase);
            assert.ok(wait > 0, `waited ${wait} from .${phase}`);
            assert.ok(wait <= 1008, `waited ${wait} from .${phase} — a second was skipped`);
        }
    });

    it('self-corrects rather than inheriting a phase', () => {
        // A tick dragged late by throttling or a slow paint realigns on the
        // next round instead of keeping the phase it was pushed to.
        let now = 1_700_000_000_000 + 912;      // badly off-phase
        now += msUntilNextSecond(now) + 640;    // and the timer fires 640ms late
        assert.equal(phaseOf(now + msUntilNextSecond(now)), 8);
    });

    it('holds up before the epoch, where the remainder goes negative', () => {
        const beforeEpoch = -1_700_000_000_000 - 250;
        assert.equal(phaseOf(beforeEpoch + msUntilNextSecond(beforeEpoch)), 8);
    });
});
