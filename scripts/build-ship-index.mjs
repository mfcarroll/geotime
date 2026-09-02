#!/usr/bin/env node
// Builds public/ships.json — the cruise-ship roster for ship-time search.
//
// Ship time is not derivable from position: the crew sets the onboard clock and
// shifts it mid-cruise to suit the next port. Resolving it needs a live API call
// per ship, but *finding* a ship by name does not — so the roster is bundled and
// the offsets are fetched on demand.
//
//   node scripts/build-ship-index.mjs [--out PATH]
//
// Bundling rather than fetching at runtime is what makes search work at all in
// the places it matters. api.rccl.com sends no CORS headers, so the browser build
// can never call it; and a guest opening the app for the first time aboard, or
// with no data ashore, still needs to find their ship. A stale roster costs
// nothing — a missing ship is a wall — hence bundled floor plus weekly runtime
// refresh (see src/ships.ts).
//
// Deliberately NOT compacted the way build-city-index.mjs is. That file packs
// 63,493 cities into parallel arrays because it is 1.8 MB; this one is 45 rows
// and ~4 KB, where the parallel-array trick would buy nothing and cost the
// ability to read the file.
//
// Requires network. No build dependencies — plain Node.

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const OUT = arg('out', join(import.meta.dirname, '..', 'public', 'ships.json'));

// No app key: the fleet endpoint answers 200 without one. Verified against the
// live API — only /v3/ships/{code}/time requires a key (401 COMMONS-0001), while
// /v2/ships and /v3/ships/{code}/voyages are open. Worth keeping this script
// keyless so regenerating the roster needs no secret at all.
//
// RCCL_APPKEY is still honoured in case that changes.

// `all` returns both brands in one call; the per-ship `brand` field is what we
// key on afterwards.
const FLEET_URL = 'https://api.rccl.com/en/all/mobile/v2/ships?sort=name';

/**
 * The name to show on a clock row, as opposed to the one people search for.
 *
 * Every Royal vessel ends in "of the Seas" and every Celebrity one starts with
 * "Celebrity", so those words distinguish nothing in a list where a ship icon
 * already says these are ships. They also cost real layout: the widget derives
 * one uniform city font that fits *every* row, so "Independence of the Seas"
 * at 24 characters would shrink the type on every other row.
 */
function shortName(name) {
  const stripped = name
    .replace(/\s+of\s+the\s+Seas$/i, '')
    .replace(/^Celebrity\s+/i, '')
    .trim();
  return stripped || name;
}

/**
 * Ships appear in the roster before they sail, and the pre-launch rows arrive
 * shouting — "HERO OF THE SEAS". Those are filtered out on currentSailDate, but
 * title-case anything that slips through so a future one can't ship a row in
 * caps.
 */
function tidyName(name) {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (trimmed !== trimmed.toUpperCase()) return trimmed;   // already mixed case
  return trimmed.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
    // "Of The Seas" -> "of the Seas"
    .replace(/\bOf\b/g, 'of').replace(/\bThe\b/g, 'the');
}

async function fetchFleet() {
  console.log(`→ fetching fleet from api.rccl.com`);
  const appkey = process.env.RCCL_APPKEY;
  const response = await fetch(FLEET_URL, {
    headers: {
      ...(appkey ? { appkey } : {}),
      accept: 'application/json',
      platform: 'android',
      appversion: '1.80.0',
    },
  });
  if (!response.ok) {
    throw new Error(`fleet request failed: ${response.status} ${response.statusText}`);
  }
  const body = await response.json();
  const ships = body?.payload?.ships;
  if (!Array.isArray(ships)) throw new Error('response had no payload.ships array');
  return ships;
}

async function main() {
  const raw = await fetchFleet();
  console.log(`  ${raw.length} vessels in the payload`);

  // currentSailDate is the only field that actually discriminates: every row
  // reports status "A" and excaliburEnabled true, including ships years from
  // delivery. A vessel with no current sailing has no clock to ask about.
  const sailing = raw.filter((s) => s.currentSailDate);
  const dropped = raw.filter((s) => !s.currentSailDate).map((s) => s.name);
  if (dropped.length) console.log(`  dropped ${dropped.length} not yet sailing: ${dropped.join(', ')}`);

  const ships = sailing
    .map((s) => {
      const name = tidyName(s.name);
      return {
        code: String(s.shipCode).toUpperCase(),
        brand: s.brand,
        name,
        short: shortName(name),
      };
    })
    .sort((a, b) => a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name));

  // --- sanity checks: fail loudly rather than shipping a broken roster ---

  if (ships.length < 30) {
    throw new Error(`only ${ships.length} ships; expected at least 30 (payload shape changed?)`);
  }

  const brands = new Set(ships.map((s) => s.brand));
  for (const brand of ['R', 'C']) {
    if (!brands.has(brand)) throw new Error(`no ships for brand ${brand}`);
  }
  const unexpected = [...brands].filter((b) => b !== 'R' && b !== 'C');
  if (unexpected.length) {
    throw new Error(`unexpected brand code(s): ${unexpected.join(', ')} — src/ships.ts only knows R and C`);
  }

  // The key is brand+code, because a 2-letter code is only unique within a
  // brand. Assert it, so a future collision surfaces here and not as two ships
  // sharing one clock.
  const keys = new Set();
  for (const ship of ships) {
    if (!/^[A-Z]{2}$/.test(ship.code)) throw new Error(`${ship.name}: odd ship code ${ship.code}`);
    const key = `${ship.brand}/${ship.code}`;
    if (keys.has(key)) throw new Error(`duplicate ship key ${key}`);
    keys.add(key);
    if (!ship.short) throw new Error(`${ship.name}: empty short name`);
  }

  // Named canaries, matching the sibling generators' habit: one Royal ship whose
  // short name is known to collide with a real city, and one Celebrity.
  const canaries = [
    { key: 'R/ST', name: 'Star of the Seas', short: 'Star' },
    { key: 'R/ID', name: 'Independence of the Seas', short: 'Independence' },
    { key: 'C/AX', name: 'Celebrity Apex', short: 'Apex' },
  ];
  for (const want of canaries) {
    const found = ships.find((s) => `${s.brand}/${s.code}` === want.key);
    if (!found) throw new Error(`sanity check failed: ${want.key} missing from the roster`);
    if (found.name !== want.name || found.short !== want.short) {
      throw new Error(
        `sanity check failed: ${want.key} is "${found.name}"/"${found.short}", ` +
        `expected "${want.name}"/"${want.short}"`
      );
    }
  }

  // No generated-at timestamp on purpose. Every push rebuilds, and a timestamp
  // would churn the committed file on every build; the runtime prefers a cached
  // API copy over the bundle by construction, so it needs no version to compare.
  writeFileSync(OUT, JSON.stringify({ v: 1, ships }) + '\n');

  const byBrand = { R: 0, C: 0 };
  for (const s of ships) byBrand[s.brand]++;
  console.log(`✓ ${OUT}`);
  console.log(`  ${ships.length} ships (${byBrand.R} Royal, ${byBrand.C} Celebrity)`);
  console.log(`  ${(statSync(OUT).size / 1024).toFixed(1)} KB`);
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
