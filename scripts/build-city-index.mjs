#!/usr/bin/env node
// Builds public/cities.json — the city search index.
//
// People think in cities, not IANA ids, so the search box needs to resolve
// "Nelson" to America/Vancouver. Every zone id is searchable on its own from the
// map data; this index is what makes *places without their own zone* findable.
//
//   node scripts/build-city-index.mjs [--min-population 5000] [--out PATH]
//
// The 5000 floor is deliberate: it is the lowest GeoNames tier that still
// contains both Creston BC (5,583, which has its own zone America/Creston) and
// Nelson BC (10,664, which does not and resolves to Vancouver). The 15000 tier
// has neither. Going below 5000 roughly doubles the file again for towns nobody
// searches.
//
// Two exceptions to the floor:
//   - a zone with no town over the floor contributes its largest town at any
//     size, so "nearest place" has an answer in Dawson or Cambridge Bay;
//   - PPLX entries (a *section* of a place) are dropped at every size. They are
//     what produced "Surrey, BC" next to "Surrey City Centre, BC" and
//     "Zürich (Kreis 11)", and they are 7.7% of the file.
//
// Requires network. No build dependencies — plain Node.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const MIN_POP = Number(arg('min-population', 5000));
const OUT = arg('out', join(import.meta.dirname, '..', 'public', 'cities.json'));

// US admin1 codes are already postal abbreviations ("US.CA"), so only Canada
// needs a table — its codes are numeric ("CA.02"). Everywhere else keeps its
// full region name, which stays unambiguous for an international audience.
const CA_ABBREV = {
  'Alberta': 'AB',
  'British Columbia': 'BC',
  'Manitoba': 'MB',
  'New Brunswick': 'NB',
  'Newfoundland and Labrador': 'NL',
  'Northwest Territories': 'NT',
  'Nova Scotia': 'NS',
  'Nunavut': 'NU',
  'Ontario': 'ON',
  'Prince Edward Island': 'PE',
  'Quebec': 'QC',
  'Saskatchewan': 'SK',
  'Yukon': 'YT',
};

const work = mkdtempSync(join(tmpdir(), 'citybuild-'));
const fetchTo = (name) => {
  execFileSync('curl', ['-sSL', '--fail',
    `https://download.geonames.org/export/dump/${name}`, '-o', join(work, name)],
    { stdio: 'inherit' });
};

