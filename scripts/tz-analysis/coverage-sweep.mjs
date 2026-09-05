// node --import ./scripts/ts-resolve.mjs scripts/tz-analysis/coverage-sweep.mjs <file> [N]
//
// The only gap measurement that matches what the app does: ask
// booleanPointInPolygon, the same question findTimezoneFromGeoJSON asks.
// mapshaper's -erase understates (it snaps slivers away); its -mosaic n=0
// overstates (it labels tiles no polygon can be attributed to). Both have
// misreported this data by orders of magnitude in both directions.
import { readFileSync } from 'node:fs';
import { feature } from 'topojson-client';
import { point } from '@turf/helpers';
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';

const t = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const gj = feature(t, t.objects[Object.keys(t.objects)[0]]);
const feats = gj.features.filter((f) => f.geometry).map((f) => {
  let W=Infinity,E=-Infinity,S=Infinity,N=-Infinity;
  const rings = f.geometry.type==='Polygon'?f.geometry.coordinates:f.geometry.coordinates.flat();
  for (const r of rings) for (const [x,y] of r){ if(x<W)W=x; if(x>E)E=x; if(y<S)S=y; if(y>N)N=y; }
  return { f,W,E,S,N };
});
const covered = (lat, lon) => {
  const p = point([lon, lat]);
  for (const c of feats)
    if (lon>=c.W&&lon<=c.E&&lat>=c.S&&lat<=c.N && booleanPointInPolygon(p, c.f)) return true;
  return false;
};

let seed = 777333111;
const rnd = () => (seed = (seed*1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const N = Number(process.argv[3] ?? 200000);
const EARTH = 510_072_000;
let miss = 0;
const examples = [];
for (let k = 0; k < N; k++) {
  const lon = rnd()*360 - 180;
  const lat = Math.asin(rnd()*2 - 1) * 180/Math.PI;      // equal area
  if (covered(lat, lon)) continue;
  miss++;
  if (examples.length < 5) examples.push(`${lat.toFixed(3)},${lon.toFixed(3)}`);
}
const km2 = miss * (EARTH / N);
console.log(`  ${N.toLocaleString()} equal-area points: ${miss} uncovered`
  + `  =>  ${(miss/N*100).toFixed(4)}% of Earth, ~${Math.round(km2).toLocaleString()} km2`);
if (miss === 0) console.log(`     (95% upper bound with 0 hits: ~${Math.round(3 * EARTH / N).toLocaleString()} km2)`);
else console.log(`     e.g. ${examples.join(' | ')}`);
