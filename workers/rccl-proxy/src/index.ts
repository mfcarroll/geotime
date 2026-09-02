/**
 * CORS proxy for the Royal Caribbean ship-time API.
 *
 * `api.rccl.com` sends no CORS headers and exposes only `Server-Timing`, so a
 * browser can neither call it nor read the headers that matter. The native apps
 * go direct — they have to, because that is the only thing that works from a
 * ship's own network — and this exists so the *web* build can look up a ship's
 * clock from shore. That is half the point of the feature: knowing what time it
 * is for someone else, on a ship, while you are at home.
 *
 * It also keeps the app key off the client entirely on that path: the key lives
 * here as a secret and never reaches a browser.
 *
 * What it deliberately CANNOT do: onboard detection. The environment headers
 * report the network the request came from, and requests from here come from
 * Cloudflare — so `environment-marker` is always `shore`. A web user aboard a
 * ship gets the ordinary shore interface, which is the accepted behaviour rather
 * than a gap to close.
 */

interface Env {
  /** Set with `wrangler secret put RCCL_APPKEY`. Never in wrangler.jsonc. */
  RCCL_APPKEY: string;
  /** Comma-separated origins allowed to call this. Non-secret; in vars. */
  ALLOWED_ORIGINS: string;
}

const UPSTREAM = 'https://api.rccl.com';

/**
 * Exactly the paths the app uses, and nothing else.
 *
 * An allowlist rather than a prefix check, because a proxy that forwards
 * arbitrary paths while attaching someone else's API key is an open relay. The
 * brand and ship code are constrained to their real shapes so no path traversal
 * or unexpected segment can reach upstream.
 */
const ROUTES: readonly RegExp[] = [
  // The live offset — the only endpoint that needs the key.
  /^\/en\/(?:R|C|all)\/mobile\/v3\/ships\/[A-Z]{2}\/time$/,
  // Open upstream, but proxied anyway so the browser can read them.
  /^\/en\/(?:R|C|all)\/mobile\/v2\/ships$/,
  /^\/en\/(?:R|C|all)\/mobile\/v3\/ships\/[A-Z]{2}\/voyages$/,
];

/** Response headers the browser is allowed to read. */
const EXPOSED = 'environment-marker, environment-ship-code, ship-time, date';

function allowedOrigins(env: Env): string[] {
  return env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
}

/**
 * Echoes the request's origin when it is allowed, rather than sending `*`.
 *
 * Not a security boundary — anyone can curl this directly, and the allowlist is
 * about keeping a browser on someone else's site from quietly using our key
 * quota, not about secrecy.
 */
function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': EXPOSED,
    'Access-Control-Max-Age': '3600',
    Vary: 'Origin',
  };
  if (origin && allowedOrigins(env).includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'GET') {
      return json({ error: 'method_not_allowed' }, 405, { ...cors, Allow: 'GET, OPTIONS' });
    }

    const url = new URL(request.url);
    if (!ROUTES.some((route) => route.test(url.pathname))) {
      return json({ error: 'not_proxied' }, 404, cors);
    }

    const upstream = new URL(UPSTREAM + url.pathname);
    // Only the one query parameter the fleet endpoint takes; anything else is
    // dropped rather than forwarded.
    if (url.searchParams.get('sort') === 'name') upstream.searchParams.set('sort', 'name');

    const headers: Record<string, string> = {
      accept: 'application/json',
      platform: 'web',
      appversion: '1.80.0',
    };
    // Attached to every request rather than only /time: the other two endpoints
    // are open today, and sending it costs nothing if that changes.
    if (env.RCCL_APPKEY) headers.appkey = env.RCCL_APPKEY;

    let response: Response;
    try {
      response = await fetch(upstream.toString(), { method: 'GET', headers });
    } catch {
      // Explicit, rather than passThroughOnException: the client can tell the
      // difference between "upstream unreachable" and "we refused", and neither
      // leaks anything about the key.
      return json({ error: 'upstream_unreachable' }, 502, cors);
    }

    // Streamed rather than buffered — nothing here needs the body in memory, and
    // the app is a Response away from whatever upstream said.
    const out = new Headers(cors);
    out.set('Content-Type', response.headers.get('Content-Type') ?? 'application/json');
    // The gateway headers are the reason the browser needs a proxy at all.
    for (const name of ['environment-marker', 'environment-ship-code', 'ship-time', 'date']) {
      const value = response.headers.get(name);
      if (value) out.set(name, value);
    }
    // A ship's clock is the one thing that must never be served stale; the fleet
    // and voyage lists change on the order of months.
    out.set('Cache-Control', url.pathname.endsWith('/time') ? 'no-store' : 'public, max-age=3600');

    return new Response(response.body, { status: response.status, headers: out });
  },
} satisfies ExportedHandler<Env>;
