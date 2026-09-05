// node --import ./scripts/ts-resolve.mjs scripts/tz-analysis/mosaic-audit.mjs <mosaic.geojson>
//
// mapshaper's -mosaic partitions the union of the zones into tiles and records
// how many zones covered each: n=0 is a hole, n>1 is an overlap. This is the
// instrument to trust — the -erase-based gap check silently snaps slivers away.
import { readFileSync } from 'node:fs';
import { areaKm2 } from '../../src/zone-order.ts';
const gj = JSON.parse(readFileSync(process.argv[2],'utf8'));
const f = gj.features ?? [];
const holes = f.filter(x => (x.properties?.n ?? 0) === 0 && x.geometry);
const overs = f.filter(x => (x.properties?.n ?? 0) > 1 && x.geometry);
const sum = (a) => a.reduce((t,x)=>t+areaKm2(x.geometry),0);
console.log(`  ${f.length} tiles   holes(n=0): ${holes.length} (${sum(holes).toFixed(2)} km2)`
  + `   overlaps(n>1): ${overs.length} (${Math.round(sum(overs)).toLocaleString()} km2)`);
const big = holes.map(x=>({km2:areaKm2(x.geometry), g:x.geometry})).sort((a,b)=>b.km2-a.km2).slice(0,5);
for (const h of big) {
  const r = h.g.type==='Polygon'?h.g.coordinates:h.g.coordinates.flat();
  let W=Infinity,E=-Infinity,S=Infinity,N=-Infinity;
  for (const ring of r) for (const [x,y] of ring){if(x<W)W=x;if(x>E)E=x;if(y<S)S=y;if(y>N)N=y;}
  console.log(`     hole ${h.km2.toFixed(3)} km2 at ${((S+N)/2).toFixed(3)},${((W+E)/2).toFixed(3)}`);
}
