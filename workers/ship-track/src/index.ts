/**
 * Position, past track and planned route for a cruise ship.
 *
 * CruiseMapper's map endpoints send no CORS headers at all, so a browser cannot
 * call them; and they reject any client that does not look like a browser. This
 * Worker is the only path the app uses — on every platform, not just the web.
 * That is the opposite of the RCCL proxy, and deliberately so:
 *
 *   - Ship *time* must go direct from native, because on a ship's own wifi
 *     api.rccl.com is the only reachable host on the internet.
 *   - Ship *position* is unreachable from that same network no matter what we
 *     do, so there is no reason for a device to go direct — and every reason not
 *     to. One cached response here serves every user, which keeps our load on
 *     someone else's undocumented endpoint to about one request a minute.
 *
 * It also normalises the payload. The client gets ~5 KB of exactly what it draws
 * instead of 37 KB of everything, and an upstream shape change becomes a deploy
 * here rather than an app-store release.
 */

interface Env {
  /** Comma-separated origins allowed to call this. Non-secret; in vars. */
  ALLOWED_ORIGINS: string;
  /**
   * Last known good track, keyed by vessel and voyage. See retainedTrack().
   *
   * Optional so the Worker still runs unbound — in `wrangler dev --local`
   * without KV, or if the binding is ever removed. Losing retention degrades to
   * exactly the previous behaviour rather than to an exception.
   */
  SHIP_TRACKS?: KVNamespace;
}

const ORIGIN = 'https://www.cruisemapper.com';

/**
 * Both headers are load-bearing, and the failure mode of dropping either is
 * worth spelling out because one of them is silent:
 *
 *   - no browser User-Agent -> 403 with an Apache error page. Obvious.
 *   - no X-Requested-With   -> 200, `text/html`, and an EMPTY BODY.
 *
 * The second is the dangerous one. Nothing about it is an error: the status is
 * 200 and `response.ok` is true, so a client that checks the status and parses
 * optimistically gets nothing and reports success. It is also environment
 * dependent — a laptop got real JSON without the header while a Worker did not
 * — so it cannot be verified anywhere except from here. See `isSoftBlocked`.
 */
const UPSTREAM_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'x-requested-with': 'XMLHttpRequest',
  accept: 'application/json, text/javascript, */*; q=0.01',
  'accept-language': 'en-US,en;q=0.9',
};

/**
 * Royal Caribbean (2) and Celebrity (10), worldwide, in one request.
 *
 * `filter` is a cruise-line index, is mandatory, and does NOT correspond to the
 * `ship_line_id` in the response — where Royal Caribbean is 1. These values were
 * enumerated against the live endpoint. Omitting `filter` returns an empty
 * array rather than an error, and an over-wide one returns a raw SQL exception.
 */
const FLEET_QUERY =
  '?minLat=-80&maxLat=80&minLon=-180&maxLon=180&zoom=2&filter=2,10';

/**
 * Every cruise line the endpoint will admit, for the nearby query.
 *
 * `filter` is the same cruise-line index FLEET_QUERY uses, so this is the same
 * request with the blinkers off: 45 vessels becomes ~278 across 35 lines. The
 * doc warns that an over-wide filter returns a raw SQL exception; 25 was probed
 * against the live endpoint and is inside the line.
 *
 * The clock list must NOT use this — it wants our fleet and nothing else. The
 * only caller is detection, which cannot tell whether a hull nearby is ours
 * without seeing the ones that are not.
 */
const ALL_LINES = Array.from({ length: 25 }, (_, i) => i + 1).join(',');

/**
 * The nearby box is snapped to a grid so that every guest on a given ship asks
 * for the SAME url, and therefore shares one cached upstream response.
 *
 * Without snapping, each distinct GPS fix would be its own cache key and the
 * cache would never hit — three thousand guests would become three thousand
 * upstream requests, which is both rude and the fastest way to be blocked.
 *
 * A half-degree cell puts the true position within 0.25 deg of the centre, and
 * a 0.75 deg box around that centre therefore covers the guest by at least
 * 0.5 deg (~55 km) in every direction. Detection accepts at 10 km, so the box
 * has room to spare.
 */
