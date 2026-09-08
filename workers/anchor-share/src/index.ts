/**
 * The relay behind 2.0's shared anchors.
 *
 * Two devices that never meet need something always-on between them, and this
 * is the smallest thing that will do: it remembers what time it is for a person
 * and who is allowed to ask. See docs/version-2.0-plan.md for why it is a
 * Worker on D1 rather than a box.
 *
 * What it deliberately does not hold:
 *
 *   - a position. The anchor is a zone id or an offset — see src/anchor.ts,
 *     where the type has nowhere to put a latitude.
 *   - a history. Each write replaces the last, because a history of somebody's
 *     zones is a record of their movements and that is a different product.
 *   - an identity worth stealing. No email, no password, no name. An account is
 *     an opaque id and the rows that hang off it.
 *
 * The account id is the bearer token. That is a real decision rather than a
 * shortcut: there is nothing here that a password would protect which the id
 * does not, and every alternative brings recovery flows, a second factor, and a
 * privacy policy that has to talk about accounts — for a feature whose entire
 * payload is a timezone.
 */

import { validateAnchor, type Anchor } from '../../../src/anchor';
import { mintShareCode, normaliseShareCode } from '../../../src/share-code';

interface Env {
  DB: D1Database;
}

/**
 * Wide open, like the other three Workers, and for the same reason: the app is
 * served from more origins than are worth enumerating — Pages, capacitor://,
 * https://geotime.local, localhost. What guards this is the bearer token in the
 * Authorization header, not the origin the request came from, and a browser's
 * same-origin policy was never what was keeping anybody out.
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '3600',
} as const;

/**
 * How long an unredeemed code lives.
 *
 * The SHARE it creates has no expiry — it lives until somebody revokes it. This
 * is only the window in which the code itself opens a door, and a day is long
 * enough to read one out over a bad phone line and short enough that one left
 * in a chat log last month is inert.
 */
const CODE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Caps, in the place caps belong.
 *
 * Nothing is paid in 2.0.0, so these are not a paywall — they bound what one
 * account can cost while the feature is free and unproven. They are here rather
 * than in the app because a limit enforced on the client is a suggestion, and
 * because this is the seam a paid tier will eventually be drawn at: when there
 * is a plan to check, it is checked here, and the number changes rather than
 * the architecture.
 */
const MAX_FOLLOWING = 5;
const MAX_FOLLOWERS = 10;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      // Every response here is either somebody's private data or a one-shot
      // secret. None of it is ever worth a cache.
      'Cache-Control': 'no-store',
    },
  });

const fail = (error: string, status: number) => json({ error }, status);

const now = () => Date.now();
const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/**
 * The account making this request, or null.
 *
 * `last_seen_at` is touched on the way past. It is the only thing resembling
 * telemetry in here, and it exists so that an account nobody has opened in a
 * year can eventually be swept up — not so anybody can be watched.
 */
async function authenticate(request: Request, env: Env): Promise<string | null> {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;

  const row = await env.DB.prepare('SELECT account_id FROM accounts WHERE account_id = ?')
    .bind(token)
    .first<{ account_id: string }>();
  if (!row) return null;

  await env.DB.prepare('UPDATE accounts SET last_seen_at = ? WHERE account_id = ?')
    .bind(now(), token)
    .run();
  return row.account_id;
}

/** A body, or null — malformed JSON is a client error, not a 500. */
async function readJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * Mints an account and hands back its id.
 *
 * Minted HERE rather than on the device so the server owns the entropy. A
 * client-chosen id is a bearer token somebody else chose the strength of, and
 * while `crypto.randomUUID()` would in practice be fine, "in practice" is not a
 * property you want load-bearing under an authorization header.
 */
async function createAccount(env: Env): Promise<Response> {
  const accountId = crypto.randomUUID();
  const at = now();
  await env.DB.prepare(
    'INSERT INTO accounts (account_id, created_at, last_seen_at) VALUES (?, ?, ?)',
  )
    .bind(accountId, at, at)
    .run();
  return json({ accountId }, 201);
}

