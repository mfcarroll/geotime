import { readFileSync } from 'node:fs';
import { feature } from 'topojson-client';
import { point } from '@turf/helpers';
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';
import { lookupOrder } from '../../src/zone-order.ts';

// ---- ground truth: every city in the shipped index, with its recorded zone ----
const raw = JSON.parse(readFileSync('public/cities.json','utf8'));
const names = raw.n.split('\n');
const regionOf = raw.ri.split(',').map(Number);
const zoneOf = raw.zi.split(',').map(Number);
const regionAt = raw.ra.split(',').map(n => Number(n)/100);
const dLat = raw.la.split(','), dLon = raw.lo.split(',');
const cities = names.map((name,i) => ({
  name,
  lat: regionAt[regionOf[i]*2]     + Number(dLat[i])/100,
  lon: regionAt[regionOf[i]*2 + 1] + Number(dLon[i])/100,
  tz:  raw.z[zoneOf[i]],
}));

// ---- the boundary data under test ----
const path = process.argv[2], isTopo = process.argv[3] === 'topo';
const parsed = JSON.parse(readFileSync(path,'utf8'));
const gj = isTopo ? feature(parsed, parsed.objects[Object.keys(parsed.objects)[0]]) : parsed;

// --ordered applies the app's real scan order (zone-order.ts) before the sweep;
// without it, features are taken in file order, which is what shipped before.
const ORDERED = process.argv.includes('--ordered');
const source = ORDERED ? lookupOrder(gj.features) : gj.features;
// bbox prefilter — the app itself scans linearly, this is only to make the sweep tractable
const feats = source.filter(f => f.geometry).map(f => {
  let W=Infinity,E=-Infinity,S=Infinity,N=-Infinity;
  const rings = f.geometry.type==='Polygon' ? f.geometry.coordinates : f.geometry.coordinates.flat();
  for (const r of rings) for (const [x,y] of r) { if(x<W)W=x; if(x>E)E=x; if(y<S)S=y; if(y>N)N=y; }
  return { f, W,E,S,N, tz: f.properties.tzid };
});
const resolve = (lat,lon) => {
  const p = point([lon,lat]);
  for (const c of feats)
    if (lon>=c.W&&lon<=c.E&&lat>=c.S&&lat<=c.N && booleanPointInPolygon(p,c.f)) return c.tz;
  return null;
};

// A mismatch only matters if it puts the clock on a different time.
const offCache = new Map();
const offsetOf = (tz) => {
  if (offCache.has(tz)) return offCache.get(tz);
  let v = null;
  try {
    const d = new Date('2026-07-01T12:00:00Z');
    const s = new Intl.DateTimeFormat('en-US',{timeZone:tz,timeZoneName:'longOffset'}).format(d);
    const m = s.match(/GMT([+-])(\d{2}):(\d{2})/);
    v = m ? (m[1]==='-'?-1:1)*(+m[2]+ +m[3]/60) : 0;
  } catch { v = null; }
  offCache.set(tz, v); return v;
};

let ok=0, wrong=0, none=0, oceanClaim=0, sameClock=0, wrongClock=0;
const ex=[];
for (const c of cities) {
  const got = resolve(c.lat, c.lon);
  if (got === c.tz) ok++;
  else if (got === null) none++;
  else {
    wrong++;
    if (/^Etc\//.test(got)) oceanClaim++;
    const a = offsetOf(got), b = offsetOf(c.tz);
    if (a !== null && b !== null && a === b) sameClock++;
    else { wrongClock++; if (ex.length < 5) ex.push(`${c.name} → ${got} (should be ${c.tz})`); }
  }
}
const tot = cities.length;
console.log(`  ${tot} cities   exact zone ${((ok/tot)*100).toFixed(3)}%   mismatched ${wrong}   unresolved ${none}   ocean-claimed ${oceanClaim}`);
console.log(`    of the mismatches: ${sameClock} show the SAME time, ${wrongClock} show the WRONG time`
  + `   =>  wrong-clock rate ${((wrongClock/tot)*100).toFixed(4)}%`);
if (ex.length) console.log(`    wrong-clock e.g. ${ex.join(' | ')}`);
