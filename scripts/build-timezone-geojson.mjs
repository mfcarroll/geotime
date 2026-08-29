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
import { mkdtempSync, rmSync, statSync, renameSync, readFileSync, writeFileSync } from 'node:fs';
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
// No ring may span more than this much longitude. See splitWideRings.
const MAX_RING_SPAN = 100;
const VARIANT = OCEANS ? 'timezones-with-oceans' : 'timezones';
const MIN_ZONES = OCEANS ? 430 : 400;   // 444 with oceans, 419 without
const OUT = arg('out', join(import.meta.dirname, '..', 'public', 'timezones.geojson'));

const work = mkdtempSync(join(tmpdir(), 'tzbuild-'));
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: work });

const ringsOf = (geometry) =>
  !geometry ? []
  : geometry.type === 'Polygon' ? geometry.coordinates
  : geometry.coordinates.flat();

const polygonsOf = (geometry) =>
  !geometry ? []
  : geometry.type === 'Polygon' ? [geometry.coordinates]
  : geometry.coordinates;

const ringSpan = (ring) => {
  let lo = Infinity, hi = -Infinity;
  for (const [lon] of ring) { if (lon < lo) lo = lon; if (lon > hi) hi = lon; }
  return hi - lo;
};

function widestRing(features) {
  let worst = { tzid: '(none)', span: 0 };
  for (const f of features) {
    for (const ring of ringsOf(f.geometry)) {
      const span = ringSpan(ring);
      if (span > worst.span) worst = { tzid: f.properties.tzid, span };
    }
  }
  return worst;
}

/**
 * Cuts any ring that wraps most of the globe into meridian slices.
 *
 * The Antarctic cap (Antarctica/McMurdo) arrives as ONE ring whose edge runs
 * along latitude -90 from longitude -180 to +180. Because -180 and +180 are the
 * same meridian, Google Maps can't tell which way that edge goes and renders the
 * polygon as covering the entire map: every click on the map hits McMurdo and
 * the whole world fills with the selected colour. This is why the Natural Earth
 * data worked despite also reaching the poles — its Antarctic zones are
 * per-longitude wedges, so no single ring ever spans the globe.
 *
 * Slicing at meridians keeps the geometry identical on screen while removing the
 * ambiguity. Only genuinely wrap-around rings are touched; in 2026c that is
 * exactly one of ~1,400 rings, the next widest being about 61°.
 */
function splitWideRings(collection, workDir) {
  const offenders = collection.features.filter((f) =>
    ringsOf(f.geometry).some((ring) => ringSpan(ring) > MAX_RING_SPAN));

  if (offenders.length === 0) {
    console.log('  no wrap-around rings found');
    return;
  }
  console.log(`  slicing ${offenders.map((f) => f.properties.tzid).join(', ')}`);

  writeFileSync(join(workDir, 'wide.geojson'),
    JSON.stringify({ type: 'FeatureCollection', features: offenders }));

  // 90 degree slices: comfortably under MAX_RING_SPAN, and few enough that the
  // added rings are negligible.
  const cuts = [[-180, -90], [-90, 0], [0, 90], [90, 180]];
  const byTzid = new Map();

  cuts.forEach(([west, east], i) => {
    const out = `slice-${i}.geojson`;
    run('npx', ['-y', 'mapshaper@0.6', 'wide.geojson',
      '-clip', `bbox=${west},-90,${east},90`,
      '-o', 'precision=0.0001', 'format=geojson', out]);
    const sliced = JSON.parse(readFileSync(join(workDir, out), 'utf8'));
    for (const f of sliced.features ?? []) {
      if (!f.geometry) continue;
      const list = byTzid.get(f.properties.tzid) ?? [];
      list.push(...polygonsOf(f.geometry));
      byTzid.set(f.properties.tzid, list);
    }
  });

  for (const f of offenders) {
    const polygons = byTzid.get(f.properties.tzid);
    if (!polygons?.length) {
      throw new Error(`slicing lost all geometry for ${f.properties.tzid}`);
    }
    f.geometry = polygons.length === 1
      ? { type: 'Polygon', coordinates: polygons[0] }
      : { type: 'MultiPolygon', coordinates: polygons };
  }
}

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
  const collection = JSON.parse(readFileSync(built, 'utf8'));

  console.log('→ splitting polar rings');
  splitWideRings(collection, work);

  const { features } = collection;
  const ids = new Set(features.map(f => f.properties?.tzid));
  if (ids.size < MIN_ZONES || [...ids].some(id => !id)) {
    throw new Error(`sanity check failed: ${ids.size} distinct tzids, expected >= ${MIN_ZONES}`);
  }
  for (const must of ['America/Vancouver', 'America/Los_Angeles', 'Asia/Kolkata', 'Europe/Berlin']) {
    if (!ids.has(must)) throw new Error(`sanity check failed: ${must} missing`);
  }
  // The invariant that actually matters for rendering — see splitWideRings.
  const stillWide = widestRing(features);
  if (stillWide.span > MAX_RING_SPAN) {
    throw new Error(
      `sanity check failed: ${stillWide.tzid} still spans ${stillWide.span.toFixed(1)}° of longitude`);
  }
  console.log(`  widest ring: ${stillWide.tzid} at ${stillWide.span.toFixed(1)}° longitude`);

  writeFileSync(built, JSON.stringify(collection));
  renameSync(built, OUT);
  console.log(`✓ ${OUT}`);
  console.log(`  ${features.length} features, ${ids.size} zones, ${(statSync(OUT).size / 1024).toFixed(0)} KB`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
