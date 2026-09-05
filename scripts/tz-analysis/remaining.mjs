// node --import ./scripts/ts-resolve.mjs scripts/tz-analysis/remaining.mjs
import { readFileSync } from 'node:fs';
import { feature } from 'topojson-client';
import { point } from '@turf/helpers';
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';
import { lookupOrder } from '../../src/zone-order.ts';

const raw = JSON.parse(readFileSync('public/cities.json','utf8'));
const names = raw.n.split('\n');
const regionOf = raw.ri.split(',').map(Number), zoneOf = raw.zi.split(',').map(Number);
const regionAt = raw.ra.split(',').map(n=>Number(n)/100);
const dLat = raw.la.split(','), dLon = raw.lo.split(',');

const t = JSON.parse(readFileSync('public/timezones.topojson','utf8'));
const gj = feature(t, t.objects[Object.keys(t.objects)[0]]);
const feats = lookupOrder(gj.features).filter(f=>f.geometry).map(f => {
  let W=Infinity,E=-Infinity,S=Infinity,N=-Infinity;
  const rings = f.geometry.type==='Polygon'?f.geometry.coordinates:f.geometry.coordinates.flat();
  for (const r of rings) for (const [x,y] of r){ if(x<W)W=x; if(x>E)E=x; if(y<S)S=y; if(y>N)N=y; }
  return { f,W,E,S,N,tz:f.properties.tzid };
});
const resolve=(lat,lon)=>{const p=point([lon,lat]);
  for(const c of feats) if(lon>=c.W&&lon<=c.E&&lat>=c.S&&lat<=c.N&&booleanPointInPolygon(p,c.f)) return c.tz; return null;};
const offCache=new Map();
const off=tz=>{if(offCache.has(tz))return offCache.get(tz);let v=null;
  try{const m=new Intl.DateTimeFormat('en-US',{timeZone:tz,timeZoneName:'longOffset'})
    .format(new Date('2026-07-01T12:00:00Z')).match(/GMT([+-])(\d{2}):(\d{2})/);
    v=m?(m[1]==='-'?-1:1)*(+m[2]+ +m[3]/60):0;}catch{} offCache.set(tz,v);return v;};

const groups = new Map();
for (let i=0;i<names.length;i++) {
  const lat = regionAt[regionOf[i]*2] + Number(dLat[i])/100;
  const lon = regionAt[regionOf[i]*2+1] + Number(dLon[i])/100;
  const want = raw.z[zoneOf[i]], got = resolve(lat,lon);
  if (got === want) continue;
  if (off(got) === off(want)) continue;                 // same clock, not a problem
  const key = `${got} (UTC${off(got)>=0?'+':''}${off(got)})  where the index says ${want} (UTC${off(want)>=0?'+':''}${off(want)})`;
  const g = groups.get(key) ?? [];
  g.push(names[i]); groups.set(key, g);
}
const total = [...groups.values()].reduce((a,b)=>a+b.length,0);
console.log(`  ${total} cities on a different clock than the index expects\n`);
for (const [k,v] of [...groups].sort((a,b)=>b[1].length-a[1].length))
  console.log(`  ${String(v.length).padStart(3)}  ${k}\n       ${v.slice(0,6).join(', ')}${v.length>6?', ...':''}`);
