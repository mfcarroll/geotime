#!/usr/bin/env node
// Builds the two inspection layers the debug overlay draws:
//
//   public/debug-overlaps.geojson   every patch claimed by more than one zone
//   public/debug-gaps.geojson       every patch claimed by none
//
// Both are derived from whatever public/timezones.topojson currently holds, and
// both are gitignored — they are for looking at, not for shipping.
//
// Each overlap patch is annotated with the zone the app actually returns there,
// and how that was decided, so the map answers "what does GeoTime do here"
// rather than only "the data disagrees here".
//
//   node --import ./scripts/ts-resolve.mjs scripts/tz-analysis/build-debug-layers.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { feature } from 'topojson-client';
import { lookupOrder } from '../../src/zone-order.ts';

const SRC = 'public/timezones.topojson';
const { DEFER_TO } = await import('../../src/zone-order.ts');
const DEFER_TO_KEYS = new Set(Object.keys(DEFER_TO));
const work = mkdtempSync(join(tmpdir(), 'tzdebug-'));
const run = (args) => execFileSync('npx', ['-y', 'mapshaper@0.6', ...args], { stdio: 'inherit' });

try {
  console.log('→ overlaps (mosaic of everything claimed twice)');
  run([SRC, '-mosaic', 'calc=n = count(), zones = collect(tzid)',
       '-filter', 'n > 1',
       '-each', 'zoneList = zones.join(" + "), zones = null',
       '-o', join(work, 'ov.json'), 'format=geojson']);

  // Gaps come from the mosaic's n=0 tiles, NOT from erasing the zones out of a
  // world rectangle. The erase route reports zero while real holes exist: that
  // operation snaps slivers away as it runs, so it cannot see the very thing it
  // is being asked about. It hid a hole in the Belgium/Germany border for an
  // entire round of "0 gaps" claims.
  console.log('→ gaps (mosaic tiles that no zone covers)');
  run([SRC,
       '-mosaic', 'calc=n = count(), zones = collect(tzid)',
       '-filter', 'n === 0',
       '-explode',
       '-o', join(work, 'gap.json'), 'format=geojson']);

  // mapshaper writes a bare GeometryCollection when a layer carries no fields.
  const asFC = (raw, props = () => ({})) => {
    const g = JSON.parse(raw);
    if (g.type !== 'GeometryCollection') return g;
    return { type: 'FeatureCollection',
             features: g.geometries.map((geometry, i) => ({ type: 'Feature', geometry, properties: props(i) })) };
  };

  // The app's own scan order, so "winner" here is what findTimezoneFromGeoJSON
  // returns rather than a second guess at it.
  const topo = JSON.parse(readFileSync(SRC, 'utf8'));
  const all = feature(topo, topo.objects[Object.keys(topo.objects)[0]]);
  const position = new Map(lookupOrder(all.features).map((f, i) => [f.properties.tzid, i]));

  const ov = asFC(readFileSync(join(work, 'ov.json'), 'utf8'));
  for (const f of ov.features) {
    const zones = String(f.properties?.zoneList ?? '').split(' + ').filter(Boolean);
    const ranked = zones.slice().sort((a, b) => (position.get(a) ?? Infinity) - (position.get(b) ?? Infinity));
    f.properties.winner = ranked[0] ?? null;
    f.properties.loses = ranked.slice(1).join(', ');
    f.properties.decided = DEFER_TO_KEYS.has(ranked[0]) || zones.some((z) => DEFER_TO_KEYS.has(z))
      ? 'override' : 'rule';
  }
  const gap = asFC(readFileSync(join(work, 'gap.json'), 'utf8'), (i) => ({ patch: i }));
  writeFileSync('public/debug-overlaps.geojson', JSON.stringify(ov));
  writeFileSync('public/debug-gaps.geojson', JSON.stringify(gap));
  const byWinner = new Map();
  for (const f of ov.features) {
    const k = `${f.properties.winner}  beats  ${f.properties.loses}`;
    byWinner.set(k, (byWinner.get(k) ?? 0) + 1);
  }
  console.log(`✓ ${ov.features.length} overlap patches, ${gap.features.length} gap patches`);
  console.log('  who wins each overlap:');
  for (const [k, n] of [...byWinner].sort((a, b) => b[1] - a[1]).slice(0, 12))
    console.log(`    ${String(n).padStart(4)}  ${k}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
