// src/rccl.ts
//
// Client for the Royal Caribbean / Celebrity mobile API, used for one thing:
// what time it is on a given ship. The endpoint map and header behaviour come
// from reverse-engineering their client; those notes are kept privately.
//
// Ship time is the only clock in this app that cannot be derived from position.
// The crew sets it and shifts it mid-cruise to suit the next port, so it has to
// be asked for. That does not weaken the app's premise — the premise is that
// *where you are* determines your zone, and a ship's clock is not a claim about
// where you are, it is a claim about what a vessel's clock reads.
//
// Three transports, because the same request is impossible in some places:
//   native  — CapacitorHttp, which bypasses CORS and returns response headers.
//   dev     — a same-origin Vite proxy (see vite.config.js).
//   web     — nothing. api.rccl.com sends no CORS headers, and exposes only
//             Server-Timing, so a production browser can neither call it nor
//             read environment-ship-code. Ship features are hidden there.

import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { noteServerTime } from './time';
import type { ShipRef } from './ships';

interface ShipTimePlugin {
  /** The static app key, held in native so it never reaches the web bundle. */
  appKey(): Promise<{ key: string }>;
}

const ShipTimeNative = registerPlugin<ShipTimePlugin>('ShipTime');

/** Lower-cased header map, so callers needn't guess at casing. */
type Headers = Record<string, string>;

export interface RcclResponse {
  status: number;
  data: any;
  headers: Headers;
}

export interface ShipTimeResult {
  /** Hours from UTC; may be fractional. Ship local time = UTC + this. */
  offsetHours: number;
  /** Where the value came from, e.g. "EFC", "DMT". Observed to vary by ship. */
  source: string | null;
  /** True when the crew has manually forced the clock. */
  overrideActive: boolean;
}

export interface Environment {
  /** "ship" aboard, "shore" otherwise, null when nothing answered. */
  marker: 'ship' | 'shore' | null;
  /** The 2-letter code of the ship whose network we are on, else null. */
  shipCode: string | null;
  /**
   * The onboard gateway's wall-clock string, e.g. "3:45 PM".
   *
   * Recorded, never parsed. Deriving an offset from it would mean subtracting
   * the device's own UTC — the one value this app exists because it cannot
   * trust — whereas utcTimezoneOffset is absolute. Kept only so diagnostics can
   * confirm or correct the API doc, whose onboard section is inferred from
   * decompiled code rather than seen on the wire.
   */
  shipTime: string | null;
}

/**
 * Where a browser build sends its requests, if anywhere.
 *
 * A Cloudflare Worker that mirrors the three paths the app uses and adds the
 * CORS headers `api.rccl.com` does not (see workers/rccl-proxy). Only the web
 * build uses it: native must go direct, because the proxy is unreachable from a
 * ship's own network — it sits behind the same paywall api.rccl.com sits in
 * front of.
 *
 * A URL, not a secret, so it is hardcoded as a default the same way the UTC
 * endpoint always was — the Worker is publicly reachable regardless, and its
 * origin allowlist is about not spending our key quota on someone else's site,
 * not about hiding the address. Overridable for a staging deploy. Set it to ''
 * and the web build simply has no ship features, which is the correct
 * degradation rather than a broken one.
 */
const PROXY_BASE: string =
  import.meta.env.VITE_RCCL_PROXY ?? 'https://geotime-rccl-proxy.matthew-carroll.workers.dev';

/** True when this platform could make the requests at all. */
function platformSupportsShipTime(): boolean {
  return Capacitor.isNativePlatform() || import.meta.env.DEV || !!PROXY_BASE;
}

let enabled = false;

/**
 * True when ship features should exist at all.
 *
 * Platform support is not enough: without the app key the one endpoint that
 * matters is a 401, so no ship's clock can ever be resolved. A searchable ship
 * that can never tell the time is worse than no feature — so the whole thing is
 * hidden rather than shown broken. That is the state of an un-injected build: a
 * fork, or a local build without the secret.
 *
 * Synchronous so the render path can gate on it; resolved once by initShipTime.
 * In development the key lives in the Vite proxy server-side, where the client
 * cannot see it, so dev is taken on trust and the proxy warns instead.
 */
export function shipTimeAvailable(): boolean {
  return enabled;
}

/** Resolves whether ship features are usable. Call once, before first render. */
export async function initShipTime(): Promise<boolean> {
  if (!platformSupportsShipTime()) return (enabled = false);
  // Off-native the key lives server-side — in the Vite dev proxy or in the
  // Worker — where the client cannot see it and does not need to.
  if (!Capacitor.isNativePlatform()) return (enabled = true);
  enabled = !!(await loadAppKey());
  if (!enabled) {
    console.warn('Ship time disabled: no app key in this build.');
  }
  return enabled;
}