const GRID = 0.5;
const BOX = 0.75;

function snap(value: number): number {
  return Math.round(value / GRID) * GRID;
}

/**
 * Longitude degrees shrink towards the poles, so a fixed box would be a sliver
 * at Svalbard — where cruise ships do in fact go. Widened by 1/cos(lat) and
 * capped, because near the pole the box wraps the whole circle anyway.
 */
function lonBox(lat: number): number {
  const shrink = Math.cos((lat * Math.PI) / 180);
  if (shrink < 0.05) return 180;
  return Math.min(180, BOX / shrink);
}

/** How long each shape may be served from cache. */
const TTL = {
  /** A position is the one thing here that is genuinely live. */
  fleet: 60,
  /**
   * Detection, unlike the map, does not animate. Its own model already reasons
   * in minutes of drift, and no ship changes berth inside five of them — so the
   * shortest useful life here is far longer than the fleet feed's, and every
   * multiple of it is one fewer request upstream.
   */
  nearby: 5 * 60,
  /**
   * The detail bundle carries both the route (fixed for the whole voyage) and
   * the breadcrumb track (a new point roughly hourly). One upstream response
   * means one TTL, so this is pitched at the track — the route being staler than
   * necessary costs nothing, a track half an hour behind costs very little.
   */
  detail: 30 * 60,
} as const;

/**
 * Bumped whenever the shape of a cached response changes.
 *
 * The cache key is built here rather than taken from the request, so nothing a
 * caller sends can vary it and there is no way to ask for a fresh copy — which
 * is exactly what keeps our load on someone else's endpoint to about a request
 * a minute, and exactly what makes a deploy appear not to work for up to the
 * TTL. Entries under an old version are orphaned the moment this changes and
 * expire quietly on their own, so deploying a change now makes the change
 * visible. Cheaper than the alternatives: a bypass parameter hands strangers a
 * way to force upstream traffic, and a delete route means a secret and a write
 * endpoint on a public Worker for something needed a few times a year.
 *
 * The hostname is deliberately not a real one. The Cache API treats the key as
 * an identifier and never fetches it, so a made-up host makes it self-evidently
 * internal and cannot collide with anything genuinely cached.
 *
 *   v2 — track retention from KV; entries from v1 hold a pre-retention shape.
 */
const CACHE_VERSION = 'v2';
const cacheKey = (path: string) => `https://ship-track.geotime/${CACHE_VERSION}${path}`;

/** Response headers the browser is allowed to read. Nothing custom is needed. */
/**
 * Headers a browser is allowed to read off our responses.
 *
 * content-type is what the client actually uses. The three environment-*
 * names are a bet worth its cost: aboard, a ship's gateway stamps the
 * responses it passes, and IF it stamps this host and not only api.rccl.com,
 * naming them here is the difference between a browser knowing it is at sea
 * and not. Ashore they are simply absent, so it costs nothing to be wrong.
 * The ?shipprobe page reports whether they ever arrive.
 */
const EXPOSED = 'content-type, environment-marker, environment-ship-code, ship-time';

function allowedOrigins(env: Env): string[] {
  return env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
}

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

/**
 * IMO check digit: the seventh digit is a weighted sum of the first six.
 *
 * Used to validate the path segment, so this cannot be pointed at arbitrary
 * numbers. Every real IMO passes, so it costs nothing and narrows what a
 * stranger can ask us to fetch. Matches validImo() in build-ship-index.mjs.
 */
function validImo(imo: string): boolean {
  if (!/^[0-9]{7}$/.test(imo)) return false;
  let sum = 0;
  for (let i = 0; i < 6; i++) sum += Number(imo[i]) * (7 - i);
  return sum % 10 === Number(imo[6]);
}

/**
 * True when the upstream answered 200 but said nothing.
 *
 * This is the soft block described on UPSTREAM_HEADERS, and it is the reason
 * this Worker manages its own cache rather than handing `cacheTtl` to `fetch`:
 * an empty 200 is a cacheable success by every rule the platform knows, and
 * caching one would serve an empty map for the whole TTL.
 */