/** The sharer's side: this is what time it is for me now. */
async function putAnchor(request: Request, env: Env, account: string): Promise<Response> {
  const anchor = validateAnchor(await readJson(request));
  if (!anchor) return fail('invalid_anchor', 400);

  const at = now();
  // Replaces, never appends. See the note on `anchors` in schema.sql.
  await env.DB.prepare(
    `INSERT INTO anchors (account_id, payload, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET payload = excluded.payload,
                                             updated_at = excluded.updated_at`,
  )
    .bind(account, JSON.stringify(anchor), at)
    .run();
  return json({ updatedAt: at });
}

/** The sharer's side: mint a code for somebody to redeem. */
async function createShare(env: Env, account: string): Promise<Response> {
  const followers = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM shares WHERE sharer = ?',
  )
    .bind(account)
    .first<{ n: number }>();
  if ((followers?.n ?? 0) >= MAX_FOLLOWERS) return fail('too_many_followers', 409);

  const at = now();
  const shareId = crypto.randomUUID();
  const code = mintShareCode(randomBytes);

  await env.DB.prepare(
    `INSERT INTO shares (id, sharer, follower, code, created_at, redeemed_at, expires_at)
       VALUES (?, ?, NULL, ?, ?, NULL, ?)`,
  )
    .bind(shareId, account, code, at, at + CODE_TTL_MS)
    .run();

  return json({ shareId, code, expiresAt: at + CODE_TTL_MS }, 201);
}

/** The follower's side: I was given a code. */
async function redeemShare(request: Request, env: Env, account: string): Promise<Response> {
  const body = (await readJson(request)) as { code?: unknown } | null;
  const code = normaliseShareCode(typeof body?.code === 'string' ? body.code : '');
  if (!code) return fail('invalid_code', 400);

  const following = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM shares WHERE follower = ?',
  )
    .bind(account)
    .first<{ n: number }>();
  if ((following?.n ?? 0) >= MAX_FOLLOWING) return fail('too_many_following', 409);

  const share = await env.DB.prepare(
    'SELECT id, sharer, expires_at FROM shares WHERE code = ?',
  )
    .bind(code)
    .first<{ id: string; sharer: string; expires_at: number }>();

  // One answer for "no such code" and "expired", so that a wrong guess cannot
  // be told from a stale one. There is little to learn either way at forty
  // bits, but the cheapest time to not leak something is before it exists.
  if (!share || share.expires_at < now()) return fail('invalid_code', 404);
  if (share.sharer === account) return fail('cannot_follow_yourself', 400);

  const at = now();
  // Clearing the code is what makes it single-use, and doing it in the same
  // statement that claims the share is what makes two simultaneous redemptions
  // resolve to one winner: the second finds `code IS NULL` and changes nothing.
  const claimed = await env.DB.prepare(
    `UPDATE shares SET follower = ?, redeemed_at = ?, code = NULL
       WHERE id = ? AND code IS NOT NULL`,
  )
    .bind(account, at, share.id)
    .run();
  if (!claimed.meta.changes) return fail('invalid_code', 404);

  return json({ shareId: share.id }, 201);
}

/**
 * The follower's side: everybody I follow, and what time it is for them.
 *
 * A LEFT JOIN, so a share that has been redeemed but whose sharer has not yet
 * pushed an anchor comes back with a null one rather than vanishing. The app
 * would rather know the pairing worked and is waiting than be shown nothing.
 */
