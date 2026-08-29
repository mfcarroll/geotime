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
  fetchTo('cities5000.zip');
  fetchTo('admin1CodesASCII.txt');
  fetchTo('countryInfo.txt');
  execFileSync('unzip', ['-o', '-q', join(work, 'cities5000.zip'), '-d', work]);

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
  // GeoNames repeats places (a city and its administrative seat, boroughs, older
  // records). Keyed on name+region+zone, the duplicates are indistinguishable in
  // the UI, so keep the most populous and drop the rest.
  const best = new Map();
  for (const line of readFileSync(join(work, 'cities5000.txt'), 'utf8').split('\n')) {
    const f = line.split('\t');
    if (f.length < 18) continue;
    const population = Number(f[14]) || 0;
    const tzid = f[17];
    if (population < MIN_POP || !tzid) continue;

    const name = f[1];
    const countryCode = f[8];
    const region = regionByCode.get(`${countryCode}.${f[10]}`) ?? '';
    const country = countryByCode.get(countryCode) ?? countryCode;
    const label = region && region !== country ? `${region}, ${country}` : country;

    const key = `${name}|${label}|${tzid}`;
    const previous = best.get(key);
    if (!previous || previous.population < population) {
      best.set(key, { name, label, tzid, population });
    }
  }

  // Population order is the search ranking: for a given match quality the
  // bigger place is nearly always the one being looked for.
  const cities = [...best.values()].sort((a, b) => b.population - a.population);

  const zones = [...new Set(cities.map((c) => c.tzid))].sort();
  const labels = [...new Set(cities.map((c) => c.label))].sort();
  const zoneIndex = new Map(zones.map((z, i) => [z, i]));
  const labelIndex = new Map(labels.map((l, i) => [l, i]));

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
  };

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