try {
  console.log('→ downloading GeoNames tables');
  // cities1000 is a superset of cities5000; one download covers both the main
  // set and the small towns used to fill zones that have nothing over the floor.
  fetchTo('cities1000.zip');
  fetchTo('admin1CodesASCII.txt');
  fetchTo('countryInfo.txt');
  execFileSync('unzip', ['-o', '-q', join(work, 'cities1000.zip'), '-d', work]);

  // admin1 code -> region label, already abbreviated where we have one
  const regionByCode = new Map();
  for (const line of readFileSync(join(work, 'admin1CodesASCII.txt'), 'utf8').split('\n')) {
    const [code, name] = line.split('\t');
    if (!code || !name) continue;
    const [country] = code.split('.');
    const short = country === 'US' ? code.split('.')[1] : CA_ABBREV[name];
    regionByCode.set(code, short ?? name);
  }

  const countryByCode = new Map();
  for (const line of readFileSync(join(work, 'countryInfo.txt'), 'utf8').split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue;
    const f = line.split('\t');
    if (f[0] && f[4]) countryByCode.set(f[0], f[4]);
  }

  console.log(`→ filtering to population >= ${MIN_POP}`);
  const parsed = [];
  for (const line of readFileSync(join(work, 'cities1000.txt'), 'utf8').split('\n')) {
    const f = line.split('\t');
    if (f.length < 18) continue;
    const tzid = f[17];
    if (!tzid) continue;
    if (f[7] === 'PPLX') continue;   // a section of a place, not a place

    const countryCode = f[8];
    const region = regionByCode.get(`${countryCode}.${f[10]}`) ?? '';
    const country = countryByCode.get(countryCode) ?? countryCode;
    parsed.push({
      name: f[1],
      label: region && region !== country ? `${region}, ${country}` : country,
      tzid,
      population: Number(f[14]) || 0,
      lat: Number(f[4]),
      lon: Number(f[5]),
    });
  }

  // GeoNames repeats places (a city and its administrative seat, older records).
  // Keyed on name+region+zone the duplicates are indistinguishable in the UI, so
  // keep the most populous and drop the rest.
  const best = new Map();
  const add = (city) => {
    const key = `${city.name}|${city.label}|${city.tzid}`;
    const previous = best.get(key);
    if (!previous || previous.population < city.population) best.set(key, city);
  };
  for (const city of parsed) if (city.population >= MIN_POP) add(city);

  // Fill zones that have nothing over the floor with their largest town, so
  // "nearest place in your own zone" can answer in Dawson, Atikokan, Fort Nelson.
  const covered = new Set([...best.values()].map((c) => c.tzid));
  const largestInGap = new Map();
  for (const city of parsed) {
    if (covered.has(city.tzid)) continue;
    const previous = largestInGap.get(city.tzid);
    if (!previous || previous.population < city.population) largestInGap.set(city.tzid, city);
  }
  for (const city of largestInGap.values()) add(city);
  console.log(`  filled ${largestInGap.size} zones that had no town over ${MIN_POP}`);

  // Population order is the search ranking: for a given match quality the
  // bigger place is nearly always the one being looked for.
  const cities = [...best.values()].sort((a, b) => b.population - a.population);

  const zones = [...new Set(cities.map((c) => c.tzid))].sort();
  const labels = [...new Set(cities.map((c) => c.label))].sort();

  // Mean position of each region's cities, so search can rank by how near a
  // place is to the user. Per-city coordinates would cost ~152 KB gzipped;
  // these 3,190 region centroids cost ~15 KB and, on every case tested,
  // produce the same ordering — states and provinces are small enough that a
  // city is well approximated by the middle of the one it sits in.
  const centroid = new Map();
  for (const city of cities) {
    const acc = centroid.get(city.label) ?? { lat: 0, lon: 0, n: 0 };
    acc.lat += city.lat; acc.lon += city.lon; acc.n += 1;
    centroid.set(city.label, acc);
  }
  const zoneIndex = new Map(zones.map((z, i) => [z, i]));
  const labelIndex = new Map(labels.map((l, i) => [l, i]));

  // Offsets are taken from the centroid *as the client will read it back* —
  // rounded to hundredths — so decoding reproduces the intended position rather
  // than accumulating the centroid's own rounding error.
  const roundedCentroid = (label) => {
    const acc = centroid.get(label);
    return {
      lat: Math.round((acc.lat / acc.n) * 100) / 100,
      lon: Math.round((acc.lon / acc.n) * 100) / 100,
    };
  };

  // Parallel arrays rather than an array of objects: the field names would
  // otherwise repeat 69,000 times. Names are folded for matching at runtime —
  // shipping a prebuilt folded copy nearly doubles the gzipped size, and only
  // 19% of names have diacritics at all.
  const payload = {
    v: 1,
    minPopulation: MIN_POP,
    z: zones,
    r: labels,
    n: cities.map((c) => c.name).join('\n'),
    ri: cities.map((c) => labelIndex.get(c.label)).join(','),
    zi: cities.map((c) => zoneIndex.get(c.tzid)).join(','),
    // Region centroids, hundredths of a degree, as "lat,lon" pairs in `r` order.
    ra: labels.flatMap((label) => {
      const acc = centroid.get(label);
      return [Math.round((acc.lat / acc.n) * 100), Math.round((acc.lon / acc.n) * 100)];
    }).join(','),
    // City positions to 0.01 degree (~1.1 km), stored as an offset from the
    // city's region centroid. The offsets are small numbers, which gzip handles
    // far better than absolute coordinates — 176 KB rather than 299 KB — and
    // 0.01 degree picks the correct nearest town 96% of the time, the misses
    // being ties where the runner-up is under half a kilometre further. A
    // coarser 0.1 degree saves 67 KB but names the wrong town 39% of the time.
    la: cities.map((c) => Math.round((c.lat - roundedCentroid(c.label).lat) * 100)).join(','),
    lo: cities.map((c) => Math.round((c.lon - roundedCentroid(c.label).lon) * 100)).join(','),
  };

  if (payload.ra.split(',').length !== labels.length * 2) {
    throw new Error('region centroid list is out of step with the region list');
  }
  for (const key of ['la', 'lo']) {
    if (payload[key].split(',').length !== cities.length) {
      throw new Error(`${key} is out of step with the city list`);
    }
  }
  // Decoding must land within the quantisation step of the true position.
  for (const city of [cities[0], cities[cities.length - 1]]) {
    const anchor = roundedCentroid(city.label);
    const back = {
      lat: anchor.lat + Math.round((city.lat - anchor.lat) * 100) / 100,
      lon: anchor.lon + Math.round((city.lon - anchor.lon) * 100) / 100,
    };
    if (Math.abs(back.lat - city.lat) > 0.005001 || Math.abs(back.lon - city.lon) > 0.005001) {
      throw new Error(`coordinate round-trip drifted for ${city.name}`);
    }
  }
  if (payload.n.split('\n').length !== cities.length) {
    throw new Error('a city name contains a newline; the blob encoding would desync');
  }
  for (const [name, expected] of [['Nelson', 'America/Vancouver'], ['Creston', 'America/Creston']]) {
    const found = cities.find((c) => c.name === name && c.label.startsWith('BC'));
    if (!found) throw new Error(`sanity check failed: ${name}, BC missing`);
    if (found.tzid !== expected) {
      throw new Error(`sanity check failed: ${name}, BC resolved to ${found.tzid}, expected ${expected}`);
    }
  }

  const json = JSON.stringify(payload);
  writeFileSync(OUT, json);
  console.log(`✓ ${OUT}`);
  console.log(`  ${cities.length} cities, ${zones.length} zones, ${labels.length} regions`);
  console.log(`  ${(statSync(OUT).size / 1024).toFixed(0)} KB raw, ` +
              `${(gzipSync(json, { level: 9 }).length / 1024).toFixed(0)} KB gzipped`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
