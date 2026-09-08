/**
 * One hostname in front of all of them.
 *
 *   geotime-api.matthewcarroll.ca/time/…    → geotime-utc-time
 *                                /rccl/…    → geotime-rccl-proxy
 *                                /ships/…   → geotime-ship-track
 *                                /anchor/…  → geotime-anchor-share
 *
 * WHY A HOSTNAME OF OUR OWN. These URLs are compiled into app binaries that go
 * to the App Store and Play, and a shipped build calls whatever it was built
 * with for as long as it is installed. `*.workers.dev` is Cloudflare's name,
 * not ours: the day any of it has to move — a rename, another account, another
 * provider entirely — every install still points at the old one, and the only
 * fix is an update every user has to take. A name we own is the hedge, and it
 * costs nothing to take now and a client release to take later.
 *
 * WHY A GATEWAY RATHER THAN FOUR NAMES. A custom domain binds a whole hostname
 * to one Worker, so four Workers on one hostname needs something to dispatch
 * between them. The alternatives were worse: four flat hostnames is four CSP
 * entries and not really a namespace, and nesting them (anchor.geotime-api.…)
 * falls outside Cloudflare's universal certificate, which covers exactly one
 * level of subdomain.
 *
 * WHY IT STRIPS THE PREFIX. So that nothing behind it had to change. The RCCL
 * proxy forwards `url.pathname` to the upstream API verbatim, and the ship
 * tracker matches `/fleet` and `/ship/:imo` exactly — mount either under a
 * prefix it can see and both break. Here the prefix is this layer's business
 * and the Workers behind it are handed the paths they already serve, so their
 * `*.workers.dev` names keep working unchanged for every 1.7.0 install still in
 * the field.
 *
 * It routes and nothing else on purpose. It is, however, the one place every
 * request now passes through, which makes it where rate limiting or a shared
 * cache would go if either is ever wanted.
 */

interface Env {
  TIME: Fetcher;
  RCCL: Fetcher;
  SHIPS: Fetcher;
  ANCHOR: Fetcher;
  /**
   * Per-IP limiters. Optional because `wrangler dev` without them is a normal
   * way to work on this, and a missing limiter should mean "not limited here",
   * not a 500 on every request.
   */
  GENERAL?: RateLimit;
  SENSITIVE?: RateLimit;
}

/**
 * The two paths worth a tighter limit than everything else.
 *
 * Minting an identity and spending somebody's code: the first is the only
 * unauthenticated write in the whole system, and the second is the only place a
 * guess could ever be worth making. Neither is something a person does more
 * than once in a sitting.
 *
 * A share code is eight Crockford characters — about 1.1e12 of them — so
 * guessing was never the practical risk. Exhausting a free tier's daily budget
 * on somebody else's behalf is, and it costs an attacker nothing.
 */
const SENSITIVE_PATHS = ['/anchor/v1/account', '/anchor/v1/shares/redeem'] as const;

/**
 * Longest prefix first would matter if any were a prefix of another. None are,
 * and keeping them distinct is cheaper than a rule about ordering.
 */
// Only the service bindings, never every key on Env: once the rate limiters
// joined it, `keyof Env` stopped meaning "something you can fetch from".
type ServiceBinding = NonNullable<
    { [K in keyof Env]: Env[K] extends Fetcher ? K : never }[keyof Env]>;

const MOUNTS: ReadonlyArray<{ prefix: string; binding: ServiceBinding }> = [
  { prefix: '/time', binding: 'TIME' },
  { prefix: '/rccl', binding: 'RCCL' },
  { prefix: '/ships', binding: 'SHIPS' },
  { prefix: '/anchor', binding: 'ANCHOR' },
] as const;

/**
 * CORS is answered here rather than passed through.
 *
 * A preflight is about this hostname, and the Worker behind the mount has no
 * idea it is behind one. Answering here also means a browser sees one
 * consistent policy across every mount instead of four that happen to agree.
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '3600',
} as const;

/**
 * 429, said the way a client can act on.
 *
 * Retry-After is the whole point: without it every caller invents its own
 * backoff, and the ones that invent none retry immediately and make the thing
 * they are being limited for worse.
 */
const tooMany = () =>
  new Response(JSON.stringify({ error: 'rate_limited' }), {
    status: 429,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Retry-After': '60',
    },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // Keyed on the caller's address, which this layer has and the Workers
    // behind it may not — see the note in wrangler.jsonc. An absent address
    // would key every request in the world together, so it is left unlimited
    // instead: a limiter that cannot tell callers apart is worse than none.
    const ip = request.headers.get('CF-Connecting-IP');
    if (ip) {
      const sensitive = SENSITIVE_PATHS.some((p) => url.pathname === p);
      const limiter = sensitive ? env.SENSITIVE : env.GENERAL;
      // Both, for a sensitive path: its own tight budget, and its share of the
      // general one. Checking only the tighter of the two would let a script
      // spend its five a minute here on top of an unmetered flood elsewhere.
      if (limiter && !(await limiter.limit({ key: ip })).success) return tooMany();
      if (sensitive && env.GENERAL && !(await env.GENERAL.limit({ key: ip })).success) {
        return tooMany();
      }
    }
    const mount = MOUNTS.find(
      ({ prefix }) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
    );

    if (!mount) {
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    // The Worker behind the mount sees the path it has always served. An empty
    // remainder becomes "/" rather than "", which is what utc-time expects and
    // what `new URL` would otherwise resolve oddly.
    const forwarded = new URL(url);
    forwarded.pathname = url.pathname.slice(mount.prefix.length) || '/';

    // A new Request rather than a mutated one: Request is immutable, and this
    // preserves method, headers and body — including the Authorization header
    // the anchor relay authenticates with.
    return env[mount.binding].fetch(new Request(forwarded, request));
  },
} satisfies ExportedHandler<Env>;
