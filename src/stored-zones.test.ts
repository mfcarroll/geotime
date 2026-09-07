import test from 'node:test';
import assert from 'node:assert/strict';

import { migrateStoredTimezones, zoneKey } from './stored-zones';

test('the stored clock list survives a round trip', async (t) => {
  await t.test('a bare id from an old build still loads', () => {
    assert.deepEqual(migrateStoredTimezones(['Europe/Athens']), [{ tz: 'Europe/Athens' }]);
  });

  await t.test('a chosen name is kept', () => {
    const nelson = { tz: 'America/Vancouver', label: 'Nelson', at: { lat: 49.5, lon: -117.29 } };
    assert.deepEqual(migrateStoredTimezones([nelson]), [nelson]);
  });

  await t.test('a port keeps being a port', () => {
    // The anchor is drawn from this. It used to be dropped here, so it appeared
    // when the port was added and was gone the next time the app opened.
    const cocoCay = {
      tz: 'America/Nassau', label: 'Coco Cay', kind: 'port',
      at: { lat: 25.8169, lon: -77.93411 },
    };
    assert.deepEqual(migrateStoredTimezones([cocoCay]), [cocoCay]);
  });

  await t.test('an unknown kind is not carried through', () => {
    // Rebuilt field by field on purpose: a corrupt or hostile store should not
    // be able to put arbitrary values into the widget payload.
    assert.deepEqual(migrateStoredTimezones([{ tz: 'Europe/Athens', kind: 'nonsense' }]),
      [{ tz: 'Europe/Athens' }]);
  });

  await t.test('a fractional Etc id from before the rebuild is repaired', () => {
    assert.deepEqual(migrateStoredTimezones([{ tz: 'Etc/GMT+5.5' }]), [{ tz: 'Etc/GMT+5' }]);
  });

  await t.test('an id Intl rejects is dropped rather than poisoning the list', () => {
    assert.deepEqual(migrateStoredTimezones([{ tz: 'Not/AZone' }, { tz: 'Europe/Athens' }]),
      [{ tz: 'Europe/Athens' }]);
  });

  await t.test('the same PLACE twice collapses, first one winning', () => {
    assert.deepEqual(
      migrateStoredTimezones([
        { tz: 'Europe/Athens', label: 'A', at: { lat: 37.98, lon: 23.73 } },
        { tz: 'Europe/Athens', label: 'A', at: { lat: 37.98, lon: 23.73 } },
      ]),
      [{ tz: 'Europe/Athens', label: 'A', at: { lat: 37.98, lon: 23.73 } }]);
  });

  await t.test('two places in one zone are two rows', () => {
    // The whole point. Tampa is a city in the New York timezone; it is not a
    // name for the New York timezone, and saying so used to overwrite it.
    assert.deepEqual(
      migrateStoredTimezones([
        { tz: 'America/New_York', label: 'Tampa', at: { lat: 27.95, lon: -82.46 } },
        { tz: 'America/New_York' },
      ]),
      [
        { tz: 'America/New_York', label: 'Tampa', at: { lat: 27.95, lon: -82.46 } },
        { tz: 'America/New_York' },
      ]);
  });

  await t.test('a bare zone twice is still one row', () => {
    assert.deepEqual(
      migrateStoredTimezones(['Europe/Athens', 'Europe/Athens']), [{ tz: 'Europe/Athens' }]);
  });

  await t.test('a name with nowhere to be becomes the zone it stood in', () => {
    // Builds before 1.7.0 had nowhere to record a berth, so a port was saved as
    // a NAME alone: a row that read "Coco Cay" and behaved like the whole of
    // America/Nassau, because a place with no point can only be answered with a
    // region. The name goes, so the row reads as what it actually selects.
    assert.deepEqual(
      migrateStoredTimezones([{ tz: 'America/Nassau', label: 'Coco Cay', kind: 'port' }]),
      [{ tz: 'America/Nassau' }]);
  });

  await t.test('a demoted row keeps no anchor', () => {
    // An anchor says "a ship calls here", which is a claim about a place. A row
    // that is now a timezone cannot make it.
    const [row] = migrateStoredTimezones([{ tz: 'America/Nassau', label: 'X', kind: 'port' }]);
    assert.equal(row.kind, undefined);
    assert.equal(row.label, undefined);
  });

  await t.test('a position too broken to read demotes the row as well', () => {
    assert.deepEqual(
      migrateStoredTimezones([{ tz: 'Europe/Athens', label: 'Athens', at: { lat: 'x', lon: 23.7 } }]),
      [{ tz: 'Europe/Athens' }]);
  });

  await t.test('demoting collapses into the plain zone row it duplicates', () => {
    assert.deepEqual(
      migrateStoredTimezones([
        { tz: 'America/Nassau', label: 'Coco Cay', kind: 'port' },
        { tz: 'America/Nassau' },
      ]),
      [{ tz: 'America/Nassau' }]);
  });

  await t.test('junk is not an error', () => {
    assert.deepEqual(migrateStoredTimezones(null), []);
    assert.deepEqual(migrateStoredTimezones([null, 42, '']), []);
  });
});

test('a saved place is identified by the place', async (t) => {
  await t.test('a bare zone is keyed by its id alone', () => {
    assert.equal(zoneKey({ tz: 'America/New_York' }), 'America/New_York');
  });

  await t.test('a place inside a zone carries its name', () => {
    assert.equal(zoneKey({ tz: 'America/New_York', label: 'Tampa' }), 'America/New_York|tampa');
  });

  await t.test('the same name typed differently is the same place', () => {
    assert.equal(
      zoneKey({ tz: 'Atlantic/Reykjavik', label: 'Reykjavík' }),
      zoneKey({ tz: 'Atlantic/Reykjavik', label: 'REYKJAVIK' }));
  });

  await t.test('a port and a city of one name in one zone are one row', () => {
    // Not a case anybody has, and keying on coordinates instead would make a
    // row's identity move if upstream nudged a berth by a metre.
    assert.equal(
      zoneKey({ tz: 'America/Nassau', label: 'Nassau', kind: 'port' }),
      zoneKey({ tz: 'America/Nassau', label: 'Nassau' }));
  });
});
