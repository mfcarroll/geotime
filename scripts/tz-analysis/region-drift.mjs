// node --import ./scripts/ts-resolve.mjs scripts/tz-analysis/region-drift.mjs <truth> W E S N step
import { readFileSync } from 'node:fs';
import { feature } from 'topojson-client';
import { point } from '@turf/helpers';
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';
import { lookupOrder } from '../../src/zone-order.ts';

const load = (p) => {
  const t = JSON.parse(readFileSync(p,'utf8'));
  const gj = feature(t, t.objects[Object.keys(t.objects)[0]]);
  return lookupOrder(gj.features).filter(f=>f.geometry).map(f => {
    let W=Infinity,E=-Infinity,S=Infinity,N=-Infinity;
    const rings = f.geometry.type==='Polygon'?f.geometry.coordinates:f.geometry.coordinates.flat();
    for (const r of rings) for (const [x,y] of r){ if(x<W)W=x; if(x>E)E=x; if(y<S)S=y; if(y>N)N=y; }
    return { f,W,E,S,N,tz:f.properties.tzid };
  });
};
const at = (feats,lat,lon) => {
  const p = point([lon,lat]);
  for (const c of feats)
    if (lon>=c.W&&lon<=c.E&&lat>=c.S&&lat<=c.N && booleanPointInPolygon(p,c.f)) return c.tz;
  return null;
};
const [truthFile, W, E, S, N, step] = process.argv.slice(2);
const truth = load(truthFile), ship = load('public/timezones.topojson');
const STEP = Number(step);
const diffs = new Map();
let total = 0, bad = 0;
const cellKm2 = (STEP*111.32) * (STEP*111.32) * Math.cos(((+S + +N)/2)*Math.PI/180);
for (let lon=+W; lon<=+E; lon+=STEP) for (let lat=+S; lat<=+N; lat+=STEP) {
  total++;
  const t = at(truth, lat, lon), s = at(ship, lat, lon);
  if (t === s) continue;
  bad++;
  const k = `${s} where the source says ${t}`;
  diffs.set(k, (diffs.get(k) ?? 0) + 1);
}
console.log(`  ${total} points at ${STEP}deg (~${(STEP*111).toFixed(1)} km) over ${W}..${E} x ${S}..${N}`);
console.log(`  ${bad} disagree with the unsimplified source (~${(bad*cellKm2).toFixed(0)} km2)`);
for (const [k,v] of [...diffs].sort((a,b)=>b[1]-a[1]))
  console.log(`    ${String(v).padStart(5)}  ~${String(Math.round(v*cellKm2)).padStart(6)} km2   ${k}`);
if (!diffs.size) console.log('    none');
