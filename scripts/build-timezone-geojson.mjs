#!/usr/bin/env node
// Rebuilds public/timezones.topojson from timezone-boundary-builder.
//
// The map data is a *generated artifact*, not hand-maintained. tzdb ships a few
// releases a year and boundaries do change (Asia/Qostanay, Mexico dropping DST,
// Greenland, ...), so this needs to be re-runnable — that's the whole point of
// this script. Output carries one property per feature, `tzid`, holding a real
// IANA zone id.
//
//   npm run build:timezones
//   node --import ./scripts/ts-resolve.mjs scripts/build-timezone-geojson.mjs \
//        [--release 2026c] [--simplify 20%] [--oceans] [--out PATH]
//
// --oceans uses the with-oceans build, which adds 25 nautical Etc/GMT±N zones so
// the whole globe is covered. Without it, ocean is bare map background — the
// Natural Earth data this replaced had 14 ocean features, so land-only is a
// visible change to how the map reads.
//
// Requires network + npx (mapshaper is fetched on demand, not a dependency).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, renameSync, readFileSync, writeFileSync } from 'node:fs';
// The SAME precedence the app resolves with. Imported rather than restated, so
// the map and the lookup cannot drift apart. Requires the .ts resolver hook:
//   node --import ./scripts/ts-resolve.mjs scripts/build-timezone-geojson.mjs
import { lookupOrder, isNauticalZone, areaKm2 as spanArea } from '../src/zone-order.ts';
import { feature as topoFeature } from 'topojson-client';
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
// 0.2% was the original default and it is too coarse to answer a POINT question.
// It kept 137 vertices for all of Greece and its islands, which reads fine at map
// zoom — fills land within a pixel or two — and puts Santorini outside its own
// zone. With the --oceans build underneath, that does not miss: it returns
// Etc/GMT-2, a fixed offset that happens to match Greece in winter and is an hour
// wrong all summer. A plausible wrong answer, which is worse than none.
//
// 20% is where this stops being a tradeoff. Checked against the UNSIMPLIFIED
// boundaries over 19,951 equal-area land points:
//
//     10%     99.995% identical    1 point on a different clock
//     20%    100.000% identical    0
//
// and checked against the 63,493 cities in the shipped index, whose zones are
// known, 10% / 20% / unsimplified all land within a couple of cities of each
// other. Detail stopped buying accuracy well before here — 20% is chosen for how
// the coastlines LOOK, and it happens to already agree with the source data.
//
// Going further is a real cost for nothing: unsimplified is 6,128 KB gzipped and
// 881 MB of heap once decoded (geojson in JS runs ~30x the file size, every
// coordinate its own array), against 1,975 KB and 180 MB here. That would not
// survive a mobile WebView.
const SIMPLIFY = arg('simplify', '20%');
const OCEANS = process.argv.includes('--oceans');
// No ring may span more than this much longitude. See splitWideRings.
const MAX_RING_SPAN = 100;
// A piece of nautical band walled in by land, smaller than this, is handed to
// the smallest land zone touching it. See resolveOverlapsByPrecedence.
const ENCLAVE_MAX_KM2 = 300;
// A piece surrounded by exactly ONE zone is taken at any size — see
// resolveOverlapsByPrecedence — but not silently past this. Nothing today comes
// near it; the largest such piece is a 1,163 km2 lagoon inside Pacific/Tahiti.
// If a future release trips this, LOOK at what it is before raising it.
const ENCLAVE_SOLE_ALARM_KM2 = 25000;
const VARIANT = OCEANS ? 'timezones-with-oceans' : 'timezones';
const MIN_ZONES = OCEANS ? 430 : 400;   // 444 with oceans, 419 without
const OUT = arg('out', join(import.meta.dirname, '..', 'public', 'timezones.topojson'));

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
 * Fills the ground no zone claims by running the nautical bands down to meet it.
 *
 * Worth being precise about the size of this problem, because it is much smaller
 * than mapshaper suggests. Its -mosaic reports ~76 tiles no zone covers, and if
 * you total their area you get about 14,725 km2 — but most of those tiles are an
 * artefact of building a planar topology, not ground the app would fail on. The
 * largest, 6,314 km2 off Enderby Land, answers correctly at 47,999 of 48,000
 * densely sampled points. Sampled globally at 200,000 equal-area points, the
 * unsimplified source has ZERO uncovered points, and so does this build.
 *
 * What this pass closes is the genuinely enclosed remainder: 12 km2. Small, and
 * kept anyway, because a hole is not a wrong answer but no answer at all —
 * findTimezoneFromGeoJSON returns null and a tap on the map does nothing — and
 * because it costs one clip per band. The runtime covers the lookup with
 * nauticalTimezone(); this closes the same ground by the same rule, so the map
 * and the fallback agree rather than one quietly rescuing the other.
 *
 * Each hole is cut at the band meridians rather than handed whole to the band
 * under its centroid: that 6,314 km2 strip spans THREE bands (25E–55E crosses
 * Etc/GMT-2, -3 and -4), so one owner for the lot would be wrong across two
 * thirds of it.
 */