function isSoftBlocked(status: number, body: string): boolean {
  return status === 200 && body.trim().length === 0;
}

/** The few entities that actually turn up in CruiseMapper's port names. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/**
 * Port id -> port name, parsed out of the itinerary's HTML.
 *
 * `cruise.path.ports` has coordinates and no names; `cruise.itinerary` has names
 * and no coordinates. The join is `poi` against the numeric id ending the port's
 * URL — poi 42 <-> ".../ports/port-canaveral-port-42" — which is the only key
 * the two structures share. Note what does NOT work: `day` looks like it should
 * join and does not, because path.ports counts voyage days (2, 4, 5, 6, 8 —
 * skipping days at sea) while itinerary counts stops (1..6). Ordinal position
 * fails too, since path.ports omits the embarkation call that itinerary lists.
 *
 * Parsing someone's markup is fragile by nature, so it degrades rather than
 * throws: a port with no parsed name comes back with `name: null` and the client
 * falls back to its own city index. The `nameSource` field on each port makes
 * that visible, so a markup change shows up as names quietly becoming
 * "geocoded" instead of as wrong labels.
 */
function portNamesByPoi(itinerary: unknown): Map<string, string> {
  const names = new Map<string, string>();
  if (!itinerary || typeof itinerary !== 'object') return names;

  for (const stop of Object.values(itinerary as Record<string, any>)) {
    const html = typeof stop?.port === 'string' ? stop.port : '';
    const match = html.match(/<a[^>]*href="[^"]*?-(\d+)\/?"[^>]*>([^<]+)<\/a>/);
    if (!match) continue;
    const name = decodeEntities(match[2]);
    if (name) names.set(match[1], name);
  }
  return names;
}

/**
 * Tidies the crew-typed destination, or drops it.
 *
 * `destination` is free text an officer enters into the AIS set, and across the
 * live fleet it arrives in four shapes: real names ("Nassau", "Coco Cay"), bare
 * UN/LOCODEs ("USBYE", "USAOU", "USPCN"), split country-port codes ("MX COZ",
 * "MX CMM"), and shouting ("WILLEMSTAD, CURACAO"). The detail endpoint is no
 * better — it reports the same raw string.
 *
 * A code tells a reader nothing, so it is dropped rather than displayed:
 * "→ USBYE" is worse than showing no destination at all. Shouting is title-cased.
 * Done here rather than in the app so both the map tooltip and anything added
 * later share one answer, and so a new bad shape is a deploy rather than a
 * release.
 */
function tidyDestination(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text) return null;

  // A bare LOCODE, or a country code split from a port code.
  if (/^[A-Z]{2,6}$/.test(text)) return null;
  if (/^[A-Z]{2}[\s-][A-Z]{2,4}$/.test(text)) return null;

  // Uppercase throughout: title-case it. Anything already mixed case is left
  // exactly as typed, so "Victoria BC" keeps its initials.
  if (text === text.toUpperCase() && /[A-Z]/.test(text)) {
    return text.toLowerCase().replace(/(^|[\s(\/-])([a-z])/g, (_, before, letter) =>
      before + letter.toUpperCase()
    );
  }
  return text;
}

/** A `[lon, lat]` pair, or null when either value is not a finite number. */
function coord(lon: unknown, lat: unknown): [number, number] | null {
  const x = Number(lon);
  const y = Number(lat);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // Guards against a parsed empty string arriving as 0 and drawing a line
  // through the Gulf of Guinea, which is the classic bad-coordinate artefact.
  if (x === 0 && y === 0) return null;
  return [x, y];
}

/** The live-position feed, trimmed to what the map draws. */
/**
 * Vessels near a point, of every line — the raw material for deciding which
 * hull a guest is standing on.
 *
 * Deliberately thinner than shapeFleet: no route, no destination, no heading.
 * Detection needs a position, a speed, an age and an identity, and sending more
 * would be sending a list of everyone's whereabouts to answer a question about
 * one person's own.
 */
