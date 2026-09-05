// node --import ./scripts/ts-resolve.mjs scripts/tz-analysis/exact-overlaps.mjs <overlaps.geojson>
// Input is mapshaper's -mosaic output filtered to tiles claimed by >1 zone.
import { readFileSync } from 'node:fs';
import { areaKm2 } from '../../src/zone-order.ts';

const gj = JSON.parse(readFileSync(process.argv[2],'utf8'));
const groups = new Map();
for (const f of gj.features) {
  if (!f.geometry) continue;
  const key = f.properties.zoneList ?? String(f.properties.zones);
  const g = groups.get(key) ?? { km2: 0, tiles: 0 };
  g.km2 += areaKm2(f.geometry); g.tiles++;
  groups.set(key, g);
}
const rows = [...groups].sort((a,b)=>b[1].km2 - a[1].km2);
const total = rows.reduce((a,[,v])=>a+v.km2, 0);
console.log(`  ${gj.features.length} overlapping tiles, ${rows.length} distinct zone pairings, ${Math.round(total).toLocaleString()} km2 total\n`);
console.log('        km2   tiles   zones');
for (const [k,v] of rows)
  console.log(`  ${Math.round(v.km2).toLocaleString().padStart(9)}  ${String(v.tiles).padStart(5)}   ${k}`);
