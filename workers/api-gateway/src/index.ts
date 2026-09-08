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
   * The Play app-signing certificate's SHA-256, for Android App Links.
   *
   * A var rather than a constant because it is not ours to know: Play re-signs
   * every upload with its own key, so the fingerprint that has to appear in
   * assetlinks.json lives in Play Console under App integrity and nowhere in
   * this repository. Set it with `wrangler secret put` or in the dashboard;
   * until it is set, assetlinks.json is served without it and Android falls
   * back to opening the landing page, where the code can still be read.
   */
  ANDROID_CERT_SHA256?: string;
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

/**
 * Tells iOS that this app owns /f/ on this hostname.
 *
 * Universal Links, so a tap in Messages opens GeoTime rather than Safari. The
 * appID is TEAMID.bundleID; the team is in the Xcode project as
 * DEVELOPMENT_TEAM and is not a secret.
 *
 * Served from a Worker rather than a static file because this hostname IS a
 * Worker, and because it is the only domain the project actually owns — the web
 * app lives on a github.io project path, where /.well-known belongs to GitHub.
 *
 * Both spellings of the payload: `details` with `components` is the modern one,
 * and `paths` is what older iOS reads. Neither is expensive and getting it
 * wrong fails silently, which is the worst way for this to fail.
 */
function appleAssociation(): Response {
  const appID = '3WCH54M3A8.ca.matthewcarroll.geotime';
  return json({
    applinks: {
      apps: [],
      details: [
        { appID, appIDs: [appID], paths: ['/f/*'], components: [{ '/': '/f/*' }] },
      ],
    },
  });
}

/**
 * The same claim for Android, which wants a certificate fingerprint.
 *
 * The fingerprint is Play's rather than ours — Play re-signs every upload with
 * its own key, so the value lives in Play Console and not in this repository.
 * See ANDROID_CERT_SHA256.
 *
 * WITH IT UNSET, THIS SERVES AN EMPTY LIST — `[]`, and not a statement whose
 * fingerprint array is empty. That distinction is the whole of this function
 * and it is not cosmetic: Google's verifier rejects the second as
 * ERROR_CODE_MALFORMED_CONTENT ("must contain at least one certificate"), so a
 * file written that way is not an unverified claim, it is a broken document.
 * An empty list is valid and simply asserts nothing, which is exactly the
 * truth while nobody has supplied a fingerprint.
 *
 * Checked rather than assumed, against
 * digitalassetlinks.googleapis.com/v1/statements:list — worth re-running after
 * any change here, because this file is read by an operating system that will
 * never report back.
 */
function androidAssetLinks(env: Env): Response {
  const fingerprint = env.ANDROID_CERT_SHA256?.trim();
  if (!fingerprint) return json([]);

  return json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'ca.matthewcarroll.geotime',
        sha256_cert_fingerprints: [fingerprint],
      },
    },
  ]);
}

/**
 * What somebody sees when the app did not open.
 *
 * Which is most of the point of using an https link at all: a custom scheme is
 * dead for anybody who has not installed the app, and the person being invited
 * is exactly the person most likely not to have it. So this page shows the code
 * in a form they can read out or type, and points at both stores.
 *
 * The code is NOT redeemed here and nothing is looked up. This route touches no
 * database: it exists to be a page, and a link that quietly spent its one-shot
 * code because a link preview crawler fetched it would be a fine way to break
 * every invitation ever sent through a chat app.
 */
function followPage(code: string): Response {
  const shown = `${code.slice(0, Math.ceil(code.length / 2))}-${code.slice(Math.ceil(code.length / 2))}`;
  const escaped = shown.replace(/[^0-9A-Za-z-]/g, '');
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Follow on GeoTime</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #111827; color: #e5e7eb; padding: 2rem 1.25rem;
         font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 26rem; text-align: center; }
  h1 { font-size: 1.375rem; margin: 0 0 .5rem; color: #fff; }
  p { margin: 0 0 1rem; color: #9ca3af; }
  .code { font: 700 2rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
          letter-spacing: .18em; color: #fff; margin: 1.5rem 0; user-select: all; }
  a { display: block; margin: .5rem 0; padding: .75rem 1rem; border-radius: .75rem;
      background: #1f2937; color: #93c5fd; text-decoration: none; }
</style>
</head>
<body>
<main>
  <h1>Someone wants to share their time</h1>
  <p>If you have GeoTime, open it, tap <strong>Follow someone</strong> and enter this code.</p>
  <p class="code">${escaped}</p>
  <p>It works once, and lasts 24 hours.</p>
  <a href="https://apps.apple.com/app/geotime/id6753636878">Get GeoTime for iPhone</a>
  <a href="https://play.google.com/store/apps/details?id=ca.matthewcarroll.geotime">Get GeoTime for Android</a>
</main>
</body>
</html>`, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // A code is a one-shot secret. Nothing about this page should sit in a
      // shared cache with it in the body.
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // Long, because an OS fetches these rarely and caching them is the
      // difference between a link that works instantly and one that hesitates.
      'Cache-Control': 'public, max-age=3600',
    },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // The three paths that are a WEBSITE rather than an API, and the only ones
    // here that are meant to be opened by a human or by an operating system.
    // Ahead of the rate limiter because a phone verifying an app link is not a
    // caller we want to turn away, and ahead of the mounts because none of them
    // would claim these anyway.
    if (url.pathname === '/.well-known/apple-app-site-association') return appleAssociation();
    if (url.pathname === '/.well-known/assetlinks.json') return androidAssetLinks(env);
    const follow = /^\/f\/([0-9A-Za-z-]{1,32})\/?$/.exec(url.pathname);
    if (follow) return followPage(follow[1]);

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