let appKeyPromise: Promise<string | null> | null = null;

function loadAppKey(): Promise<string | null> {
  // In dev the proxy attaches the key server-side, so the client never has one.
  if (!Capacitor.isNativePlatform()) return Promise.resolve(null);
  appKeyPromise ??= ShipTimeNative.appKey()
    .then((r) => r.key || null)
    .catch((err) => {
      console.warn('ShipTime.appKey failed; ship features disabled:', err);
      return null;
    });
  return appKeyPromise;
}

/**
 * Onboard-simulation gateway, injected at build time and `null` in every build
 * but `--mode shiptest`. See shipGateway() in vite.config.js for the guards.
 */
declare const __SHIP_GATEWAY__: string | null;

function apiBase(): string {
  // Native talks to the real host through CapacitorHttp — it has to, since that
  // is the only thing that works from a ship. Dev goes same-origin through the
  // Vite proxy, which rewrites this prefix away. A production browser goes
  // through the Worker.
  if (Capacitor.isNativePlatform()) {
    // The one way to exercise the aboard path on a real device: native cannot
    // use the dev proxy's RCCL_SIM_SHIP, so a local stand-in for a ship's
    // gateway takes its place. Compiled out of every ordinary build.
    if (__SHIP_GATEWAY__) {
      console.warn(`[shiptest] ship time via ${__SHIP_GATEWAY__} — NOT api.rccl.com`);
      return __SHIP_GATEWAY__;
    }
    return 'https://api.rccl.com';
  }
  if (import.meta.env.DEV) return '/rccl-api';
  return PROXY_BASE.replace(/\/$/, '');
}