function fillHolesWithBands(holes, workDir) {
  if (holes.length === 0) return [];
  writeFileSync(join(workDir, 'holes.geojson'),
    JSON.stringify({ type: 'FeatureCollection', features:
      holes.map((geometry) => ({ type: 'Feature', properties: {}, geometry })) }));

  const filled = [];
  for (let h = -12; h <= 12; h++) {
    // Same bands nauticalTimezone() names: 15 degrees centred on each multiple
    // of 15, clamped at the dateline so the two ±12 bands keep their own side.
    const west = Math.max(-180, h * 15 - 7.5);
    const east = Math.min(180, h * 15 + 7.5);
    const tzid = h === 0 ? 'Etc/GMT' : `Etc/GMT${h > 0 ? '-' : '+'}${Math.abs(h)}`;
    const out = `hole-${h + 12}.geojson`;
    run('npx', ['-y', 'mapshaper@0.6', 'holes.geojson',
      '-clip', `bbox=${west},-90,${east},90`,
      '-o', out, 'format=geojson']);
    let slice;
    try { slice = JSON.parse(readFileSync(join(workDir, out), 'utf8')); } catch { continue; }
    // mapshaper writes a bare GeometryCollection when the layer carries no
    // attributes, which these do not — reading only .features finds nothing.
    const shapes = slice.type === 'GeometryCollection'
      ? slice.geometries.map((geometry) => ({ geometry }))
      : (slice.features ?? []);
    for (const f of shapes) {
      if (!f.geometry) continue;
      filled.push({ type: 'Feature', properties: { tzid }, geometry: f.geometry });
    }
  }
  const km2 = filled.reduce((t, f) => t + spanArea(f.geometry), 0);
  console.log(`  ${holes.length} holes closed as ${filled.length} band pieces, ${Math.round(km2).toLocaleString()} km2`);
  return filled;
}

