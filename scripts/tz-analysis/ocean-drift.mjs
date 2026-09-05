// node --import ./scripts/ts-resolve.mjs scripts/tz-analysis/ocean-drift.mjs <truth.topojson>
//
// Where does the SHIPPED, simplified data hand a point to a different zone than
// the unsimplified source does? Ocean included — the stray triangles at a zone
// intersection sit in water, so a land-only sweep cannot see them.
import { readFileSync } from 'node:fs';
import { feature } from 'topojson-client';
import { point } from '@turf/helpers';
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';
import { lookupOrder } from '../../src/zone-order.ts';

const load = (p, ordered) => {
  const t = JSON.parse(readFileSync(p,'utf8'));
  const gj = feature(t, t.objects[Object.keys(t.objects)[0]]);
  const feats = ordered ? lookupOrder(gj.features) : gj.features;
  return feats.filter(f=>f.geometry).map(f => {
    let W=Infinity,E=-Infinity,S=Infinity,N=-Infinity;
    const rings = f.geometry.type==='Polygon'?f.geometry.coordinates:f.geometry.coordinates.flat();
    for (const r of rings) for (const [x,y] of r){ if(x<W)W=x; if(x>E)E=x; if(y<S)S=y; if(y>N)N=y; }
    return { f,W,E,S,N,tz:f.properties.tzid };
  });
};
const resolve = (feats,lat,lon) => {
  const p = point([lon,lat]);
  for (const c of feats)
    if (lon>=c.W&&lon<=c.E&&lat>=c.S&&lat<=c.N && booleanPointInPolygon(p,c.f)) return c.tz;
  return null;
};

const truth = load(process.argv[2], true);
const ship  = load('public/timezones.topojson', true);

let seed = 20260904;
const rnd = () => (seed = (seed*1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const N = 150000;
const EARTH = 510_072_000;                       // km2, whole sphere
const diffs = new Map();
let disagree = 0;
for (let k=0;k<N;k++) {
  const lon = rnd()*360 - 180;
  const lat = Math.asin(rnd()*2 - 1) * 180/Math.PI;   // equal-area
  const t = resolve(truth, lat, lon), s = resolve(ship, lat, lon);
  if (t === s) continue;
  disagree++;
  const key = `${s} where the source says ${t}`;
  diffs.set(key, (diffs.get(key) ?? 0) + 1);
}
const perPoint = EARTH / N;
console.log(`  ${N} points over the whole globe, ocean included`);
console.log(`  ${disagree} disagree with the unsimplified source `
  + `(${((disagree/N)*100).toFixed(4)}% of Earth, ~${Math.round(disagree*perPoint).toLocaleString()} km2)\n`);
for (const [k,v] of [...diffs].sort((a,b)=>b[1]-a[1]).slice(0,15))
  console.log(`    ${String(v).padStart(4)} pts  ~${String(Math.round(v*perPoint)).padStart(7)} km2   ${k}`);
if (diffs.size > 15) console.log(`    ...and ${diffs.size-15} more combinations`);