function shapeNearby(markers: unknown): unknown {
  if (!Array.isArray(markers)) return { vessels: [] };

  const vessels = markers.flatMap((marker: any) => {
    const imo = String(marker?.imo ?? '');
    const at = coord(marker?.lon, marker?.lat);
    if (!validImo(imo) || !at) return [];
    return [{
      imo,
      // `ship_name` is present on every record and empty on every record; the
      // name lives in `hover`. Same quirk shapeFleet handles.
      name: typeof marker?.hover === 'string' ? marker.hover : null,
      line: typeof marker?.ship_line_title === 'string' ? marker.ship_line_title : null,
      lon: at[0],
      lat: at[1],
      sog: Number.isFinite(Number(marker?.sog)) ? Number(marker.sog) : null,
      tst: Number.isFinite(Number(marker?.tst)) ? Number(marker.tst) : null,
    }];
  });

  return { vessels };
}

function shapeFleet(markers: unknown): unknown {
  if (!Array.isArray(markers)) return { ships: [] };

  const ships = markers.flatMap((marker: any) => {
    const imo = String(marker?.imo ?? '');
    const at = coord(marker?.lon, marker?.lat);
    if (!validImo(imo) || !at) return [];
    return [{
      imo,
      // The feed leaves `ship_name` empty and carries the name in `hover`. Sent
      // for diagnostics only — the client names ships from its own roster.
      name: typeof marker?.hover === 'string' ? marker.hover : null,
      lon: at[0],
      lat: at[1],
      sog: Number.isFinite(Number(marker?.sog)) ? Number(marker.sog) : null,
      // Course over ground is what the marker is rotated by. `heading` reports
      // 511 for "not available", so it is only a fallback and only when sane.
      cog: Number.isFinite(Number(marker?.cog)) ? Number(marker.cog) : null,
      heading: Number(marker?.heading) >= 0 && Number(marker?.heading) < 360
        ? Number(marker.heading)
        : null,
      destination: tidyDestination(marker?.destination),
      /** Unix seconds of the AIS fix. The client shows its age; some are hours old. */
      tst: Number.isFinite(Number(marker?.tst)) ? Number(marker.tst) : null,
    }];
  });

  return { ships };
}

/** The per-ship detail bundle, trimmed and with both polylines in one order. */
interface ShapedVoyage {
  imo: string;
  name: string | null;
  destination: string | null;
  eta: string | null;
  voyage: { name: string | null; startDate: string | null; endDate: string | null; days: string | null };
  track: Array<[number, number]>;
  route: Array<[number, number]>;
  ports: unknown[];
  extent: number[] | null;
  trackRetained?: boolean;
}

function shapeDetail(imo: string, payload: any): ShapedVoyage {
  const path = payload?.cruise?.path ?? {};
  const names = portNamesByPoi(payload?.cruise?.itinerary);

  // `track` arrives as {lat, lon} objects while `cruise.path.points` arrives as
  // [lon, lat] arrays. Normalising both to [lon, lat] here removes a footgun
  // that would otherwise sit in the client for good.
  const track = Array.isArray(payload?.track)
    ? payload.track.flatMap((p: any) => {
        const at = coord(p?.lon, p?.lat);
        return at ? [at] : [];
      })
    : [];

  const route = Array.isArray(path?.points)
    ? path.points.flatMap((p: any) => {
        const at = Array.isArray(p) ? coord(p[0], p[1]) : null;
        return at ? [at] : [];
      })
    : [];

  const ports = Array.isArray(path?.ports)
    ? path.ports.flatMap((port: any) => {
        const at = coord(port?.lon, port?.lat);
        if (!at) return [];
        const poi = String(port?.poi ?? '');
        const name = names.get(poi) ?? null;
        return [{
          lon: at[0],
          lat: at[1],
          name,
          /** null means the client should name this from its own city index. */
          nameSource: name ? 'itinerary' : null,
          /** Voyage day, 1-based. Skips days at sea. */
          day: Number.isFinite(Number(port?.day)) ? Number(port.day) : null,
          /** Local departure time as upstream states it; null on the final call. */
          depart: typeof port?.dep_datetime === 'string' ? port.dep_datetime : null,
        }];
      })
    : [];

  return {
    imo,
    name: typeof payload?.name === 'string' ? payload.name : null,
    destination: tidyDestination(payload?.destination),
    eta: typeof payload?.eta === 'string' ? payload.eta : null,
    voyage: {
      name: payload?.cruise?.name ?? null,
      startDate: payload?.cruise?.start_date ?? null,
      endDate: payload?.cruise?.end_date ?? null,
      days: payload?.cruise?.days ?? null,
    },
    track,
    route,
    ports,
    /** [minLat, minLon, maxLat, maxLon] — what the map fits to on selection. */
    extent: Array.isArray(path?.extent) ? path.extent.map(Number) : null,
    // Explicitly NOT forwarded: `weather.localtime`. It looks like a ship clock
    // and is not one — it is derived from position, while the onboard clock is
    // whatever the crew set. RCCL's /time endpoint is the only authority, and
    // shipping this field would invite exactly the wrong wiring later.
  };
}

