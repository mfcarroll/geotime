// src/ship-position.test.ts
//
// The rule, tested against the situations that produced it.
//
// Every fixture here is a real arrangement measured from the live feed on
// 2026-09-03 while scoping this (docs/next-version.md item 4), not an invented
// one. That matters for two of them especially: Anthem 1.4 km from ms Westerdam
// and Star 0.6 km from MSC Seascape are the cases a fleet-only view cannot see,
// and they are exactly what this rule exists to refuse.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { verdictFor, isUsableFix, type DeviceFix } from './ship-position';
import type { NearbyVessel } from './shiptrack';
import type { ShipRef } from './ships';

const NOW = Date.UTC(2026, 8, 3, 14, 0, 0);
const mins = (n: number) => (NOW - n * 60_000) / 1000;

const ROSTER: ShipRef[] = [
  { brand: 'R', code: 'ST', name: 'Star of the Seas', short: 'Star', imo: '9829942' },
  { brand: 'R', code: 'AN', name: 'Anthem of the Seas', short: 'Anthem', imo: '9656101' },
  { brand: 'R', code: 'OA', name: 'Oasis of the Seas', short: 'Oasis', imo: '9383936' },
];

function vessel(over: Partial<NearbyVessel> & { lat: number; lon: number }): NearbyVessel {
  return {
    imo: '9829942', name: 'Star of the Seas', line: 'Royal Caribbean',
    sog: 0, tst: mins(2), ...over,
  };
}

/** A sensor fix, which is the only kind this rule will look at. */
function at(lat: number, lon: number, over: Partial<DeviceFix> = {}): DeviceFix {
  return { lat, lon, accuracy: 10, sensor: true, ...over };
}

/** Roughly one km of latitude, for placing things a known distance apart. */
const KM = 1 / 111;

describe('the fix must be trustworthy before anything else happens', () => {
  test('a network fix is never used', () => {
    // A ship's wifi is Starlink: this position could be a continent away from
    // the hull. Rejecting it is the guard the whole feature rests on.
    assert.equal(isUsableFix({ lat: 25, lon: -80, accuracy: 12, sensor: false }), false);
  });

  test('a wildly imprecise sensor fix is not used either', () => {
    assert.equal(isUsableFix({ lat: 25, lon: -80, accuracy: 5000, sensor: true }), false);
  });

  test('a good sensor fix is', () => {
    assert.equal(isUsableFix(at(25, -80)), true);
  });
});

describe('aboard', () => {
  test('one ship, close, freshly seen -> aboard her', () => {
    const v = verdictFor(at(25.0, -80.0), [vessel({ lat: 25.0, lon: -80.0 })], ROSTER, NOW);
    assert.equal(v.kind, 'aboard');
    if (v.kind === 'aboard') {
      assert.equal(v.ship.code, 'ST');
      assert.ok(v.km < 0.5);
    }
  });

  test('a moored ship is trusted however old its fix is', () => {
    // The case the freshness numbers made look hopeless and is in fact the
    // safest: a vessel doing 0 knots has not moved, whatever the clock says.
    const v = verdictFor(
      at(25.0, -80.0),
      [vessel({ lat: 25.0, lon: -80.0, sog: 0, tst: mins(300) })],
      ROSTER, NOW,
    );
    assert.equal(v.kind, 'aboard');
  });
});

describe('ashore', () => {
  test('nothing floating within reach -> ashore, positively', () => {
    // Not an absence of evidence: this is a real observation, and the only
    // thing here permitted to clear the aboard state.
    const v = verdictFor(at(25.0, -80.0), [vessel({ lat: 26.0, lon: -80.0 })], ROSTER, NOW);
    assert.equal(v.kind, 'ashore');
  });

  test('an empty feed is ashore, since it is an answer', () => {
    assert.equal(verdictFor(at(25, -80), [], ROSTER, NOW).kind, 'ashore');
  });
});

describe('abstain rather than guess', () => {
  test('two hulls alongside -> unknown (Star / MSC Seascape, 0.6 km)', () => {
    const v = verdictFor(at(25.0, -80.0), [
      vessel({ lat: 25.0, lon: -80.0 }),
      vessel({ imo: '9803613', name: 'MSC Seascape', line: 'MSC Cruises',
               lat: 25.0 + 0.6 * KM, lon: -80.0 }),
    ], ROSTER, NOW);
    assert.equal(v.kind, 'unknown');
  });

  test('a rival 1.4 km off at sea -> unknown (Anthem / ms Westerdam)', () => {
    // The false positive a fleet-only view cannot see. Without the wide query
    // this returns "aboard Anthem" to somebody on the Westerdam.
    const v = verdictFor(at(25.0, -80.0), [
      vessel({ imo: '9656101', name: 'Anthem of the Seas', lat: 25.0, lon: -80.0, sog: 18, tst: mins(5) }),
      vessel({ imo: '9226891', name: 'ms Westerdam', line: 'Holland America',
               lat: 25.0 + 1.4 * KM, lon: -80.0, sog: 17, tst: mins(5) }),
    ], ROSTER, NOW);
    assert.equal(v.kind, 'unknown');
  });

  test('a stale fix never widens acceptance', () => {
    // Allure: 217 minutes at 17 knots is a 114 km circle. Being 8 km from where
    // she was three hours ago is a coincidence, not a boarding pass.
    const v = verdictFor(
      at(25.0, -80.0),
      [vessel({ lat: 25.0 + 8 * KM, lon: -80.0, sog: 17, tst: mins(217) })],
      ROSTER, NOW,
    );
    assert.equal(v.kind, 'unknown');
    if (v.kind === 'unknown') assert.match(v.why, /stale/);
  });

  test('a ship we cannot serve is not answered with one we can', () => {
    const v = verdictFor(at(25.0, -80.0), [
      vessel({ imo: '9333163', name: 'Carnival Liberty', line: 'Carnival Cruise Line',
               lat: 25.0, lon: -80.0 }),
    ], ROSTER, NOW);
    assert.equal(v.kind, 'unknown');
    if (v.kind === 'unknown') assert.match(v.why, /roster/);
  });
});

describe('the boundary itself', () => {
  test('just inside 10 km is aboard, just outside is ashore', () => {
    const near = verdictFor(at(25.0, -80.0), [vessel({ lat: 25.0 + 9.5 * KM, lon: -80.0 })], ROSTER, NOW);
    const far = verdictFor(at(25.0, -80.0), [vessel({ lat: 25.0 + 10.5 * KM, lon: -80.0 })], ROSTER, NOW);
    assert.equal(near.kind, 'aboard');
    assert.equal(far.kind, 'ashore');
  });
});
