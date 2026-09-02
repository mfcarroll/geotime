// vite.config.js

import { resolve } from 'path';
import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig(({ mode }) => ({
  // Change the base path for production builds
  base: '/',
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        privacy: resolve(__dirname, 'privacy.html')
      }
    }
  },
  plugins: [
    workerCsp(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['timezones.geojson', 'cities.json', 'ships.json'],
      manifest: {
        name: 'GeoTime Dashboard',
        short_name: 'GeoTime',
        description: 'A world clock and timezone dashboard.',
        theme_color: '#1f2937',
        background_color: '#111827',
        display: 'standalone',
        start_url: '.',
        icons: [
          {
            src: 'icons/icon-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icons/icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'icons/icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          }
        ]
      }
    }),
    basicSsl()
  ],
  server: {
    https: true,
    proxy: rcclDevProxy()
  },
  preview: {
    https: true,
    proxy: rcclDevProxy()
  },
  define: {
    // Compiled to `null` in every mode but `shiptest`, so a release build has
    // no path to a test host at all — see shipGateway().
    __SHIP_GATEWAY__: JSON.stringify(shipGateway(mode)),
  },
}));

/**
 * The onboard-simulation gateway, or null.
 *
 * Native talks to api.rccl.com directly and must, since that is the only host
 * reachable from a ship — which also means the Vite dev proxy's RCCL_SIM_SHIP
 * trick cannot reach it, and the aboard path is otherwise untestable on a real
 * device. scripts/ship-gateway.mjs stands in for a ship's own gateway, injecting
 * the environment headers into real API responses; this is how the app is told
 * to use it.
 *
 * Two guards, because the failure this could cause is the worst kind — a release
 * quietly asking localhost for ship time, which would look exactly like a ship
 * that cannot be reached:
 *
 *   1. Only honoured in `--mode shiptest`. Every other build, including the
 *      ordinary `vite build` used for release, compiles this to `null`, so the
 *      test host is not merely unused but absent from the bundle.
 *   2. Only a loopback or emulator-host address is accepted. Anything else
 *      fails the build rather than being ignored, since a gateway pointing
 *      somewhere public is a mistake worth stopping.
 */
function shipGateway(mode) {
  if (mode !== 'shiptest') return null;

  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const url = env.VITE_SHIP_GATEWAY;
  if (!url) {
    throw new Error(
      '--mode shiptest needs VITE_SHIP_GATEWAY set.\n'
      + '  iOS simulator:    VITE_SHIP_GATEWAY=http://localhost:8899\n'
      + '  Android emulator: VITE_SHIP_GATEWAY=http://10.0.2.2:8899'
    );
  }
  // 10.0.2.2 is how an Android emulator reaches its host's loopback.
  const allowed = /^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?$/;
  if (!allowed.test(url.replace(/\/$/, ''))) {
    throw new Error(
      `VITE_SHIP_GATEWAY must be a loopback or emulator-host address, got "${url}".`
    );
  }
  console.warn(`\n[shiptest] ship-time requests will go to ${url}, NOT api.rccl.com.\n`);
  return url.replace(/\/$/, '');
}

/**
 * Substitutes the configured Worker origins into the page's CSP.
 *
 * The alternative was a static `https://*.workers.dev`, which would admit every
 * Worker anybody has ever deployed — a wildcard over a shared hostname is barely
 * a policy at all. Deriving the exact origins from the same variables the client
 * uses keeps the two from drifting, and means moving a Worker to a custom domain
 * needs no separate CSP edit.
 *
 * Only the origin is taken, never the path: CSP source expressions match on
 * scheme, host and port.
 */
