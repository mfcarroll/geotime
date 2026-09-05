// node --import ./scripts/ts-resolve.mjs scripts/tz-analysis/region-probe.mjs <file> <topo|gj> W E S N [step]
import { readFileSync } from 'node:fs';
import { feature } from 'topojson-client';
import { point } from '@turf/helpers';
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';

const [file, kind, W, E, S, N, step] = process.argv.slice(2);
const parsed = JSON.parse(readFileSync(file,'utf8'));
const gj = kind === 'topo' ? feature(parsed, parsed.objects[Object.keys(parsed.objects)[0]]) : parsed;
const feats = gj.features.filter(f=>f.geometry);
const STEP = Number(step ?? 0.02);

const counts = new Map(); let gaps = 0, total = 0;
const gapPts = [];
for (let lon=+W; lon<=+E; lon+=STEP) for (let lat=+S; lat<=+N; lat+=STEP) {
  const p = point([+lon.toFixed(5), +lat.toFixed(5)]);
  const hits = feats.filter(f=>booleanPointInPolygon(p,f)).map(f=>f.properties.tzid);
  total++;
  const key = hits.length ? hits.slice().sort().join(' + ') : '(NOTHING — unselectable)';
  if (!hits.length) { gaps++; if (gapPts.length<6) gapPts.push(`${lat.toFixed(3)},${lon.toFixed(3)}`); }
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
console.log(`  ${file}  —  ${total} points at ${STEP}deg over ${W}..${E} x ${S}..${N}`);
for (const [k,v] of [...counts].sort((a,b)=>b[1]-a[1]))
  console.log(`    ${String(v).padStart(6)}  ${((v/total)*100).toFixed(2).padStart(6)}%   ${k}`);
if (gapPts.length) console.log(`    gap examples: ${gapPts.join(' | ')}`);
