// src/clock-offset.ts
//
// The clock arithmetic worth testing: how far the device clock is wrong given
// what a server said and when it said it, and when the next repaint is due.
//
// Neither answer can be checked by eye. A 60 ms bias is invisible, a 500 ms one
// is a coin toss, and a repaint that lands a fraction of a second late looks
// exactly like a clock that is simply wrong.
//
// Its own module because it is pure and worth testing, and time.ts is not
// importable outside a browser — it reaches dom.ts for `document`. Same reason
// stored-zones.ts, zone-order.ts and ship-position.ts live apart from their
// callers.

export interface ServerTimeReading {
    /** `Date.now()` immediately BEFORE the request went out. */
    sentAt?: number;
    /** `Date.now()` immediately after the response came back. */
    receivedAt?: number;
    /**
     * Granularity of the server's timestamp. 0 for a millisecond value; 1000 for
     * an HTTP `Date` header, which is whole seconds by spec.
     */
    resolutionMs?: number;
    /** Injected only by tests; production reads the real clock. */
    now?: () => number;
}

/**
 * Below this, the difference is indistinguishable from the round trip that
 * carried it, so the device clock is left alone.
 *
 * Kept from the original implementation. Note what it is worth half of: an HTTP
 * `Date` header is granular to exactly one second, so an uncentred header
 * reading is biased by up to a whole deadband before latency is considered.
 */
export const DEADBAND_MS = 500;

/**
 * The correction to add to the device clock, or 0 to trust it.
 *
 * Two things are undone before the subtraction, and neither used to be.
 *
 * LATENCY. The old form was `serverUtcMs - Date.now()` with the clock read after
 * the response had arrived and been decoded — which credits the server's stamp
 * as though it travelled instantly, and so runs the offset low by roughly the
 * downlink leg. Measured against the live Worker on wifi: 15-60 ms low, or about
 * half the round trip. The midpoint of the two stamps is the standard estimate.
 * It assumes the legs are symmetrical, which they are not exactly — but half a
 * round trip is a far better guess at the error than all of it.
 *
 * On wifi the deadband swallows the difference either way. It matters on the
 * link where this app's whole promise matters: a satellite connection at sea,
 * where the round trip runs 600-1500 ms and half of that is comparable to the
 * deadband itself.
 *
 * RESOLUTION. A coarse timestamp names the START of its own interval — an HTTP
 * `Date` of 18:57:55 was generated somewhere in [55.000, 56.000) — so taking it
 * at face value is biased half a tick slow on top of the latency. Centring it
 * costs one addition and removes a systematic error large enough, at one-second
 * granularity, to push an accurate clock over the threshold on its own.
 */
export function serverClockOffset(serverUtcMs: number, reading: ServerTimeReading = {}): number {
    const { sentAt, receivedAt, resolutionMs = 0, now = Date.now } = reading;
    if (!Number.isFinite(serverUtcMs)) return 0;

    // Both stamps or neither: one of them alone says nothing about the trip, and
    // guessing the other would be inventing a number.
    const readAt = sentAt !== undefined && receivedAt !== undefined && receivedAt >= sentAt
        ? (sentAt + receivedAt) / 2
        : now();

    const offset = (serverUtcMs + resolutionMs / 2) - readAt;
    return Math.abs(offset) < DEADBAND_MS ? 0 : offset;
}

/**
 * How long until the displayed second turns over.
 *
 * The tick used to be `setInterval(..., 1000)`, which keeps forever whichever
 * phase it happened to start on. Start at .384 of a second and every repaint
 * lands at .384: the digits are right when they are written, but they are
 * written up to a second after they became true, so the app reads permanently
 * behind any clock that ticks on the boundary — an OS menu bar, say. The
 * signature is distinctive, and was reported exactly this way: every clock in
 * the app agreeing with the others and all of them a beat behind the desktop.
 *
 * Derived from the clock each time rather than chained at a flat 1000 ms, so it
 * cannot accumulate the drift an interval is prone to, and so a tab that was
 * throttled in the background re-aligns on its first tick back rather than
 * keeping whatever phase the throttling left it on.
 *
 * @param nowMs  the CORRECTED clock — what the app actually draws. If the
 *   device is a quarter-second fast and that is known, the digits should still
 *   turn over when the true second does.
 * @param marginMs  a few ms past the boundary. Timers fire no earlier than
 *   asked but routinely a shade late; landing a hair early would render the
 *   second that is about to end, which is the fault being removed.
 */
export function msUntilNextSecond(nowMs: number, marginMs = 8): number {
    const phase = ((nowMs % 1000) + 1000) % 1000;   // negative epochs exist
    return 1000 - phase + marginMs;
}