/**
 * Applies the app's own zone precedence to the GEOMETRY, so no point on the map
 * is inside two zones — and none stops being inside one.
 *
 * Deciding a winner at lookup time is not enough on its own. The map draws every
 * polygon it is given, so while two zones still overlap, selecting one and then
 * the other highlights two different edges over the same ground and the boundary
 * appears to move under the pointer. Whatever we have decided about who owns
 * Xinjiang, the map should show one line there.
 *
 * This is done by MOSAIC, not by erasing one shape out of another. The erase
 * looked simpler and was wrong: subtracting two nearly-coincident boundaries
 * leaves hairline slivers belonging to neither side, and a sliver is worse than
 * the overlap it replaces — an overlap still answers, a sliver is a hole you can
 * click and get nothing. It cut a real one out of the Belgium/Germany border
 * near Eupen, about 3% of that area, and mapshaper's own -erase-based gap check
 * could not see it, because that operation snaps slivers away as it goes. Use
 * `-mosaic` and count tiles with n=0; that is the only gap check to trust here.
 *
 * A mosaic cannot cut a hole. It partitions the union of the inputs into tiles
 * that do not overlap and leave nothing out, each knowing which zones covered
 * it. Choosing a winner per tile and dissolving back by tzid keeps every piece
 * of ground that was covered before, under exactly one owner.
 *
 * Precedence comes from src/zone-order.ts rather than being restated here, so
 * the map and findTimezoneFromGeoJSON cannot drift apart.
 *
 * This replaced two earlier passes that did the same job worse: a hand-written
 * table naming Sitka/Vancouver and Moncton/New_York, and a sweep erasing land
 * out of the nautical bands. Every one of those decisions falls out of the
 * general rule — smallest zone wins, land before water — and the build log
 * prints "America/Sitka keeps its ground, America/Vancouver gives way" without
 * being told to. Output was identical with them removed, so they are gone
 * rather than kept: both were subtractive booleans.
 */
