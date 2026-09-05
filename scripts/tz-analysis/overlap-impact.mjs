// node --import ./scripts/ts-resolve.mjs scripts/tz-analysis/overlap-impact.mjs <overlaps.geojson>
import { readFileSync } from 'node:fs';
import { areaKm2, DEFER_TO } from '../../src/zone-order.ts';

const gj = JSON.parse(readFileSync(process.argv[2],'utf8'));

// Zone sizes from the shipped boundaries, so "which does the rule pick" is
// answered from the same numbers lookupOrder ranks by.
import { feature } from 'topojson-client';
const topo = JSON.parse(readFileSync('public/timezones.topojson','utf8'));
const all = feature(topo, topo.objects[Object.keys(topo.objects)[0]]);
const areas = {};
for (const f of all.features) {
  const tz = f.properties?.tzid; if (!tz) continue;
  areas[tz] = (areas[tz] ?? 0) + areaKm2(f.geometry);
}

const offAt = (tz, iso) => {
  try {
    const m = new Intl.DateTimeFormat('en-US',{timeZone:tz,timeZoneName:'longOffset'})
      .format(new Date(iso)).match(/GMT([+-])(\d{2}):(\d{2})/);
    return m ? (m[1]==='-'?-1:1)*(+m[2] + +m[3]/60) : 0;
  } catch { return null; }
};
const fmt = (h) => (h===null?'??':(h<0?'-':'+') + String(Math.abs(h)).replace(/\.5$/,':30').replace(/\.75$/,':45').replace(/\.25$/,':15'));

const groups = new Map();
for (const f of gj.features) {
  if (!f.geometry) continue;
  const zones = [...new Set(String(f.properties.zoneList ?? '').split(' + ').filter(Boolean))];
  if (zones.length < 2) continue;                       // self-overlap, not an ambiguity
  const key = zones.slice().sort().join(' + ');
  const g = groups.get(key) ?? { km2:0, tiles:0, zones };
  g.km2 += areaKm2(f.geometry); g.tiles++;
  groups.set(key, g);
}

const rows = [];
for (const [key,v] of groups) {
  const [a,b] = v.zones;
  // Two sample dates would miss a pair that only parts company around a DST
  // transition — Asia/Hebron and Asia/Jerusalem change on different days. Step
  // through a whole year instead, and record how much of it they disagree for.
  let apart = 0, steps = 0, maxGap = 0;
  for (let d = 0; d < 365; d += 1) {
    const iso = new Date(Date.UTC(2026,0,1) + d*86400000).toISOString();
    const oa = offAt(a, iso), ob = offAt(b, iso);
    steps++;
    if (oa !== ob) { apart++; maxGap = Math.max(maxGap, Math.abs(oa - ob)); }
  }
  const winter = [offAt(a,'2026-01-15T12:00:00Z'), offAt(b,'2026-01-15T12:00:00Z')];
  const summer = [offAt(a,'2026-07-15T12:00:00Z'), offAt(b,'2026-07-15T12:00:00Z')];
  const differs = apart > 0;
  rows.push({ key, ...v, a, b, winter, summer, differs, apart, steps, maxGap });
}
rows.sort((x,y) => (y.differs - x.differs) || (y.km2 - x.km2));

const matter = rows.filter(r => r.differs);
const benign = rows.filter(r => !r.differs);
console.log(`  ${rows.length} distinct overlapping pairs\n`);
console.log(`  ${matter.length} where the two zones show a DIFFERENT clock:\n`);
console.log('        km2   days apart   max gap   picks             over');
for (const r of matter) {
  if (r.km2 < 1) continue;                       // sub-km2 coastal slivers, listed separately
  const covered = DEFER_TO[r.a] === r.b || DEFER_TO[r.b] === r.a;
  const picked = areas[r.a] === undefined || areas[r.b] === undefined ? '?'
    : (DEFER_TO[r.a] === r.b ? r.b : DEFER_TO[r.b] === r.a ? r.a
       : (areas[r.a] < areas[r.b] ? r.a : r.b));
  const other = picked === r.a ? r.b : r.a;
  console.log(`  ${Math.round(r.km2).toLocaleString().padStart(9)}   `
    + `${String(r.apart).padStart(3)}/365`.padEnd(13)
    + `${r.maxGap}h`.padEnd(10)
    + `${picked.padEnd(18)}${other}${covered ? '   [DEFER_TO]' : ''}`);
}
const tiny = matter.filter(r=>r.km2<1);
console.log(`  ...plus ${tiny.length} pairs under 1 km2 (land meeting an ocean band at the coast)`);
const benignArea = benign.reduce((a,r)=>a+r.km2,0);
console.log(`\n  ${benign.length} where both zones show the SAME clock (${Math.round(benignArea).toLocaleString()} km2 total) — order cannot matter:`);
console.log('    ' + benign.filter(r=>r.km2>=1).map(r=>`${r.key} (${Math.round(r.km2)} km2)`).join('\n    '));
console.log(`    ...plus ${benign.filter(r=>r.km2<1).length} pairs under 1 km2, all land-meets-ocean slivers`);
