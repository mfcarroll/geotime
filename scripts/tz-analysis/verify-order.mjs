// Run with:  node --import ./scripts/ts-resolve.mjs scripts/tz-analysis/verify-order.mjs
import { readFileSync } from 'node:fs';
import { feature } from 'topojson-client';
import { point } from '@turf/helpers';
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';
import { lookupOrder } from '../../src/zone-order.ts';

const t = JSON.parse(readFileSync('public/timezones.topojson','utf8'));
const gj = feature(t, t.objects[Object.keys(t.objects)[0]]);

const fileOrder = gj.features;                 // what the lookup used to scan
const t0 = performance.now();
const newOrder = lookupOrder(fileOrder);       // what it scans now
const orderMs = performance.now() - t0;
console.log(`  ordering 444 features took ${orderMs.toFixed(1)} ms (once per load)\n`);

const scan = (feats, lat, lon) => {
  const p = point([lon, lat]);
  for (const f of feats)
    if (f.geometry && booleanPointInPolygon(p, f.geometry)) return f.properties.tzid;
  return null;
};

// ---------- 1. does anything change that should not? ----------
//
// Scan order can only change an answer where MORE THAN ONE feature contains the
// point; everywhere else the same single feature is found whatever the order, so
// brute-forcing both scans over the globe is 40 minutes spent confirming that.
// Instead: find the multi-hit points with a bbox prefilter (fast, and order
// independent because it collects all matches), then ask what each ordering
// would have returned for them.
const boxed = gj.features.filter(f=>f.geometry).map(f => {
  let W=Infinity,E=-Infinity,S=Infinity,N=-Infinity;
  const rings = f.geometry.type==='Polygon'?f.geometry.coordinates:f.geometry.coordinates.flat();
  for (const r of rings) for (const [x,y] of r){ if(x<W)W=x; if(x>E)E=x; if(y<S)S=y; if(y>N)N=y; }
  return { f, W,E,S,N };
});
const rankIn = (feats) => new Map(feats.map((f,i)=>[f.properties.tzid, i]));
const rankOld = rankIn(fileOrder), rankNew = rankIn(newOrder);
const winner = (hits, rank) => hits.slice().sort((a,b)=>rank.get(a)-rank.get(b))[0];

let seed = 555444333;
const rnd = () => (seed = (seed*1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const N = 400000;
const changes = new Map(), same = new Map();
let multi = 0;
for (let k=0;k<N;k++) {
  const lon = rnd()*360 - 180;
  const lat = Math.asin(rnd()*2 - 1) * 180/Math.PI;
  const p = point([lon,lat]);
  const hits = [];
  for (const c of boxed)
    if (lon>=c.W&&lon<=c.E&&lat>=c.S&&lat<=c.N && booleanPointInPolygon(p,c.f)) hits.push(c.f.properties.tzid);
  if (hits.length < 2) continue;
  multi++;
  const before = winner(hits, rankOld), after = winner(hits, rankNew);
  const key = `${hits.slice().sort().join(' + ')}:  ${before} -> ${after}`;
  (before === after ? same : changes).set(key, ((before===after?same:changes).get(key) ?? 0) + 1);
}
console.log(`  ${N} random points; ${multi} fell inside more than one zone`);
console.log(`  everywhere else exactly one zone matched, so order cannot have changed the answer\n`);
console.log(`  answers CHANGED (${[...changes.values()].reduce((a,b)=>a+b,0)} points):`);
for (const [k,v] of [...changes].sort((a,b)=>b[1]-a[1])) console.log(`    ${String(v).padStart(5)}  ${k}`);
if (!changes.size) console.log('    none');
console.log(`  answers UNCHANGED at an overlap:`);
for (const [k,v] of [...same].sort((a,b)=>b[1]-a[1])) console.log(`    ${String(v).padStart(5)}  ${k}`);
if (!same.size) console.log('    none');

// ---------- 2. the three known overlaps, by name ----------
console.log('\n  the three overlapping places, resolved:');
const CASES = [
  ['Urumqi, Xinjiang',      43.8256,  87.6168],
  ['Kashgar, Xinjiang',     39.4704,  75.9898],
  ['Sukhumi, Abkhazia',     43.0033,  40.9892],
  ['Tskhinvali, S. Ossetia',42.2270,  43.9694],
  ['Thimphu, Bhutan',       27.4728,  89.6390],
  ['Doklam plateau',        27.2700,  88.9200],
];
for (const [name,la,lo] of CASES)
  console.log(`    ${name.padEnd(24)} ${String(scan(fileOrder,la,lo)).padEnd(16)} ->  ${scan(newOrder,la,lo)}`);

// ---------- 3. control points that must not move ----------
console.log('\n  control points (must be unchanged):');
const CONTROL = [
  ['Vancouver',49.2827,-123.1207], ['London',51.5074,-0.1278], ['Santorini',36.3932,25.4615],
  ['Vatican',41.9029,12.4534], ['Beijing',39.9042,116.4074], ['Tbilisi city',41.7151,44.8271],
  ['Moscow',55.7558,37.6173], ['mid-Atlantic',25,-40], ['Sydney',-33.8688,151.2093],
];
let bad = 0;
for (const [name,la,lo] of CONTROL) {
  const b = scan(fileOrder,la,lo), a = scan(newOrder,la,lo);
  if (b !== a) { bad++; console.log(`    CHANGED  ${name}: ${b} -> ${a}`); }
}
console.log(`    ${CONTROL.length - bad}/${CONTROL.length} unchanged`);

// ---------- 4. speed ----------
const timeIt = (feats) => {
  const pts = CONTROL.map(([,la,lo])=>[la,lo]);
  for (const [la,lo] of pts) scan(feats,la,lo);           // warm
  const s = performance.now();
  for (let r=0;r<20;r++) for (const [la,lo] of pts) scan(feats,la,lo);
  return (performance.now()-s) / (20*pts.length);
};
console.log(`\n  lookup: file order ${timeIt(fileOrder).toFixed(2)} ms  ->  smallest-first ${timeIt(newOrder).toFixed(2)} ms`);
