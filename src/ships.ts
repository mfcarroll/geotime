// src/ships.ts
//
// The ship roster, and the clock records built from it.
//
// A ship is deliberately NOT modelled as a timezone id. The 1.3.0 restructure
// existed to establish one invariant — every entry in `addedTimezones` is a real
// IANA zone, with no hand-written offset parser between the id and the platform
// — and a synthetic `ship:R/ST` id would walk straight back into the
// `Etc/GMT±N.N` trap it removed (Intl throws, Swift returns nil, Java silently
// returns GMT+0). It would also solve nothing: a ship id carries no offset, so a
// sidecar table would be needed anyway, with three parsers on top.
//
// So ships live in their own collection, with the fields a ship actually has.
// The offset only becomes a timezone at the very edge — the widget bridge turns
// it into a fixed-offset zone, which is correct for a vessel in any case, since
// a ship's clock has no DST rules.

import { fold } from './utils';
import { fetchFleet, fetchShipTime, shipTimeAvailable, type Environment } from './rccl';

/** A vessel, as the roster knows it. */
export interface ShipRef {
  /** 2-letter RCCL code, unique only within a brand. */
  code: string;
  /** 'R' Royal Caribbean, 'C' Celebrity. */
  brand: 'R' | 'C';
  /** Full name, as people search for it: "Independence of the Seas". */
  name: string;
  /** Name for a clock row: "Independence". See build-ship-index.mjs. */
  short: string;
  /**
   * IMO number — the permanent identifier for a hull, and the only key the
   * position/track/route source accepts. Generated at build time; see
   * build-ship-index.mjs and src/shiptrack.ts.
   *
   * Optional on purpose, and it must stay that way. A vessel too new to have
   * been seen by the position feed has no IMO, and a roster stored by an earlier
   * version has none for anybody — making this required would reject those
   * entries wholesale and empty the ship list. Absent simply means no map layer.
   */
  imo?: string | null;
}

/** A ship on the user's clock list, with whatever we last learned about it. */
export interface ShipClock extends ShipRef {
  /** Hours from UTC; null until first resolved. */
  offsetHours: number | null;
  /**
   * When the offset was last confirmed, epoch ms.
   *
   * Never displayed. An app whose subject is times already shows three clocks on
   * one card, and a fourth number that is not a current time invites exactly the
   * misreading you least want. Kept so the behaviour stays diagnosable without a
   * data migration, and because staleness — if it is ever signalled at all — is
   * signalled non-numerically.
   */
  fetchedAt: number | null;
  /** Origin of the value, e.g. "EFC", "DMT". Diagnostics only. */
  source: string | null;
  /** True when the crew has manually forced the clock. */
  overrideActive: boolean;
  /** True when detection added this, rather than the user searching for it. */
  autoAdded: boolean;
  /**
   * Last day of the voyage that was active when this ship was detected,
   * `yyyyMMdd`. Null for a ship the user added by hand.
   *
   * Bounds the background offset re-check. Pinning the *specific* voyage matters
   * because ships sail continuously — "this ship has an active voyage" is true
   * essentially forever, while "the voyage you boarded" ends. A manually added
   * ship has no such bound: adding it is a standing request to keep it right,
   * and removing the row is the off switch.
   */
  voyageEnd: string | null;
}

/** Ships are keyed by brand and code together: "R/ST". */
export function shipKey(ship: { brand: string; code: string }): string {
  return `${ship.brand}/${ship.code}`;
}

/** The stored shape of the roster asset. */
interface ShipRoster {
  v: number;
  ships: ShipRef[];
}

const ROSTER_CACHE_KEY = 'shipRoster';
const ROSTER_FETCHED_KEY = 'shipRosterFetchedAt';
const ROSTER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let rosterPromise: Promise<ShipRef[]> | null = null;

/**
 * The roster as last resolved, readable synchronously.
 *
 * Exists because the search box takes getters rather than values — a GPS fix or
 * a roster refresh can land after the box is already open. Handing it a captured
 * array would quietly turn that late binding into a snapshot.
 */
let roster: ShipRef[] = [];

/** The loaded roster, or [] before it arrives. See `roster`. */
export function shipRosterNow(): ShipRef[] {
  return roster;
}

