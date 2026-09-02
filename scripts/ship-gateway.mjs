#!/usr/bin/env node
// Stands in for a cruise ship's own network gateway, so the aboard path can be
// exercised from a desk.
//
//   node scripts/ship-gateway.mjs            # aboard Star of the Seas
//   node scripts/ship-gateway.mjs --ship ID  # aboard Independence
//   echo shore > /tmp/ship-mode              # step ashore, no restart needed
//
// Then build the app for it (the mode is what unlocks the hook; see
// shipGateway() in vite.config.js):
//
//   VITE_SHIP_GATEWAY=http://localhost:8899 npx vite build --mode shiptest   # iOS
//   VITE_SHIP_GATEWAY=http://10.0.2.2:8899  npx vite build --mode shiptest   # Android
//
// WHY THIS EXISTS
//
// Aboard, the ship's gateway injects `environment-marker` and
// `environment-ship-code` into every response, and that is the whole basis of
// detection. A shore machine cannot produce them. The Vite dev proxy already
// fakes them for the web build (RCCL_SIM_SHIP in vite.config.js), but native
// talks to api.rccl.com directly — it has to, since that is the only host
// reachable from a ship — so the dev proxy never sees those requests. Without
// this, the aboard path on a real device is untestable, which for a feature
// released with no on-ship access is not a gap worth accepting.
//
// It proxies the real API rather than serving fixtures, so everything except the
// two headers is genuine: real offsets, real voyages, real failures.
//
// The app key is read from the environment or .env.local and never written
// anywhere. Plain HTTP on loopback, because CapacitorHttp and iOS ATS both
// accept that without a certificate, and because vite.config.js refuses to build
// against anything but a loopback address.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const PORT = Number(arg('port', 8899));
const SHIP = arg('ship', 'ST').toUpperCase();
/** Flip between aboard and ashore mid-session by writing this file. */
const MODE_FILE = arg('mode-file', '/tmp/ship-mode');
/**
 * The onboard header is a bare 12-hour wall clock with no date and no offset.
 * Nothing parses it — deriving an offset from it would mean trusting the
 * device's UTC, which is the one value this app exists because it cannot — so it
 * is here only to be recorded and reported by diagnostics.
 */
const SHIP_TIME = arg('ship-time', '3:45 PM');

function appKey() {
  if (process.env.RCCL_APPKEY) return process.env.RCCL_APPKEY;
  try {
    const env = readFileSync(join(import.meta.dirname, '..', '.env.local'), 'utf8');
    return (env.match(/^RCCL_APPKEY=["']?([^"'\n]+)/m) || [])[1] || '';
  } catch {
    return '';
  }
}

const KEY = appKey();
if (!KEY) {
  console.error(
    'No RCCL_APPKEY. Set it in the environment or .env.local — /time returns 401 without it.'
  );
  process.exit(1);
}

/** 'ship' unless the mode file says otherwise, so the default is the useful one. */
function mode() {
  try {
    return readFileSync(MODE_FILE, 'utf8').trim() === 'shore' ? 'shore' : 'ship';
  } catch {
    return 'ship';
  }
}

createServer(async (req, res) => {
  const aboard = mode() === 'ship';
  try {
    const upstream = await fetch('https://api.rccl.com' + req.url, {
      headers: {
        appkey: KEY,
        accept: 'application/json',
        platform: 'ios',
        appversion: '1.80.0',
      },
    });
    const body = await upstream.text();
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      // Wide open, and only ever bound to loopback: this is also usable from a
      // browser, where the app reads these headers cross-origin.
      'access-control-allow-origin': '*',
      'access-control-expose-headers':
        'environment-marker, environment-ship-code, ship-time, date',
      // The three a real gateway adds. Ashore it reports the marker and a
      // shipCode of "none", which is what the live API sends from land.
      'environment-marker': aboard ? 'ship' : 'shore',
      'environment-ship-code': aboard ? SHIP : 'none',
      ...(aboard ? { 'ship-time': SHIP_TIME } : {}),
    });
    res.end(body);
    console.log(`${upstream.status} ${aboard ? 'ship ' + SHIP : 'shore'}  ${req.url}`);
  } catch (err) {
    // A 502 rather than a hang, so the app takes its offline path promptly.
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'gateway_upstream_failed' }));
    console.log(`502 ${req.url}  ${err}`);
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`ship gateway on http://localhost:${PORT} — aboard ${SHIP}`);
  console.log(`  ashore: echo shore > ${MODE_FILE}`);
  console.log(`  aboard: echo ship  > ${MODE_FILE}`);
});
