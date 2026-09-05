import test from 'node:test';
import assert from 'node:assert/strict';
import { areaKm2, lookupOrder, DEFER_TO, type OrderableFeature } from './zone-order';

/** A rectangle in lon/lat, wound counter-clockwise. */
const box = (w: number, e: number, s: number, n: number): number[][] =>
  [[w, s], [e, s], [e, n], [w, n], [w, s]];

const zone = (tzid: string, coordinates: any, type = 'Polygon'): OrderableFeature =>
  ({ properties: { tzid }, geometry: { type, coordinates } });

test('area', async (t) => {
  await t.test('a 1x1 degree box at the equator is about 12,300 km2', () => {
    // 111.32 km per degree of longitude at the equator, 110.57 per degree of
    // latitude: the true figure is ~12,308. Anything planar-but-wrong shows up
    // here as a factor, not a rounding.
    const a = areaKm2({ type: 'Polygon', coordinates: [box(0, 1, 0, 1)] });
    assert.ok(Math.abs(a - 12308) < 100, `expected ~12308, got ${a.toFixed(0)}`);
  });

  await t.test('the same box near the pole is far smaller', () => {
    const equator = areaKm2({ type: 'Polygon', coordinates: [box(0, 1, 0, 1)] });
    const polar   = areaKm2({ type: 'Polygon', coordinates: [box(0, 1, 84, 85)] });
    // cos(84.5) ~ 0.0958, so about a tenth. A planar area would call these equal,
    // which is the whole reason this is not a planar area.
    assert.ok(polar < equator * 0.15, `polar ${polar.toFixed(0)} vs equator ${equator.toFixed(0)}`);
    assert.ok(polar > 0);
  });

  await t.test('winding does not change the answer', () => {
    const ccw = areaKm2({ type: 'Polygon', coordinates: [box(0, 1, 0, 1)] });
    const cw  = areaKm2({ type: 'Polygon', coordinates: [[...box(0, 1, 0, 1)].reverse()] });
    assert.ok(Math.abs(ccw - cw) < 1);
  });

  await t.test('a hole is subtracted', () => {
    const solid  = areaKm2({ type: 'Polygon', coordinates: [box(0, 4, 0, 4)] });
    const holed  = areaKm2({ type: 'Polygon', coordinates: [box(0, 4, 0, 4), box(1, 3, 1, 3)] });
    const hole   = areaKm2({ type: 'Polygon', coordinates: [box(1, 3, 1, 3)] });
    assert.ok(Math.abs((solid - hole) - holed) < 1, `${solid} - ${hole} != ${holed}`);
    assert.ok(holed < solid);
  });

  await t.test('a MultiPolygon adds its parts up', () => {
    const one = areaKm2({ type: 'Polygon', coordinates: [box(0, 1, 0, 1)] });
    const two = areaKm2({ type: 'MultiPolygon', coordinates: [[box(0, 1, 0, 1)], [box(10, 11, 0, 1)]] });
    assert.ok(Math.abs(two - one * 2) < 20);
  });

  await t.test('a null geometry is zero, not a throw', () => {
    assert.equal(areaKm2(null), 0);
  });
});

test('lookup order', async (t) => {
  await t.test('the contained zone is tested before the one containing it', () => {
    // The shape of the real case: a small zone wholly inside a large one, listed
    // second, which is how the file has Urumqi at 282 and Shanghai at 271.
    const big   = zone('Big',   [box(0, 40, 0, 40)]);
    const small = zone('Small', [box(10, 12, 10, 12)]);
    const order = lookupOrder([big, small]).map((f) => f.properties.tzid);
    assert.deepEqual(order, ['Small', 'Big']);
  });

  await t.test('input order is left untouched', () => {
    const big   = zone('Big',   [box(0, 40, 0, 40)]);
    const small = zone('Small', [box(10, 12, 10, 12)]);
    const input = [big, small];
    lookupOrder(input);
    assert.deepEqual(input.map((f) => f.properties.tzid), ['Big', 'Small'],
      'the caller renders the map from this array; reordering it in place would change draw order');
  });

  await t.test('a zone split across features ranks by its total size', () => {
    // Two halves of one zone, each individually smaller than the rival, but the
    // zone as a whole is larger and must not win the overlap.
    const halfA = zone('Split', [box(0, 20, 0, 20)]);
    const halfB = zone('Split', [box(20, 40, 0, 20)]);
    const rival = zone('Rival', [box(0, 25, 0, 25)]);
    const order = lookupOrder([halfA, halfB, rival]).map((f) => f.properties.tzid);
    assert.equal(order[0], 'Rival', 'Rival is smaller than both halves of Split combined');
  });

  await t.test('ties keep the order they came in', () => {
    const a = zone('A', [box(0, 1, 0, 1)]);
    const b = zone('B', [box(5, 6, 0, 1)]);
    assert.deepEqual(lookupOrder([a, b]).map((f) => f.properties.tzid), ['A', 'B']);
    assert.deepEqual(lookupOrder([b, a]).map((f) => f.properties.tzid), ['B', 'A']);
  });

  await t.test('a null geometry sorts last rather than winning everything', () => {
    const gone  = { properties: { tzid: 'Gone' }, geometry: null } as OrderableFeature;
    const small = zone('Small', [box(10, 12, 10, 12)]);
    const order = lookupOrder([gone, small]).map((f) => f.properties.tzid);
    assert.deepEqual(order, ['Small', 'Gone'],
      'a zero-area zone would otherwise sort first and match nothing, hiding real zones behind it');
  });

  await t.test('DEFER_TO puts a smaller zone behind the one it must lose to', () => {
    const big   = zone('Big',   [box(0, 40, 0, 40)]);
    const small = zone('Small', [box(10, 12, 10, 12)]);
    const other = zone('Other', [box(50, 51, 0, 1)]);

    assert.equal(lookupOrder([big, small, other])[0].properties.tzid, 'Other');

    DEFER_TO['Small'] = 'Big';
    try {
      const order = lookupOrder([big, small, other]).map((f) => f.properties.tzid);
      assert.ok(order.indexOf('Big') < order.indexOf('Small'),
        `Big must be tested before Small, got ${order.join(' ')}`);
      assert.equal(order[0], 'Other', 'unrelated zones keep their ranking');
    } finally {
      delete DEFER_TO['Small'];
    }
  });

  await t.test('every id in the shipped DEFER_TO is a real IANA zone', () => {
    // A typo here fails silently — lookupOrder ignores a target it cannot find,
    // so the rule would simply never apply and nothing would look broken.
    const valid = new Set(Intl.supportedValuesOf('timeZone'));
    for (const [from, to] of Object.entries(DEFER_TO)) {
      assert.ok(valid.has(from), `DEFER_TO key is not an IANA zone: ${from}`);
      assert.ok(valid.has(to), `DEFER_TO target is not an IANA zone: ${to}`);
      assert.notEqual(from, to, `${from} cannot defer to itself`);
    }
  });

  await t.test('DEFER_TO naming a zone that is not present is ignored', () => {
    const small = zone('Small', [box(10, 12, 10, 12)]);
    const big   = zone('Big',   [box(0, 40, 0, 40)]);
    DEFER_TO['Small'] = 'NotLoaded';
    try {
      assert.deepEqual(lookupOrder([big, small]).map((f) => f.properties.tzid), ['Small', 'Big']);
    } finally {
      delete DEFER_TO['Small'];
    }
  });
});