function isShipRef(value: any): value is ShipRef {
  return value
    && typeof value.code === 'string' && /^[A-Z]{2}$/.test(value.code)
    && (value.brand === 'R' || value.brand === 'C')
    && typeof value.name === 'string' && value.name.length > 0
    && typeof value.short === 'string' && value.short.length > 0
    // Present-and-wrong is a bad record; absent is a ship without a map layer.
    && (value.imo == null || /^[0-9]{7}$/.test(value.imo));
}

/**
 * brand/code -> IMO, from the file bundled at build time.
 *
 * The bundle is the only runtime source of IMOs: the RCCL fleet endpoint the
 * roster refresh calls does not carry them, so a refresh has to merge them back
 * in from here or they are lost. Memoised — the asset is immutable per build.
 */
let bundledImoPromise: Promise<Map<string, string>> | null = null;

function bundledImos(): Promise<Map<string, string>> {
  bundledImoPromise ??= (async () => {
    try {
      const response = await fetch('ships.json');
      if (!response.ok) throw new Error(`ships.json: ${response.status}`);
      const parsed = (await response.json()) as ShipRoster;
      const found = new Map<string, string>();
      for (const ship of parsed?.ships ?? []) {
        if (ship.imo) found.set(shipKey(ship), ship.imo);
      }
      return found;
    } catch {
      return new Map<string, string>();
    }
  })();
  return bundledImoPromise;
}

/**
 * A ship's IMO, resolved from the roster rather than from anything stored.
 *
 * Deliberately not read off a stored ShipClock. One source of truth means no
 * store migration when a ship gains an IMO, and a clock saved before this
 * feature existed picks one up the moment the roster has it.
 */
export function shipImo(key: string): string | null {
  return roster.find((ship) => shipKey(ship) === key)?.imo ?? null;
}

function readCachedRoster(): ShipRef[] | null {
  try {
    const raw = localStorage.getItem(ROSTER_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const ships = Array.isArray(parsed?.ships) ? parsed.ships.filter(isShipRef) : [];
    return ships.length > 0 ? ships : null;
  } catch {
    return null;
  }
}

/**
 * The roster: cached copy if there is one, else the copy bundled at build time.
 *
 * A cached copy always wins, with no version comparison, because it was fetched
 * from the API and is therefore newer than the build by construction. That also
 * means the bundled file needs no timestamp — see build-ship-index.mjs.
 */
export function loadShipRoster(): Promise<ShipRef[]> {
  rosterPromise ??= (async () => {
    // Ship features are hidden entirely where their offsets cannot be resolved
    // — the production web build, per finding 01. Offering a searchable ship
    // that then shows no time is worse than not offering it: it looks broken
    // rather than absent.
    if (!shipTimeAvailable()) return [];

    const cached = readCachedRoster();
    if (cached) return cached;
    try {
      const response = await fetch('ships.json');
      if (!response.ok) throw new Error(`ships.json: ${response.status}`);
      const roster = (await response.json()) as ShipRoster;
      const ships = Array.isArray(roster?.ships) ? roster.ships.filter(isShipRef) : [];
      if (ships.length === 0) throw new Error('ships.json had no usable entries');
      return ships;
    } catch (err) {
      // Ship search stops working; nothing else does.
      console.warn('Could not load the ship roster:', err);
      return [];
    }
  })().then((ships) => {
    roster = ships;
    return ships;
  });
  return rosterPromise;
}

/**
 * Refreshes the roster from the API when the cached copy is a week old.
 *
 * New vessels arrive perhaps twice a year, so this is not about freshness so
 * much as not needing an app release to support a ship that launched. Silent on
 * failure: the bundled copy is the floor, so a user who is never online is no
 * worse off than the last release left them.
 *
 * Returns the environment that came back with the request, since detection rides
 * whatever call is being made anyway.
 */
export async function refreshShipRoster(
  force = false
): Promise<{ ships: any[] | null; env: Environment } | null> {
  if (!shipTimeAvailable()) return null;

  // `force` is for the cold probe, which needs a stamped response *now* rather
  // than a fresh roster. It bypasses the weekly cache age only — the caller
  // applies its own, much shorter throttle, so the two concerns stay separate.
  const fetchedAt = Number(localStorage.getItem(ROSTER_FETCHED_KEY) || 0);
  if (!force && Date.now() - fetchedAt < ROSTER_MAX_AGE_MS) return null;

  const result = await fetchFleet();
  if (!result?.ships) return result ?? null;

  // The fleet endpoint carries no IMO, so without this merge every refresh would
  // write an IMO-less roster over the bundled one — and since a cached roster
  // wins unconditionally, the map layers would go dark a week after install with
  // nothing in the logs. Bundle first, then whatever the previous cache knew, so
  // neither a missing asset nor a missing bundle entry can strip the table.
  const imos = await bundledImos();
  const cachedImos = new Map(
    (readCachedRoster() ?? []).filter((s) => s.imo).map((s) => [shipKey(s), s.imo!])
  );

  const ships = result.ships
    .filter((s: any) => s.currentSailDate)     // not yet sailing: no clock to ask about
    .map((s: any) => {
      const name = String(s.name).trim().replace(/\s+/g, ' ');
      const key = `${s.brand}/${String(s.shipCode).toUpperCase()}`;
      return {
        code: String(s.shipCode).toUpperCase(),
        brand: s.brand,
        name,
        short: name.replace(/\s+of\s+the\s+Seas$/i, '').replace(/^Celebrity\s+/i, '').trim() || name,
        imo: imos.get(key) ?? cachedImos.get(key) ?? null,
      };
    })
    .filter(isShipRef)
    .sort((a, b) => a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name));

  // Guard against a shape change turning the roster into a stub. The bundled
  // file asserts at least 30; anything far below that is a bad payload, not a
  // shrinking fleet.
  if (ships.length < 30) {
    console.warn(`Ignoring ship roster refresh: only ${ships.length} usable entries`);
    return result;
  }

  localStorage.setItem(ROSTER_CACHE_KEY, JSON.stringify({ v: 1, ships }));
  localStorage.setItem(ROSTER_FETCHED_KEY, String(Date.now()));
  rosterPromise = Promise.resolve(ships);
  roster = ships;
  return result;
}