/**
 * Fetches upstream, validates, and caches only what is worth keeping.
 *
 * Hand-rolled rather than `fetch(url, { cf: { cacheTtl } })` because the
 * platform's cache cannot see the failure that matters: the soft block is a
 * 200, so it would be stored as a perfectly good response and served for the
 * whole TTL. Here nothing reaches the cache until it has parsed.
 */
async function fetchShaped(
  cacheKey: string,
  upstreamUrl: string,
  shape: (payload: any) => unknown | Promise<unknown>,
  ttl: number
): Promise<{ body: string; status: number }> {
  const cache = caches.default;
  const keyRequest = new Request(cacheKey, { method: 'GET' });

  const hit = await cache.match(keyRequest);
  if (hit) return { body: await hit.text(), status: 200 };

  let response: Response;
  try {
    response = await fetch(upstreamUrl, { headers: UPSTREAM_HEADERS });
  } catch {
    return { body: JSON.stringify({ error: 'upstream_unreachable' }), status: 502 };
  }

  const raw = await response.text();

  if (isSoftBlocked(response.status, raw)) {
    // Distinct from a transport failure on purpose: this one means the request
    // was shaped wrongly or we are being throttled, and it is the failure most
    // likely to appear later without any code having changed.
    return { body: JSON.stringify({ error: 'upstream_soft_blocked' }), status: 502 };
  }
  if (!response.ok) {
    return {
      body: JSON.stringify({ error: 'upstream_error', status: response.status }),
      status: 502,
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // A 200 that is not JSON is an interstitial or an error page.
    return { body: JSON.stringify({ error: 'upstream_not_json' }), status: 502 };
  }

  // Awaited, so the shaping step can consult KV — retention has to happen
  // BEFORE the put below, or the cache would serve an empty track for the whole
  // TTL and undo the point of retaining one.
  const body = JSON.stringify(await shape(payload));
  await cache.put(
    keyRequest,
    new Response(body, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${ttl}`,
      },
    })
  );
  return { body, status: 200 };
}

/**
 * Key for one vessel's history on one sailing.
 *
 * The voyage is part of the key rather than a field to compare, so a retained
 * track can never be served under a different cruise — the wrong wake beneath
 * the right route is the exact confusion clipping the track exists to prevent.
 * A new sailing simply misses, which is correct: it has no history yet.
 */
function trackKey(imo: string, startDate: string | null): string | null {
  if (!startDate) return null;   // nothing stable to key on
  return `track:${imo}:${startDate.replace(/[^0-9A-Za-z]/g, '')}`;
}

/**
 * Keeps the newest usable track, and hands one back when upstream has none.
 *
 * Writes are deliberately rare: only when nothing is stored for this voyage yet,
 * or what is stored is empty. Upstream re-decimates the whole span on every
 * request, so a fresh non-empty response is never *worse* than a stored one and
 * overwriting would buy nothing at the cost of a write per request. That makes
 * this roughly one write per vessel per sailing.
 *
 * Never throws. Retention is a nicety; a KV hiccup must not cost a user their
 * route and position too.
 */
async function retainedTrack(
  env: Env,
  imo: string,
  shaped: { track: Array<[number, number]>; voyage: { startDate: string | null } }
): Promise<Array<[number, number]> | null> {
  const key = trackKey(imo, shaped.voyage.startDate);
  if (!env.SHIP_TRACKS || !key) return null;

  try {
    if (shaped.track.length > 0) {
      const stored = await env.SHIP_TRACKS.get<Array<[number, number]>>(key, 'json');
      if (!stored || stored.length === 0) {
        // Expire well after any sailing ends, so the key clears itself.
        await env.SHIP_TRACKS.put(key, JSON.stringify(shaped.track), {
          expirationTtl: 60 * 60 * 24 * 30,
        });
      }
      return null;   // fresh is what we serve
    }

    const stored = await env.SHIP_TRACKS.get<Array<[number, number]>>(key, 'json');
    return Array.isArray(stored) && stored.length > 0 ? stored : null;
  } catch {
    return null;
  }
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

    // Every position the app can draw, in one response. Cached for a minute, so
    // the number of users makes no difference to how often upstream is asked.
    if (url.pathname === '/fleet') {
      const { body, status } = await fetchShaped(
        cacheKey('/fleet'),
        `${ORIGIN}/map/ships.json${FLEET_QUERY}`,
        shapeFleet,
        TTL.fleet
      );
      return new Response(body, {
        status,
        headers: {
          ...cors,
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': status === 200 ? `public, max-age=${TTL.fleet}` : 'no-store',
        },
      });
    }

    // Every vessel near a point, of any line. Detection only — see ALL_LINES.
    if (url.pathname === '/nearby') {
      const lat = Number(url.searchParams.get('lat'));
      const lon = Number(url.searchParams.get('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)
          || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return json({ error: 'bad_position' }, 400, cors);
      }

      const cLat = snap(lat);
      const cLon = snap(lon);
      const dLon = lonBox(cLat);
      const query = `?minLat=${(cLat - BOX).toFixed(2)}&maxLat=${(cLat + BOX).toFixed(2)}`
        + `&minLon=${(cLon - dLon).toFixed(2)}&maxLon=${(cLon + dLon).toFixed(2)}`
        + `&zoom=10&filter=${ALL_LINES}`;

      const { body, status } = await fetchShaped(
        cacheKey(`/nearby/${cLat.toFixed(2)},${cLon.toFixed(2)}`),
        `${ORIGIN}/map/ships.json${query}`,
        shapeNearby,
        TTL.nearby
      );
      return new Response(body, {
        status,
        headers: {
          ...cors,
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': status === 200 ? `public, max-age=${TTL.nearby}` : 'no-store',
        },
      });
    }

    // Track, route, ports and voyage for one vessel.
    const detail = url.pathname.match(/^\/ship\/([0-9]{7})$/);
    if (detail && validImo(detail[1])) {
      const imo = detail[1];
      const { body, status } = await fetchShaped(
        cacheKey(`/ship/${imo}`),
        `${ORIGIN}/map/ship.json?imo=${imo}`,
        async (payload) => {
          const shaped = shapeDetail(imo, payload);
          const retained = await retainedTrack(env, imo, shaped);
          if (retained) {
            shaped.track = retained;
            shaped.trackRetained = true;
          }
          return shaped;
        },
        TTL.detail
      );
      return new Response(body, {
        status,
        headers: {
          ...cors,
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': status === 200 ? `public, max-age=${TTL.detail}` : 'no-store',
        },
      });
    }

    // An allowlist rather than a prefix check. A proxy that forwards arbitrary
    // paths to a third party in our name is not a proxy, it is an open relay.
    return json({ error: 'not_proxied' }, 404, cors);
  },
} satisfies ExportedHandler<Env>;
