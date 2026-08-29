#!/usr/bin/env node
// Rebuilds public/timezones.geojson from timezone-boundary-builder.
//
// The map data is a *generated artifact*, not hand-maintained. tzdb ships a few
// releases a year and boundaries do change (Asia/Qostanay, Mexico dropping DST,
// Greenland, ...), so this needs to be re-runnable — that's the whole point of
// this script. Output carries one property per feature, `tzid`, holding a real
// IANA zone id.
//
//   node scripts/build-timezone-geojson.mjs [--release 2026c] [--simplify 0.2%]
//                                            [--oceans] [--out PATH]
//
// --oceans uses the with-oceans build, which adds 25 nautical Etc/GMT±N zones so
// the whole globe is covered. Without it, ocean is bare map background — the
// Natural Earth data this replaced had 14 ocean features, so land-only is a
// visible change to how the map reads.
//
// Requires network + npx (mapshaper is fetched on demand, not a dependency).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, statSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

// `timezones` = all 419 IANA zones. Deliberately NOT `timezones-now` (63 zones,
// merges Vancouver into Los_Angeles) nor `-1970` (301 zones, relabels Bangkok
// as Jakarta) — both destroy the city identities this app exists to show.
const RELEASE = arg('release', '2026c');
const SIMPLIFY = arg('simplify', '0.2%');
const OCEANS = process.argv.includes('--oceans');
const VARIANT = OCEANS ? 'timezones-with-oceans' : 'timezones';
const MIN_ZONES = OCEANS ? 430 : 400;   // 444 with oceans, 419 without
const OUT = arg('out', join(import.meta.dirname, '..', 'public', 'timezones.geojson'));

const work = mkdtempSync(join(tmpdir(), 'tzbuild-'));
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: work });

try {
  const url = `https://github.com/evansiroky/timezone-boundary-builder/releases/download/${RELEASE}/${VARIANT}.geojson.zip`;
  console.log(`→ downloading ${RELEASE} ${VARIANT} (~${OCEANS ? 55 : 51} MB)`);
  run('curl', ['-sSL', '--fail', url, '-o', 'tz.zip']);

  console.log('→ unzipping');
  run('unzip', ['-o', '-q', 'tz.zip']);
  // the archives name their payload after the variant
  const src = OCEANS ? 'combined-with-oceans.json' : 'combined.json';

  // visvalingam preserves shape character better than douglas-peucker at these
  // ratios; keep-shapes stops small zones (Gibraltar, Andorra, Pacific islands)
  // from vanishing entirely. min-area 20km2 drops slivers too small to ever be
  // tapped. No `-clean`: it silently dissolves zones that overlap (Asia/Urumqi).
  console.log(`→ simplifying to ${SIMPLIFY}`);
  run('npx', ['-y', 'mapshaper@0.6', src,
    '-simplify', 'visvalingam', SIMPLIFY, 'keep-shapes',
    '-filter-islands', 'min-area', '20km2',
    '-o', 'precision=0.0001', 'format=geojson', 'out.geojson']);

  const built = join(work, 'out.geojson');
  const { features } = JSON.parse(execFileSync('cat', [built], { maxBuffer: 1 << 30 }));
  const ids = new Set(features.map(f => f.properties?.tzid));
  if (ids.size < MIN_ZONES || [...ids].some(id => !id)) {
    throw new Error(`sanity check failed: ${ids.size} distinct tzids, expected >= ${MIN_ZONES}`);
  }
  for (const must of ['America/Vancouver', 'America/Los_Angeles', 'Asia/Kolkata', 'Europe/Berlin']) {
    if (!ids.has(must)) throw new Error(`sanity check failed: ${must} missing`);
  }

  renameSync(built, OUT);
  console.log(`✓ ${OUT}`);
  console.log(`  ${features.length} features, ${ids.size} zones, ${(statSync(OUT).size / 1024).toFixed(0)} KB`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
