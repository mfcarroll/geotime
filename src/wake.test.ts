import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { wakeRuns, JOINABLE_KM } from './wake';

// Real coordinates throughout, because the thing being guarded against was only
// visible in real data: a wake drawn confidently through places the ship had
// never been. Synthetic points a degree apart would prove the arithmetic and
// none of the judgement in the threshold.

/** Star of the Seas, where her retained wake actually stopped: NE of Cozumel. */
const OFF_COZUMEL: [number, number] = [-86.40427, 20.96229];
/** And where she actually was: alongside at Port Canaveral, 1,014 km away. */
const PORT_CANAVERAL: [number, number] = [-80.61014, 28.40875];

describe('wake runs', () => {
    it('keeps an unbroken wake in one piece', () => {
        // Six crumbs at a realistic hourly spacing off the Florida coast.
        const wake: Array<[number, number]> = [
            [-80.10, 28.20], [-80.40, 27.90], [-80.75, 27.60],
            [-81.05, 27.30], [-81.35, 27.00], [-81.65, 26.70],
        ];
        const runs = wakeRuns(wake);
        assert.equal(runs.length, 1);
        assert.deepEqual(runs[0], wake);
    });

    it('splits where the trail goes missing', () => {
        const runs = wakeRuns([
            [-80.10, 28.20], [-80.40, 27.90],
            OFF_COZUMEL,                       // 700+ km on from the last crumb
            [-86.55, 20.80],
        ]);
        assert.equal(runs.length, 2);
        assert.equal(runs[0].length, 2);
        assert.equal(runs[1].length, 2);
    });

    /**
     * The case that started this. The retained track ended inbound to Cozumel on
     * day four while she was alongside at Port Canaveral on day eight, and the
     * closing join drew a straight line between them — 285 km of it across
     * Florida.
     */
    it('does not join the ship to a wake that belongs to another day', () => {
        const wake: Array<[number, number]> = [
            [-86.14673, 21.15979], [-86.23083, 21.07788], [-86.30129, 21.01414],
            OFF_COZUMEL,
            PORT_CANAVERAL,             // where the hull actually is
        ];
        const runs = wakeRuns(wake);
        assert.equal(runs.length, 2, 'the hull is its own run');
        assert.deepEqual(runs[1], [PORT_CANAVERAL]);
        // A single-point run draws no line; the gap before it is what gets drawn,
        // dotted, and that is the whole of the intended output.
        assert.ok(runs[0].length >= 2);
    });

    it('still joins the ship when the wake merely lags behind her', () => {
        // The gap the join exists for: an hour behind at speed. About 40 km.
        const lastCrumb: [number, number] = [-80.61014, 28.05];
        const hull: [number, number] = [-80.61014, 28.40875];
        const runs = wakeRuns([[-80.61014, 27.70], lastCrumb, hull]);
        assert.equal(runs.length, 1, 'a lagging feed is not a missing passage');
    });

    describe('edges', () => {
        it('returns nothing for an empty wake', () => {
            assert.deepEqual(wakeRuns([]), []);
        });

        it('returns a lone crumb as its own run, which draws no line', () => {
            assert.deepEqual(wakeRuns([PORT_CANAVERAL]), [[PORT_CANAVERAL]]);
        });

        it('splits every hop when nothing is contiguous', () => {
            const far: Array<[number, number]> = [[-80, 28], [-86, 21], [-94, 29]];
            assert.equal(wakeRuns(far).length, 3);
        });

        it('measures great-circle distance, not degrees', () => {
            // Ten degrees of longitude is ~1,100 km at the equator and ~280 km at
            // 75°N. A degree-box test would call both the same and be wrong about
            // one of them; only the second is inside the threshold.
            assert.equal(wakeRuns([[0, 0], [10, 0]]).length, 2);
            assert.equal(wakeRuns([[0, 75], [10, 75]]).length, 2);
            assert.equal(wakeRuns([[0, 75], [2, 75]]).length, 1);
        });

        it('is symmetric about the threshold', () => {
            // Straddling it from either side, at the equator where a degree of
            // longitude is ~111.19 km.
            const justUnder = (JOINABLE_KM - 1) / 111.19;
            const justOver = (JOINABLE_KM + 1) / 111.19;
            assert.equal(wakeRuns([[0, 0], [justUnder, 0]]).length, 1);
            assert.equal(wakeRuns([[0, 0], [justOver, 0]]).length, 2);
        });
    });
});
