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

import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

// The roster as committed to the repo. Always consulted for known IMOs even when
// --out points elsewhere: it is the table's source of truth, and a hull's IMO
// never changes, so anything we have ever recorded stays valid.
const COMMITTED_ROSTER = join(import.meta.dirname, '..', 'public', 'ships.json');

const OUT = arg('out', COMMITTED_ROSTER);

// No app key: the fleet endpoint answers 200 without one. Verified against the
// live API — only /v3/ships/{code}/time requires a key (401 COMMONS-0001), while
// /v2/ships and /v3/ships/{code}/voyages are open. Worth keeping this script
// keyless so regenerating the roster needs no secret at all.
//
// RCCL_APPKEY is still honoured in case that changes.

// `all` returns both brands in one call; the per-ship `brand` field is what we
// key on afterwards.
const FLEET_URL = 'https://api.rccl.com/en/all/mobile/v2/ships?sort=name';

// CruiseMapper's live-position feed, used here only to learn each ship's IMO
// number. RCCL's fleet payload has 18 fields and neither of the two identifiers
// the rest of the world uses, so this is the bridge — see src/shiptrack.ts.
//
// filter=2,10 is Royal Caribbean plus Celebrity. The values are cruise-line
// indices and do NOT match the `ship_line_id` in the payload (where Royal is 1);
// they were enumerated against the live endpoint. filter is mandatory: omit it
// and the response is an empty array rather than an error.
const POSITIONS_URL =
  'https://www.cruisemapper.com/map/ships.json' +
  '?minLat=-80&maxLat=80&minLon=-180&maxLon=180&zoom=2&filter=2,10';

/**
 * Both headers are load-bearing, and the failure mode of omitting either is
 * nasty enough to spell out:
 *
 *   - no browser User-Agent  -> 403 with an Apache error page
 *   - no X-Requested-With    -> 200 with an EMPTY body and text/html
 *
 * The second one is the dangerous one. It is not an error by any status-code
 * measure, so anything checking `response.ok` sees success and reads nothing.
 */
const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'x-requested-with': 'XMLHttpRequest',
  accept: 'application/json, text/javascript, */*; q=0.01',
};

/** Loose enough to survive "Star Of The Seas" vs "Star of the Seas". */
function normName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * IMO check digit: the 7th digit is a weighted sum of the first six. Cheap, and
 * it catches the failure this bridge is actually prone to — a name matched to
 * the wrong vessel, or a transposed number pasted in by hand. Verified against
 * all 45 vessels in the live feed.
 */
function validImo(imo) {
  if (!/^[0-9]{7}$/.test(imo)) return false;
  let sum = 0;
  for (let i = 0; i < 6; i++) sum += Number(imo[i]) * (7 - i);
  return sum % 10 === Number(imo[6]);
}

/**
 * Ship name -> IMO, from the live feed. Never throws: a build must not fail
 * because a third party is down, since every IMO we already know is committed
 * and the previous file is the fallback.
 *
 * Note the feed leaves `ship_name` empty and carries the name in `hover`.
 */
async function fetchImoByName() {
  const found = new Map();
  try {
    console.log('→ fetching IMO numbers from cruisemapper.com');
    const response = await fetch(POSITIONS_URL, { headers: BROWSER_HEADERS });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const markers = await response.json();
    if (!Array.isArray(markers)) throw new Error('expected an array of markers');
    for (const marker of markers) {
      const name = normName(marker?.hover ?? '');
      const imo = String(marker?.imo ?? '');
      if (name && validImo(imo)) found.set(name, imo);
    }
    console.log(`  ${found.size} vessels with a valid IMO`);
  } catch (err) {
    // Deliberately a warning. The committed IMOs carry the build.
    console.warn(`  ! position feed unavailable (${err.message}) — reusing known IMOs`);
  }
  return found;
}

/**
 * IMOs from the file we are about to overwrite, keyed brand/code.
 *
 * This is what makes the table monotonic. A vessel in dry dock has no AIS
 * marker and so drops out of the feed entirely, and an IMO never changes for a
 * hull — so a ship that has ever been seen keeps its number forever.
 */
