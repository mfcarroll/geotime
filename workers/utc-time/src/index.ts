/**
 * Returns the current UTC time.
 *
 * This is what `syncClock()` in src/time.ts calls, and it exists because a
 * correct timezone still renders the wrong time if the device's clock is wrong —
 * which is the failure the whole app was built around.
 *
 * Replaces a Cloud Function of the same shape that was created directly in the
 * Google Cloud console, with no source control and no deploy pipeline (see
 * docs/utc-time-function.md). The contract is deliberately identical so the app
 * only needed a URL change: `{ "dateTime": "<ISO 8601>" }`.
 *
 * CORS is wide open on purpose. There is nothing here to protect — the response
 * is the same for everybody and contains no input — and the app is served from
 * more origins than are worth enumerating (Pages, capacitor://geotime.local,
 * https://geotime.local, localhost in development).
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '3600',
} as const;

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
        status: 405,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', Allow: 'GET, OPTIONS' },
      });
    }

    return new Response(JSON.stringify({ dateTime: new Date().toISOString() }), {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        // A cached clock is a wrong clock. Explicit rather than relying on the
        // default, since this response is otherwise ideal cache bait.
        'Cache-Control': 'no-store',
      },
    });
  },
} satisfies ExportedHandler;