async function listFollowing(env: Env, account: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT s.id AS shareId, a.payload, a.updated_at AS updatedAt
       FROM shares s LEFT JOIN anchors a ON a.account_id = s.sharer
      WHERE s.follower = ?
      ORDER BY s.redeemed_at`,
  )
    .bind(account)
    .all<{ shareId: string; payload: string | null; updatedAt: number | null }>();

  const people = results.map((row) => ({
    shareId: row.shareId,
    // Validated on the way OUT as well as in. It was checked when it was
    // written, but the check has since been through a database and a JSON
    // round trip, and this is the last place that can decline to hand a
    // malformed row to a widget.
    anchor: row.payload ? validateAnchor(JSON.parse(row.payload) as unknown) : null,
    updatedAt: row.updatedAt,
  }));

  return json({ people });
}

/** The sharer's side: who is reading me, so that it can be stopped. */
async function listFollowers(env: Env, account: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id AS shareId, code, created_at AS createdAt, redeemed_at AS redeemedAt,
            expires_at AS expiresAt
       FROM shares WHERE sharer = ? ORDER BY created_at`,
  )
    .bind(account)
    .all<{
      shareId: string;
      code: string | null;
      createdAt: number;
      redeemedAt: number | null;
      expiresAt: number;
    }>();

  // The follower's account id is deliberately not in that SELECT. The sharer
  // has no use for it and it is somebody else's identifier.
  return json({
    followers: results.map((row) => ({
      shareId: row.shareId,
      // A code still outstanding, so the app can show it again rather than
      // mint a second one for the same intent.
      code: row.code && row.expiresAt >= now() ? row.code : null,
      createdAt: row.createdAt,
      redeemedAt: row.redeemedAt,
    })),
  });
}

/**
 * Either side may revoke, which is why the WHERE names both.
 *
 * The follower deleting their row and the sharer cutting somebody off are the
 * same operation on the same row, and there is no reason to make the person
 * being followed ask permission to stop being followed.
 */
async function revokeShare(env: Env, account: string, shareId: string): Promise<Response> {
  const result = await env.DB.prepare(
    'DELETE FROM shares WHERE id = ? AND (sharer = ? OR follower = ?)',
  )
    .bind(shareId, account, account)
    .run();
  if (!result.meta.changes) return fail('not_found', 404);
  return json({ revoked: shareId });
}

/**
 * Everything about this account, gone, now.
 *
 * The foreign keys cascade, so deleting the account takes the anchor and every
 * share with it — in both directions, so the rows on other people's devices
 * stop resolving too. Not required by any store rule while there are no
 * accounts to speak of, and here anyway: a feature that holds a fact about
 * somebody should be able to stop.
 */
async function deleteAccount(env: Env, account: string): Promise<Response> {
  await env.DB.prepare('DELETE FROM shares WHERE sharer = ? OR follower = ?')
    .bind(account, account)
    .run();
  await env.DB.prepare('DELETE FROM anchors WHERE account_id = ?').bind(account).run();
  await env.DB.prepare('DELETE FROM accounts WHERE account_id = ?').bind(account).run();
  return json({ deleted: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    const method = request.method;

    // The one route that cannot be authenticated, because it is what issues the
    // thing you would authenticate with.
    if (path === '/v1/account' && method === 'POST') return createAccount(env);

    const account = await authenticate(request, env);
    if (!account) return fail('unauthorized', 401);

    if (path === '/v1/anchor' && method === 'PUT') return putAnchor(request, env, account);
    if (path === '/v1/shares' && method === 'POST') return createShare(env, account);
    if (path === '/v1/shares/redeem' && method === 'POST') {
      return redeemShare(request, env, account);
    }
    if (path === '/v1/following' && method === 'GET') return listFollowing(env, account);
    if (path === '/v1/followers' && method === 'GET') return listFollowers(env, account);
    if (path === '/v1/me' && method === 'DELETE') return deleteAccount(env, account);

    const share = /^\/v1\/shares\/([A-Za-z0-9-]+)$/.exec(path);
    if (share && method === 'DELETE') return revokeShare(env, account, share[1]);

    return fail('not_found', 404);
  },
} satisfies ExportedHandler<Env>;

export type { Anchor };