/**
 * Ship name matches, split into the same three tiers the place search uses:
 * whole-string equality, then prefix, then anywhere.
 *
 * Ships are matched on the short name, the full name and the 2-letter code, so
 * "independence", "independence of the seas" and "ID" all find the same vessel.
 * Tiering matters because ship names collide with real cities — "Independence"
 * matches six of them, including one of 120,000 people — and the collision has
 * to be visible rather than silently resolved. The caller interleaves these with
 * city and zone tiers, and always renders a ship with its own icon.
 *
 * Ordered alphabetically within a tier. There is deliberately no distance
 * ranking: ships move, so the roster has no position to rank by.
 */
export function matchShipTiers(query: string, roster: ShipRef[]): ShipRef[][] {
  const q = fold(query.trim());
  const tiers: ShipRef[][] = [[], [], []];
  if (!q) return tiers;

  for (const ship of roster) {
    const short = fold(ship.short);
    const full = fold(ship.name);

    if (short === q || full === q || fold(ship.code) === q) tiers[0].push(ship);
    else if (short.startsWith(q) || full.startsWith(q)) tiers[1].push(ship);
    else if (full.includes(q)) tiers[2].push(ship);
  }

  for (const tier of tiers) tier.sort((a, b) => a.name.localeCompare(b.name));
  return tiers;
}

/** Builds a fresh clock record for a ship the user just picked. */
export function newShipClock(ship: ShipRef, autoAdded = false): ShipClock {
  return {
    ...ship,
    offsetHours: null,
    fetchedAt: null,
    source: null,
    overrideActive: false,
    autoAdded,
    voyageEnd: null,
  };
}

/**
 * Asks the API for a ship's current offset and returns an updated record.
 *
 * On failure the existing record is returned untouched, so a stored offset
 * survives being offline — which is the whole point of storing it. Ashore in a
 * port with no data, the last known offset is what tells someone when to be back
 * aboard, and it is almost always still correct: clocks shift overnight, and the
 * device is on the ship's wi-fi daily.
 */
export async function resolveShipClock(
  clock: ShipClock
): Promise<{ clock: ShipClock; env: Environment } | null> {
  const result = await fetchShipTime(clock);
  if (!result) return null;
  if (!result.time) return { clock, env: result.env };

  return {
    clock: {
      ...clock,
      offsetHours: result.time.offsetHours,
      fetchedAt: Date.now(),
      source: result.time.source,
      overrideActive: result.time.overrideActive,
    },
    env: result.env,
  };
}
