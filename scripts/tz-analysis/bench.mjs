import { readFileSync } from 'node:fs';
import { feature } from 'topojson-client';
import { point } from '@turf/helpers';
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';

const path = process.argv[2], isTopo = process.argv[3] === 'topo';
const txt = readFileSync(path, 'utf8');
const base = process.memoryUsage().heapUsed;

let t = performance.now();
const parsed = JSON.parse(txt);
const parseMs = performance.now() - t;

let decodeMs = 0, gj = parsed;
if (isTopo) {
  t = performance.now();
  gj = feature(parsed, parsed.objects[Object.keys(parsed.objects)[0]]);
  decodeMs = performance.now() - t;
}
const heapMB = (process.memoryUsage().heapUsed - base) / 1048576;

// Exactly what findTimezoneFromGeoJSON does: linear scan, first hit wins.
const lookup = (lat, lon) => {
  const p = point([lon, lat]);
  for (const f of gj.features)
    if (f.geometry && booleanPointInPolygon(p, f.geometry)) return f.properties.tzid;
  return null;
};
const PTS = [
  ['London', 51.5074, -0.1278], ['Sydney', -33.8688, 151.2093],
  ['Santorini', 36.3932, 25.4615], ['Vancouver', 49.2827, -123.1207],
  ['mid-Atlantic', 25.0, -40.0], ['Singapore', 1.3521, 103.8198],
  ['Ushuaia', -54.8019, -68.3030], ['Reykjavik', 64.1466, -21.9426],
];
lookup(0, 0);                                     // warm
const times = [];
for (const [, la, lo] of PTS) { t = performance.now(); lookup(la, lo); times.push(performance.now() - t); }
const avg = times.reduce((a,b)=>a+b,0) / times.length;

console.log(`  parse ${parseMs.toFixed(0).padStart(5)} ms  decode ${decodeMs.toFixed(0).padStart(5)} ms`
  + `  heap ${heapMB.toFixed(0).padStart(4)} MB  |  lookup avg ${avg.toFixed(0).padStart(4)} ms, worst ${Math.max(...times).toFixed(0).padStart(4)} ms`);
console.log(`     ${PTS.map(([n],i)=>`${n} ${times[i].toFixed(0)}ms`).join('  ')}`);
