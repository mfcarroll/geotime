import test from 'node:test';
import assert from 'node:assert/strict';
import { portRefsFrom, matchPortTiers, isUnlocatedZone } from './ports';
import { fold } from './utils';

const port = (name: string | null, lat: number, lon: number) =>
  ({ name, lat, lon, nameSource: 'itinerary' as const, day: null, depart: null });

const voyage = (ports: any[]) => ({ ports } as any);

test('unlocated zones', async (t) => {
  await t.test('a nautical band means the port was not located', () => {
    assert.equal(isUnlocatedZone('Etc/GMT-5'), true);
    assert.equal(isUnlocatedZone('Etc/UTC'), true);
  });
  await t.test('a named zone is a real answer', () => {
    assert.equal(isUnlocatedZone('America/Cancun'), false);
  });
  await t.test('no answer is not an answer', () => {
    assert.equal(isUnlocatedZone(null), true);
  });
});

test('collecting ports', async (t) => {
  const resolve = (lat: number) => (lat > 40 ? 'Europe/Athens' : 'America/Cancun');

  await t.test('a named, locatable port is offered', () => {
    const refs = portRefsFrom([{ ship: 'Anthem', voyage: voyage([port('Cozumel', 20.5, -86.9)]) }], resolve);
    assert.deepEqual(refs.map((r) => [r.name, r.tzid, r.ship]), [['Cozumel', 'America/Cancun', 'Anthem']]);
  });

  await t.test('a port the itinerary never named is skipped', () => {
    // The name is scraped from someone else's markup and is often simply absent.
    // A row reading "undefined" would be worse than no row.
    assert.equal(portRefsFrom([{ ship: 'A', voyage: voyage([port(null, 20, -86)]) }], resolve).length, 0);
  });

  await t.test('a port that resolves to open water is skipped', () => {
    // Tender ports mark the anchorage, which is offshore. A fixed offset matches
    // the shore in winter and is an hour out all summer.
    const refs = portRefsFrom([{ ship: 'A', voyage: voyage([port('Nowhere', 0, 0)]) }], () => 'Etc/GMT');
    assert.equal(refs.length, 0);
  });

  await t.test('a missing itinerary is not an error', () => {
    assert.deepEqual(portRefsFrom([{ ship: 'A', voyage: null }], resolve), []);
  });

  await t.test('nonsense coordinates are skipped rather than resolved', () => {
    const refs = portRefsFrom([{ ship: 'A', voyage: voyage([port('Bad', NaN, 12)]) }], resolve);
    assert.equal(refs.length, 0);
  });

  await t.test('the same port from two ships appears once, last one winning', () => {
    const refs = portRefsFrom([
      { ship: 'Anthem', voyage: voyage([port('Cozumel', 20.5, -86.9)]) },
      { ship: 'Odyssey', voyage: voyage([port('Cozumel', 20.5, -86.9)]) },
    ], resolve);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].ship, 'Odyssey');
  });

  await t.test('names differing only in case are the same port', () => {
    const refs = portRefsFrom([
      { ship: 'A', voyage: voyage([port('COZUMEL', 20.5, -86.9), port('Cozumel', 20.5, -86.9)]) },
    ], resolve);
    assert.equal(refs.length, 1);
  });
});

test('matching a query', async (t) => {
  const ports = portRefsFrom([{ ship: 'Anthem', voyage: voyage([
    port('Cozumel', 20.5, -86.9), port('Costa Maya', 18.7, -87.7), port('Athens', 41, 23),
  ]) }], (lat: number) => (lat > 40 ? 'Europe/Athens' : 'America/Cancun'));

  await t.test('an exact name leads', () => {
    assert.deepEqual(matchPortTiers('Cozumel', ports, fold)[0].map((p) => p.name), ['Cozumel']);
  });
  await t.test('a prefix is the second tier', () => {
    assert.deepEqual(matchPortTiers('cos', ports, fold)[1].map((p) => p.name), ['Costa Maya']);
  });
  await t.test('an inner substring is the third', () => {
    assert.deepEqual(matchPortTiers('zume', ports, fold)[2].map((p) => p.name), ['Cozumel']);
  });
  await t.test('an empty query matches nothing at all', () => {
    assert.deepEqual(matchPortTiers('   ', ports, fold), [[], [], []]);
  });
  await t.test('accents and case are ignored, as everywhere else in search', () => {
    assert.equal(matchPortTiers('ATHENS', ports, fold)[0].length, 1);
  });
});
