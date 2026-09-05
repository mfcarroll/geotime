import { readFileSync } from 'node:fs';
const gj = JSON.parse(readFileSync(process.argv[2],'utf8'));
const [W,E,S,N] = [25.8, 26.8, 35.7, 36.4];
const inBox = ([lon,lat]) => lon>=W&&lon<=E&&lat>=S&&lat<=N;
const polysOf = (g) => !g ? [] : g.type==='Polygon' ? [g.coordinates] : g.coordinates;

// crude equal-area-ish: degrees^2 scaled by cos(lat) -> km^2
function areaKm2(ring){
  let a=0; const latm = ring.reduce((s,p)=>s+p[1],0)/ring.length;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++)
    a += ring[j][0]*ring[i][1]-ring[i][0]*ring[j][1];
  return Math.abs(a/2)*111.32*111.32*Math.cos(latm*Math.PI/180);
}
const centroid = (r)=>[ (r.reduce((s,p)=>s+p[0],0)/r.length), (r.reduce((s,p)=>s+p[1],0)/r.length) ];

for (const tz of ['Europe/Athens','Etc/GMT-2']) {
  console.log(`\n=== ${tz} — rings with every vertex inside the islet box ===`);
  for (const f of gj.features) {
    if (f.properties.tzid !== tz) continue;
    for (const poly of polysOf(f.geometry)) {
      poly.forEach((ring, idx) => {
        if (!ring.every(inBox)) return;
        const c = centroid(ring);
        console.log(`  ${idx===0?'outer':'HOLE '}  ${String(ring.length).padStart(3)} verts` +
                    `  ~${areaKm2(ring).toFixed(1).padStart(6)} km2  at ${c[0].toFixed(3)},${c[1].toFixed(3)}`);
      });
    }
  }
}