function resolveOverlapsByPrecedence(inFile, workDir) {
  console.log('→ resolving overlaps in the geometry');

  // topojson ONLY as an adjacency index: every shared boundary becomes one arc
  // that both tiles reference, so "these two touch" is "these two name the same
  // arc". no-quantization because these coordinates are written straight back
  // out, and a ~20 m grid snaps shared edges apart and opens holes.
  run('npx', ['-y', 'mapshaper@0.6', inFile,
    '-mosaic', 'calc=n = count(), zones = collect(tzid)',
    '-each', 'zoneList = zones ? zones.join("|") : "", zones = null',
    '-o', 'mosaic.topojson', 'format=topojson', 'no-quantization']);

  const topo = JSON.parse(readFileSync(join(workDir, 'mosaic.topojson'), 'utf8'));
  const objName = Object.keys(topo.objects)[0];
  const geoms = topo.objects[objName].geometries;
  const tiles = topoFeature(topo, topo.objects[objName]).features;

  const source = JSON.parse(readFileSync(inFile, 'utf8'));
  const rank = new Map(lookupOrder(source.features).map((f, i) => [f.properties.tzid, i]));
  const zoneArea = new Map();
  for (const f of source.features) zoneArea.set(f.properties.tzid, spanArea(f.geometry));

  // ---- 1. one owner per tile, by the app's own precedence ----
  let contested = 0, holes = 0;
  const holeGeoms = [];
  const decided = new Map();
  const owner = new Array(tiles.length).fill(null);
  tiles.forEach((f, i) => {
    const zones = [...new Set(String(f.properties?.zoneList ?? '').split('|').filter(Boolean))];
    if (zones.length === 0) { holes++; holeGeoms.push(f.geometry); return; }
    if (zones.length > 1) {
      contested++;
      const order = zones.slice().sort((x, y) => (rank.get(x) ?? Infinity) - (rank.get(y) ?? Infinity));
      decided.set(`${order[0]} keeps its ground, ${order.slice(1).join(' and ')} gives way`, true);
    }
    owner[i] = zones.reduce((best, z) =>
      (rank.get(z) ?? Infinity) < (rank.get(best) ?? Infinity) ? z : best);
  });
  console.log(`  ${tiles.length} tiles: ${contested} contested, ${holes} holes already in the input`);
  for (const line of [...decided.keys()].sort()) console.log(`    ${line}`);

  // ---- 2. adjacency, from the shared arcs ----
  const arcsOf = (g) => {
    const out = new Set();
    const walk = (x) => Array.isArray(x) ? x.forEach(walk) : out.add(x < 0 ? ~x : x);
    walk(g.arcs);
    return out;
  };
  const byArc = new Map();
  geoms.forEach((g, i) => {
    for (const a2 of arcsOf(g)) { const l = byArc.get(a2) ?? []; l.push(i); byArc.set(a2, l); }
  });
  const neighbours = geoms.map(() => new Set());
  for (const list of byArc.values())
    for (const i of list) for (const j of list) if (i !== j) neighbours[i].add(j);

  // ---- 3. band pieces walled in by land go to the land ----
  //
  // A tile is too fine a unit to judge this on: one stretch of enclosed water is
  // several tiles, and each would see its own neighbours as "another band" and
  // disqualify itself. So group touching tiles of the same band into a region
  // first, and ask the question of the region.
  const seen = new Array(tiles.length).fill(false);
  const moved = [];
  for (let i = 0; i < tiles.length; i++) {
    if (seen[i] || owner[i] === null || !isNauticalZone(owner[i])) continue;
    const region = [], queue = [i];
    seen[i] = true;
    while (queue.length) {
      const k = queue.pop();
      region.push(k);
      for (const j of neighbours[k])
        if (!seen[j] && owner[j] === owner[k]) { seen[j] = true; queue.push(j); }
    }
    const members = new Set(region);
    const touching = new Set();
    for (const k of region) for (const j of neighbours[k]) if (!members.has(j)) touching.add(j);
    const touchingZones = [...touching].map((j) => owner[j]).filter(Boolean);
    if (touchingZones.length === 0) continue;                       // touches nothing
    if (touchingZones.some(isNauticalZone)) continue;               // open sea
    const km2 = region.reduce((s, k) => s + spanArea(tiles[k].geometry), 0);
    const distinct = [...new Set(touchingZones)];

    // A piece with exactly one zone around it is that zone's, whatever its size:
    // there is no second claim to weigh, and the band it belongs to is somewhere
    // else entirely. Size only ever mattered as a proxy for "is this really open
    // sea", and one enclosing zone answers that directly.
    //
    // EXCEPT where the piece reaches the edge of the map. Adjacency here is
    // topological — two shapes are neighbours when they share an arc — and
    // nothing shares an arc across the antimeridian, so a piece running up to
    // 180 looks walled in while actually opening onto the Pacific. Etc/GMT-12
    // off Chukotka does exactly this: 6,032 km2 spanning 178.9 to 180.0, three
    // vertices sitting on the meridian, and it would have been handed to
    // Asia/Anadyr as though it were a lagoon. Poles likewise.
    const onMapEdge = region.some((k) => ringsOf(tiles[k].geometry).some((ring) =>
      ring.some(([x, y]) => Math.abs(Math.abs(x) - 180) < 1e-6 || Math.abs(Math.abs(y) - 90) < 1e-6)));
    const soleOwner = distinct.length === 1 && !onMapEdge;

    if (!soleOwner && km2 > ENCLAVE_MAX_KM2) continue;
    if (soleOwner && km2 > ENCLAVE_SOLE_ALARM_KM2) {
      throw new Error(`a single zone (${distinct[0]}) encloses ${Math.round(km2).toLocaleString()} km2 `
        + `of ${owner[i]} — far larger than anything seen before. Look at it before raising `
        + `ENCLAVE_SOLE_ALARM_KM2; a real sea can become sole-enclosed if two zones merge upstream.`);
    }
    const adopter = distinct
      .sort((x, y) => (zoneArea.get(x) ?? 0) - (zoneArea.get(y) ?? 0))[0];
    let sx = 0, sy = 0, n = 0;
    for (const k of region) {
      const g = tiles[k].geometry;
      const rings = g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
      for (const r of rings) for (const [x, y] of r) { sx += x; sy += y; n++; }
    }
    moved.push({ km2, from: owner[i], to: adopter, sole: soleOwner, lat: sy / n, lon: sx / n,
      geometry: { type: 'MultiPolygon', coordinates: region.flatMap((k) => {
        const g = tiles[k].geometry;
        return g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      }) } });
    for (const k of region) owner[k] = adopter;
  }
  // An adopted piece becomes ordinary land, so afterwards there is nothing left
  // on the map to look at — which makes the change impossible to review. Dump the
  // pieces so ?debug=geometry can draw them. Local-only and gitignored.
  if (moved.length) {
    try {
      writeFileSync(join(import.meta.dirname, '..', 'public', 'debug-adopted.geojson'),
        JSON.stringify({ type: 'FeatureCollection', features: moved.map((m) => ({
          type: 'Feature',
          properties: { km2: +m.km2.toFixed(3), from: m.from, to: m.to, rule: m.sole ? 'sole enclosing zone' : `under ${ENCLAVE_MAX_KM2} km2` },
          geometry: m.geometry,
        })) }));
    } catch (error) {
      console.warn('  (could not write the debug-adopted layer)', error.message);
    }
  }
  console.log(`  ${moved.length} walled-in band pieces adopted, ${moved.reduce((s, m) => s + m.km2, 0).toFixed(1)} km2`);
  for (const m of moved.sort((x, y) => y.km2 - x.km2))
    console.log(`    ${m.km2.toFixed(3).padStart(9)} km2  ${m.from} -> ${m.to}`
      + `  ${m.sole ? '[sole]' : '[<' + ENCLAVE_MAX_KM2 + ']'}`
      + `  https://localhost:5173/?fix=${m.lat.toFixed(5)},${m.lon.toFixed(5)}`);

  // ---- 4. one dissolve, and only one ----
  const assigned = tiles
    .map((f, i) => owner[i] === null ? null
      : { type: 'Feature', properties: { tzid: owner[i] }, geometry: f.geometry })
    .filter(Boolean)
    .concat(fillHolesWithBands(holeGeoms, workDir));
  writeFileSync(join(workDir, 'assigned.geojson'),
    JSON.stringify({ type: 'FeatureCollection', features: assigned }));
  run('npx', ['-y', 'mapshaper@0.6', 'assigned.geojson',
    '-dissolve2', 'tzid',
    '-o', 'resolved.geojson', 'format=geojson']);
  return join(workDir, 'resolved.geojson');
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
  // ratios. min-area 20km2 drops slivers too small to ever be tapped. No
  // `-clean`: it silently dissolves zones that overlap (Asia/Urumqi).
  // ONE pass over the combined file, always. Never split land from ocean.
  //
  // NO `keep-shapes`. It reads like a safety net — it stops tiny zones being
  // simplified out of existence — but it protects a ring only when that ring is
  // a shape of its own. An island is its own ring inside Europe/Athens and a
  // HOLE inside the Etc/GMT-2 polygon that surrounds it, and the hole gets no
  // such protection. The single real coastline then comes out at two different
  // resolutions:
  //
  //     islet SW of Astypalaia, 5%, WITH keep-shapes
  //       Europe/Athens outer ring     21 and 45 vertices
  //       Etc/GMT-2 hole               10 and 17 vertices
  //
  //     the same islet, 5%, WITHOUT
  //       both                         21 and 45 vertices
  //
  // Two boundaries are then drawn at every coast, and because the coarser hole
  // cuts inside the island, the ocean band overlaps the shore. Hover repaints
  // one of the pair, so the border visibly moves under the pointer. Measured
  // over 22,665 points across five coastline-dense regions:
  //
  //     5% with keep-shapes    gaps: 2    land/ocean overlaps: 14
  //     5% without             gaps: 0    land/ocean overlaps:  1
  //
  // Dropping it does cost the vertices small zones were leaning on, so the ratio
  // has to carry them instead: at 5% Europe/Vatican (0.49 km2) vanishes, at 10%
  // all 444 zones survive, and so do all 444 at the 20% we ship. Do not lower
  // the ratio without re-checking the zone count, which the sanity check below
  // enforces rather than trusting.
  //
  // It is also what makes topojson worth having: with the coastlines finally
  // identical, one arc serves both zones. 10% topojson gzips to 1,042 KB against
  // 2,564 KB for 5% geojson — twice the detail for 40% of the bytes.
  // `lock-box` pins vertices sitting on the data's bounding box — the poles at
  // +/-90 and the antimeridian at +/-180 — so the simplifier cannot move them.
  //
  // Without it, simplification cuts the corners off the nautical bands where
  // they converge at the poles, and the corner it cuts is a hole nothing else
  // covers. Erasing every zone from a world rectangle finds them exactly:
  //
  //     unsimplified                    0 patches,       0 km2
  //     20%                            87 patches, 276,018 km2
  //     20% with snap on import        75 patches, 275,145 km2
  //     20% with lock-box               0 patches,       0 km2
  //
  // Two of those patches were 133,642 km2 each, wedges reaching the north pole
  // from about 71.7N. One of them was literally [-180,71.75] -> [-172.5,90] ->
  // [-180,90]: the band's corner, shaved off. `snap` barely touched them because
  // the vertices were already coincident; the problem was not that the arc was
  // duplicated but that it was allowed to move at all.
  //
  // Gaps are worse than overlaps. An overlap still answers the question, just
  // with the wrong zone if the scan order is wrong; a gap answers nothing, and a
  // tap there does nothing at all.
  console.log(`→ simplifying to ${SIMPLIFY}`);
  run('npx', ['-y', 'mapshaper@0.6', src,
    '-simplify', 'visvalingam', SIMPLIFY, 'lock-box',
    '-filter-islands', 'min-area', '20km2',
    '-o', 'precision=0.0001', 'format=geojson', 'out.geojson']);

  console.log('→ trimming known bad-shape overlaps');
  let built = join(work, 'out.geojson');
  built = resolveOverlapsByPrecedence(built, work);
  const collection = JSON.parse(readFileSync(built, 'utf8'));

  console.log('→ splitting polar rings');
  splitWideRings(collection, work);

  const { features } = collection;
  const ids = new Set(features.map(f => f.properties?.tzid));
  if (ids.size < MIN_ZONES || [...ids].some(id => !id)) {
    throw new Error(`sanity check failed: ${ids.size} distinct tzids, expected >= ${MIN_ZONES}`);
  }
  // Without keep-shapes a zone small enough can be simplified down to nothing,
  // and it goes quietly: the feature survives with a null geometry, so the tzid
  // is still counted above. Europe/Vatican (0.49 km2) does exactly this: gone at
  // 5%, present at 10% and at the 20% we ship. Where between 5% and 10% it turns
  // is not measured — hence a check rather than a remembered threshold.
  const emptied = features.filter(f => !f.geometry).map(f => f.properties?.tzid);
  if (emptied.length) {
    throw new Error(`sanity check failed: simplified away entirely at ${SIMPLIFY}: ${emptied.join(', ')}`);
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

  // Ship topojson, not geojson. The win is de-duplication rather than
  // compression: every coastline is stored twice in geojson — once on the land
  // zone, once on the ocean zone abutting it — and topojson stores it once, as
  // an arc both reference. That only became possible when keep-shapes went; while
  // the two copies disagreed there was nothing to share. At 20%: 6.7 MB against
  // 29 MB of geojson, 1,975 KB against 9,600 KB gzipped.
  //
  // It runs as a second mapshaper pass rather than an -o flag on the first
  // because splitWideRings has to work on parsed GeoJSON in between. The pass
  // re-derives topology from the final geometry, which is what we want, and
  // picks its own quantization from the data (~23 m at 20%).
  writeFileSync(join(work, 'sliced.geojson'), JSON.stringify(collection));
  console.log('→ converting to topojson');
  run('npx', ['-y', 'mapshaper@0.6', 'sliced.geojson', '-o', 'format=topojson', 'out.topojson']);
  renameSync(join(work, 'out.topojson'), OUT);
  console.log(`✓ ${OUT}`);
  console.log(`  ${features.length} features, ${ids.size} zones, ${(statSync(OUT).size / 1024).toFixed(0)} KB`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
