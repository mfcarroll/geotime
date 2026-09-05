// node --import ./scripts/ts-resolve.mjs scripts/tz-analysis/ocean-enclaves.mjs [maxKm2]
//
// Finds pieces of a nautical Etc/GMT band that are walled in by named land
// zones — no edge shared with any other band. Those are the stray triangles at
// a zone intersection: water on the map, but water that belongs to a band whose
// own body is somewhere else entirely.
//
// Adjacency is exact, not sampled: converting to topojson makes every shared
// boundary ONE arc referenced by both sides, so "these two touch" is "these two
// name the same arc".
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { feature } from 'topojson-client';
import { areaKm2, isNauticalZone } from '../../src/zone-order.ts';

const MAX_KM2 = Number(process.argv[2] ?? Infinity);
// Defaults to the shipped file; pass a path to inspect a build that has not had
// the adoption applied, since adopted pieces are by definition gone from it.
const SRC = process.argv[3] ?? 'public/timezones.topojson';
const work = mkdtempSync(join(tmpdir(), 'enclave-'));
try {
  // -explode so each polygon part is its own geometry; adjacency is per part.
  execFileSync('npx', ['-y', 'mapshaper@0.6', SRC,
    '-explode', '-o', join(work, 'parts.topojson'), 'format=topojson'], { stdio: 'pipe' });

  const topo = JSON.parse(readFileSync(join(work, 'parts.topojson'), 'utf8'));
  const objName = Object.keys(topo.objects)[0];
  const geoms = topo.objects[objName].geometries;
  const decoded = feature(topo, topo.objects[objName]).features;

  const arcsOf = (g) => {
    const out = new Set();
    const walk = (a) => Array.isArray(a) ? a.forEach(walk) : out.add(a < 0 ? ~a : a);
    walk(g.arcs);
    return out;
  };
  const byArc = new Map();
  geoms.forEach((g, i) => {
    for (const a of arcsOf(g)) {
      const l = byArc.get(a) ?? []; l.push(i); byArc.set(a, l);
    }
  });
  const neighbours = geoms.map(() => new Set());
  for (const list of byArc.values())
    for (const i of list) for (const j of list) if (i !== j) neighbours[i].add(j);

  const tzOf = (i) => decoded[i].properties.tzid;
  const areaOf = (i) => areaKm2(decoded[i].geometry);

  const found = [];
  for (let i = 0; i < geoms.length; i++) {
    if (!isNauticalZone(tzOf(i))) continue;
    const nb = [...neighbours[i]];
    if (nb.length === 0) continue;                        // touches nothing at all
    if (nb.some((j) => isNauticalZone(tzOf(j)))) continue; // touches another band
    const km2 = areaOf(i);
    if (km2 > MAX_KM2) continue;
    const f_tz = tzOf(i);
    const land = [...new Set(nb.map(tzOf))];
    const sizes = new Map(land.map((t) => [t, decoded.reduce((s, f, k) =>
      f.properties.tzid === t ? s + areaOf(k) : s, 0)]));
    const adopter = land.slice().sort((a, b) => sizes.get(a) - sizes.get(b))[0];
    // centroid of the part, for a link to look at
    const rings = decoded[i].geometry.type === 'Polygon'
      ? decoded[i].geometry.coordinates : decoded[i].geometry.coordinates.flat();
    let sx = 0, sy = 0, n = 0;
    for (const r of rings) for (const [x, y] of r) { sx += x; sy += y; n++; }
    const off = (tz, iso) => {
      const m = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
        .format(new Date(iso)).match(/GMT([+-])(\d{2}):(\d{2})/);
      return m ? (m[1] === '-' ? -1 : 1) * (+m[2] + +m[3] / 60) : 0;
    };
    const W = '2026-01-15T12:00:00Z', S2 = '2026-07-15T12:00:00Z';
    const clock = off(f_tz, W) === off(adopter, W) && off(f_tz, S2) === off(adopter, S2)
      ? 'same clock'
      : off(f_tz, W) !== off(adopter, W) ? 'CHANGES year-round' : 'changes in summer';
    found.push({ km2, tz: f_tz, land, adopter, lat: sy / n, lon: sx / n, clock });
  }

  found.sort((a, b) => b.km2 - a.km2);
  const buckets = [0.01, 0.1, 1, 10, 100, 1000, Infinity];
  console.log(`  ${geoms.length} polygon parts; ${found.length} are band pieces walled in by land\n`);
  console.log('  size distribution:');
  let prev = 0;
  for (const b of buckets) {
    const n = found.filter((f) => f.km2 > prev && f.km2 <= b).length;
    if (n) console.log(`    ${String(n).padStart(4)}  ${prev} – ${b === Infinity ? '∞' : b} km2`);
    prev = b;
  }
  console.log(`\n  total area: ${found.reduce((s, f) => s + f.km2, 0).toFixed(2)} km2\n`);
  console.log('        km2   band          would go to         clock                link');
  for (const f of found)
    console.log(`  ${f.km2.toFixed(3).padStart(9)}   ${f.tz.padEnd(13)} ${f.adopter.padEnd(19)} ${f.clock.padEnd(19)}`
      + `https://localhost:5173/?fix=${f.lat.toFixed(5)},${f.lon.toFixed(5)}`
      + (f.land.length > 1 ? `   (also touches ${f.land.filter(t => t !== f.adopter).join(', ')})` : ''));
} finally {
  rmSync(work, { recursive: true, force: true });
}
