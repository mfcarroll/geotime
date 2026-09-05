// node --import ./scripts/ts-resolve.mjs scripts/tz-analysis/hole-report.mjs
// Every tile no zone covers, with what the app falls back to there.
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { areaKm2 } from '../../src/zone-order.ts';
// Mirrors nauticalTimezone() in src/time.ts. Copied rather than imported
// because time.ts pulls in dom.ts, which needs a browser — the function itself
// is pure and could live somewhere importable.
const nauticalTimezone = (lon) => {
  const hours = Math.max(-12, Math.min(12, Math.round(lon / 15)));
  return hours === 0 ? 'Etc/GMT' : `Etc/GMT${hours > 0 ? '-' : '+'}${Math.abs(hours)}`;
};

const work = mkdtempSync(join(tmpdir(), 'holes-'));
try {
  execFileSync('npx', ['-y', 'mapshaper@0.6', 'public/timezones.topojson',
    '-mosaic', 'calc=n = count(), zones = collect(tzid)', '-filter', 'n === 0', '-explode',
    '-o', join(work, 'h.json'), 'format=geojson'], { stdio: 'pipe' });
  const gj = JSON.parse(readFileSync(join(work, 'h.json'), 'utf8'));
  const rows = (gj.features ?? gj.geometries.map((geometry) => ({ geometry })))
    .filter((f) => f.geometry).map((f) => {
      const rings = f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates.flat();
      let W = Infinity, E = -Infinity, S = Infinity, N = -Infinity;
      for (const r of rings) for (const [x, y] of r) { if (x<W)W=x; if(x>E)E=x; if(y<S)S=y; if(y>N)N=y; }
      return { km2: areaKm2(f.geometry), W, E, S, N, lat: (S+N)/2, lon: (W+E)/2 };
    }).sort((a, b) => b.km2 - a.km2);

  const total = rows.reduce((s, r) => s + r.km2, 0);
  const antarctic = rows.filter((r) => r.lat < -60);
  console.log(`  ${rows.length} holes, ${Math.round(total).toLocaleString()} km2`);
  console.log(`  ${antarctic.length} of them below 60S, holding ${Math.round(antarctic.reduce((s,r)=>s+r.km2,0)).toLocaleString()} km2`);
  console.log(`  everything else: ${rows.length - antarctic.length} holes, ${(total - antarctic.reduce((s,r)=>s+r.km2,0)).toFixed(1)} km2\n`);
  console.log('        km2   centre              falls back to   link');
  for (const r of rows.slice(0, 12)) {
    const tz = nauticalTimezone(r.lon);
    const peninsula = r.lon > -70 && r.lon < -50 && r.lat < -60 ? '   <-- Antarctic Peninsula sector' : '';
    console.log(`  ${Math.round(r.km2).toLocaleString().padStart(9)}   ${r.lat.toFixed(2)},${r.lon.toFixed(2)}`.padEnd(35)
      + `${tz.padEnd(15)} https://localhost:5173/?fix=${r.lat.toFixed(5)},${r.lon.toFixed(5)}${peninsula}`);
  }
  if (rows.length > 12) console.log(`    ...and ${rows.length - 12} more, largest ${rows[12].km2.toFixed(2)} km2`);
} finally { rmSync(work, { recursive: true, force: true }); }