function lowerCaseKeys(headers: Record<string, string> | undefined): Headers {
  const out: Headers = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

/**
 * One GET against the API.
 *
 * Deliberately does not throw on a non-2xx status. The gateway stamps its
 * environment headers on *every* response it passes, including the 404 a bad
 * ship code produces and, per the API doc, whatever a paywall returns aboard —
 * so an error response can still carry the only thing we wanted from it.
 * Callers get the status and decide.
 */
async function request(path: string, requiresKey = false): Promise<RcclResponse | null> {
  if (!shipTimeAvailable()) return null;

  const url = `${apiBase()}${path}`;
  try {
    let response: RcclResponse;

    if (Capacitor.isNativePlatform()) {
      const key = await loadAppKey();
      // Only `/time` actually needs the key — verified against the live API:
      // the fleet list and the voyage list both answer 200 with no key at all,
      // while `/time` returns 401 COMMONS-0001. So the key is attached whenever
      // we have one, but its absence only blocks the one endpoint that requires
      // it. That deliberately narrows the blast radius: if the key is ever
      // rotated or blocked, ship *search*, the roster refresh and onboard
      // *detection* all keep working, and only the offset goes dark.
      if (requiresKey && !key) return null;
      const native = await CapacitorHttp.get({
        url,
        headers: {
          ...(key ? { appkey: key } : {}),
          accept: 'application/json',
          platform: Capacitor.getPlatform(),
          appversion: '1.80.0',
        },
        readTimeout: 15000,
        connectTimeout: 15000,
      });
      response = {
        status: native.status,
        data: native.data,
        headers: lowerCaseKeys(native.headers as Record<string, string>),
      };
    } else {
      const fetched = await fetch(url, { headers: { accept: 'application/json' } });
      const headers: Headers = {};
      fetched.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
      response = {
        status: fetched.status,
        data: await fetched.json().catch(() => null),
        headers,
      };
    }

    // Every response carries a server `date`. At sea that is a better UTC
    // reference than a round trip to Cloud Run, and it costs nothing because
    // the request was already being made.
    const serverDate = response.headers['date'];
    if (serverDate) {
      const parsed = Date.parse(serverDate);
      if (Number.isFinite(parsed)) noteServerTime(parsed);
    }

    return response;
  } catch (err) {
    // Offline, blocked, or a captive portal. Not an error worth surfacing: the
    // caller falls back to a stored offset, which is the designed behaviour.
    console.warn(`RCCL request failed (${path}):`, err);
    return null;
  }
}

/**
 * Which ship's network we are on, read from the gateway headers.
 *
 * Not its own request. The gateway stamps these on *everything* it passes, so
 * the environment is a property of any response rather than a separate
 * operation — detection rides whatever call was already being made, and there is
 * never a probe request whose only job is to read a header.
 *
 * A null marker means *unknown*, never "ashore". Absence of a signal is not
 * evidence of anything, and the interface treats it that way: nothing changes
 * state until a definite marker arrives.
 */
export function readEnvironment(headers: Headers): Environment {
  // Trimmed as well as case-folded. Everything about these headers is inferred
  // from decompiled bytecode, and this ships before anyone can see a real ship's
  // response — so a gateway that pads its values must not silently disable
  // detection for the one voyage we get. Trimming costs nothing and removes a
  // whole class of "safe but useless" outcome.
  const marker = (headers['environment-marker'] || '').trim().toLowerCase();
  const code = (headers['environment-ship-code'] || '').trim().toUpperCase();

  return {
    marker: marker === 'ship' ? 'ship' : marker === 'shore' ? 'shore' : null,
    // Shore responses say "none"; only a real 2-letter code counts.
    shipCode: /^[A-Z]{2}$/.test(code) ? code : null,
    shipTime: headers['ship-time'] || null,
  };
}

/**
 * The live UTC offset for a ship, plus the environment that came with it.
 *
 * `time` is null when the ship is unknown to the API (a 404 on a retired code)
 * while `env` may still be populated, because the error response is stamped
 * too. The whole result is null only when nothing answered at all.
 *
 * Note the ship's own brand is used in the path even though `all` also works —
 * if RCCL ever narrows that segment, a per-brand request keeps working.
 */
export async function fetchShipTime(
  ship: ShipRef
): Promise<{ time: ShipTimeResult | null; env: Environment } | null> {
  const response = await request(`/en/${ship.brand}/mobile/v3/ships/${ship.code}/time`, true);
  if (!response) return null;

  const env = readEnvironment(response.headers);
  if (response.status !== 200) return { time: null, env };

  const payload = response.data?.payload;
  const offset = Number(payload?.utcTimezoneOffset);
  // A ship at UTC+0 is legitimate, so only a non-finite value is a failure.
  if (!Number.isFinite(offset)) return { time: null, env };

  return {
    time: {
      offsetHours: offset,
      source: typeof payload.source === 'string' ? payload.source : null,
      overrideActive: payload?.override?.active === true,
    },
    env,
  };
}

/**
 * One raw probe, headers and all, for the diagnostics view.
 *
 * Returns the whole response rather than an interpretation, because the point of
 * the dump is to reveal what we did *not* know to look for — the onboard header
 * names are inferred from decompiled code, and a header spelled differently than
 * expected is invisible to any parser written in advance.
 */
export async function probeRaw(): Promise<RcclResponse | null> {
  return request('/en/all/mobile/v2/ships?sort=name');
}

/**
 * Today as `yyyyMMdd`, in the device's own zone.
 *
 * The zone barely matters: a voyage is a week long, so being a few hours either
 * side of midnight cannot select the wrong one. The alternative would be picking
 * between three competing "todays" — ship, geographic and device — for what is
 * really a calendar question.
 */
export function todayStamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

/**
 * The voyage a ship is sailing today, as `yyyyMMdd` dates. Null when there is
 * none, or when nothing answered.
 *
 * Used to bound the background offset re-check for a detected ship. The list
 * runs to 86 sailings with no gaps — a new voyage begins the day the last one
 * ends — which is exactly why the *specific* voyage has to be pinned at
 * detection: "this ship has an active voyage" is true essentially forever, while
 * "the voyage you boarded" ends.
 */
export async function fetchActiveVoyage(
  ship: ShipRef
): Promise<{ sailDate: string; sailEndDate: string } | null> {
  const response = await request(`/en/${ship.brand}/mobile/v3/ships/${ship.code}/voyages`);
  if (!response || response.status !== 200) return null;

  const voyages = response.data?.payload?.voyages;
  if (!Array.isArray(voyages)) return null;

  const today = todayStamp();
  for (const voyage of voyages) {
    const start = String(voyage?.sailDate ?? '');
    const end = String(voyage?.sailEndDate ?? '');
    if (/^\d{8}$/.test(start) && /^\d{8}$/.test(end) && start <= today && today <= end) {
      return { sailDate: start, sailEndDate: end };
    }
  }
  return null;
}

/**
 * Raw fleet rows plus the environment that came with them.
 *
 * This is also the cold-start detection path: with no ship stored yet there is
 * no `/time` call to ride, and the fleet list is the cheapest endpoint that
 * needs no ship code. It refreshes the roster at the same time, so the two jobs
 * share one request.
 */
export async function fetchFleet(): Promise<{ ships: any[] | null; env: Environment } | null> {
  const response = await request('/en/all/mobile/v2/ships?sort=name');
  if (!response) return null;

  const env = readEnvironment(response.headers);
  if (response.status !== 200) return { ships: null, env };

  const ships = response.data?.payload?.ships;
  return { ships: Array.isArray(ships) ? ships : null, env };
}