function workerCsp() {
  return {
    name: 'geotime:worker-csp',
    transformIndexHtml(html, ctx) {
      const env = loadEnv(ctx?.server ? 'development' : 'production', process.cwd(), 'VITE_');
      // Defaults must match the ones in src/rccl.ts and src/time.ts: the CSP
      // has to admit whatever the client will actually call, and the client
      // falls back to these when the variables are unset.
      const origins = [
        env.VITE_RCCL_PROXY ?? 'https://geotime-rccl-proxy.matthew-carroll.workers.dev',
        env.VITE_UTC_TIME_URL ?? 'https://geotime-utc-time.matthew-carroll.workers.dev',
        env.VITE_SHIP_TRACK ?? 'https://geotime-ship-track.matthew-carroll.workers.dev',
      ]
        .filter(Boolean)
        .map((value) => {
          try {
            return new URL(value).origin;
          } catch {
            return '';
          }
        })
        .filter(Boolean);
      return html.replace('%WORKER_ORIGINS%', [...new Set(origins)].join(' '));
    },
  };
}

/**
 * Dev-only proxy for api.rccl.com (ship time).
 *
 * Two problems, one solution. api.rccl.com sends no CORS headers and exposes
 * only Server-Timing, so a browser can neither call it nor read the
 * environment-ship-code header — on device that is handled by routing through
 * native, but native isn't available in `npm run dev`. And the app key must
 * never reach the web bundle, because one dist/ serves both the apps and the
 * public Pages site.
 *
 * Proxying server-side solves both: the browser talks to a same-origin path, and
 * the key is attached here in Node, so it is never inlined into any client code.
 * This block does not exist in a production build — Vite's proxy is dev-server
 * only — which is also why the web build has no ship features at all.
 */
function rcclDevProxy() {
  // loadEnv with an empty prefix so a NON-VITE_ variable is readable: anything
  // prefixed VITE_ would be inlined into the client bundle, which is the whole
  // thing being avoided. Read here in Node and attached below, so the key never
  // reaches the browser even in development.
  //
  // No fallback. The key is not in this repo — set RCCL_APPKEY in .env.local
  // (see .env.local.example). Without it the proxy still serves the open
  // endpoints, so ship search and detection work in dev and only live offsets
  // return 401.
  const appkey = loadEnv('development', process.cwd(), '').RCCL_APPKEY
    || process.env.RCCL_APPKEY
    || '';
  if (!appkey) {
    console.warn(
      '\n[rccl] RCCL_APPKEY is not set — ship time offsets will 401 in dev.'
      + '\n       Set it in .env.local to resolve live ship clocks.\n'
    );
  }
  const simShip = (process.env.RCCL_SIM_SHIP || '').toUpperCase();
  // The onboard header is a bare 12-hour wall clock with no date and no offset.
  // Nothing parses it — deriving an offset from it would mean trusting the
  // device's UTC, which is the one value this app exists because it cannot — so
  // this is only here to be recorded and reported.
  const simShipTime = process.env.RCCL_SIM_SHIP_TIME || '3:45 PM';
  return {
    '/rccl-api': {
      target: 'https://api.rccl.com',
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/rccl-api/, ''),
      configure: (proxy) => {
        proxy.on('proxyReq', (proxyReq) => {
          if (appkey) proxyReq.setHeader('appkey', appkey);
          proxyReq.setHeader('accept', 'application/json');
          proxyReq.setHeader('platform', 'android');
          proxyReq.setHeader('appversion', '1.80.0');
        });
        // The gateway headers are the whole point of the probe, and a browser
        // may only read what the response allows it to. Same-origin via the
        // proxy means we can widen that here for dev.
        proxy.on('proxyRes', (proxyRes) => {
          proxyRes.headers['access-control-expose-headers'] =
            'environment-marker, environment-ship-code, ship-time, date';

          // Onboard simulation: `RCCL_SIM_SHIP=ST npm run dev` makes every
          // response claim to come from that ship's network.
          //
          // Detection is built entirely on headers that have never been seen on
          // the wire — the API doc infers them from decompiled bytecode — and a
          // shore machine can never produce them. Without this the whole aboard
          // path would ship on inference alone; with it, everything except the
          // real header names can be exercised from a desk. Dev-server only.
          if (simShip) {
            proxyRes.headers['environment-marker'] = 'ship';
            proxyRes.headers['environment-ship-code'] = simShip;
            proxyRes.headers['ship-time'] = simShipTime;
          }
        });
      },
    },
  };
}