function readKnownImos(...paths) {
  const known = new Map();
  // Later paths win, so callers pass least- to most-authoritative.
  for (const path of paths) {
    if (!path || !existsSync(path)) continue;
    try {
      const previous = JSON.parse(readFileSync(path, 'utf8'));
      for (const ship of previous?.ships ?? []) {
        if (ship.imo) known.set(`${ship.brand}/${ship.code}`, ship.imo);
      }
    } catch {
      /* unreadable is the same as absent */
    }
  }
  return known;
}

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

  // Identity for the map layers. Fetched here rather than at runtime because a
  // hull's IMO never changes, so there is nothing to keep fresh — and because
  // the runtime must never depend on name matching.
  const liveImos = await fetchImoByName();
  const knownImos = readKnownImos(COMMITTED_ROSTER, OUT);

  const ships = sailing
    .map((s) => {
      const name = tidyName(s.name);
      const key = `${s.brand}/${String(s.shipCode).toUpperCase()}`;
      return {
        code: String(s.shipCode).toUpperCase(),
        brand: s.brand,
        name,
        short: shortName(name),
        imo: liveImos.get(normName(name)) ?? knownImos.get(key) ?? null,
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

  // --- IMO coverage ---
  //
  // A missing IMO is a warning, not an error: the ship still keeps time, it just
  // gets no position on the map. Losing one we already had IS an error, because
  // that silently removes a working map layer.
  const withImo = ships.filter((s) => s.imo);
  const missing = ships.filter((s) => !s.imo).map((s) => `${s.brand}/${s.code} ${s.name}`);
  if (missing.length) {
    console.warn(`  ! ${missing.length} without an IMO (no map layer): ${missing.join(', ')}`);
  }
  for (const ship of ships) {
    const key = `${ship.brand}/${ship.code}`;
    if (!ship.imo && knownImos.has(key)) {
      throw new Error(`${key} lost its IMO ${knownImos.get(key)} — refusing to regress the table`);
    }
    if (ship.imo && !validImo(ship.imo)) {
      throw new Error(`${key}: IMO ${ship.imo} fails its check digit (wrong vessel matched?)`);
    }
    const was = knownImos.get(key);
    if (was && ship.imo !== was) {
      // An IMO is fixed for the life of a hull, so this means the name matched a
      // different vessel — exactly what the check digit cannot catch.
      throw new Error(`${key}: IMO changed ${was} -> ${ship.imo}; a hull's IMO never changes`);
    }
  }
  const imoOwners = new Map();
  for (const ship of withImo) {
    const key = `${ship.brand}/${ship.code}`;
    if (imoOwners.has(ship.imo)) {
      throw new Error(`IMO ${ship.imo} claimed by both ${imoOwners.get(ship.imo)} and ${key}`);
    }
    imoOwners.set(ship.imo, key);
  }

  // Named canaries, matching the sibling generators' habit: one Royal ship whose
  // short name is known to collide with a real city, and one Celebrity.
  const canaries = [
    { key: 'R/ST', name: 'Star of the Seas', short: 'Star', imo: '9829942' },
    { key: 'R/ID', name: 'Independence of the Seas', short: 'Independence' },
    { key: 'C/AX', name: 'Celebrity Apex', short: 'Apex' },
  ];
  for (const want of canaries) {
    const found = ships.find((s) => `${s.brand}/${s.code}` === want.key);
    if (!found) throw new Error(`sanity check failed: ${want.key} missing from the roster`);
    if (want.imo && found.imo !== want.imo) {
      throw new Error(`sanity check failed: ${want.key} IMO is ${found.imo}, expected ${want.imo}`);
    }
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
  console.log(`  ${withImo.length}/${ships.length} with an IMO for the map layers`);
  console.log(`  ${(statSync(OUT).size / 1024).toFixed(1)} KB`);
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
