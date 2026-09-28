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
 *   - an identity worth stealing. No email, no password. An account is an
 *     opaque id, the name its owner chose, and the rows that hang off it.
 *
 * WHO IS ASKING is a DEVICE: each has its own random token, and this database
 * holds only the token's hash (see `devices` in schema.sql). One person may
 * read their people on a phone, a tablet and a browser, and each can be
 * removed without the others noticing. Nothing here is a password somebody
 * chose, so there is still nothing to recover and nothing to reset — a new
 * device is linked from one that already is, and a person who loses every
 * device starts again. For a feature whose payload is a timezone, that is the
 * right trade rather than a missing feature.
 */

import { anchorAsSeen, cleanDisplayName, validateAnchor, type Anchor } from '../../../src/anchor';
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

/** Devices per account, pending ones included. A family's worth of screens. */
const MAX_DEVICES = 6;

/**
 * How long a link code lives, and how long the device that claims one has to
 * be approved. Minutes, not a day: both devices are in the same person's hands,
 * so there is no phone line to read it over and no reason for it to outlive
 * the moment. See `link_codes` in schema.sql for why it is stricter than a
 * share code in every other way too.
 */
const LINK_TTL_MS = 10 * 60 * 1000;

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

/** The device making a request, and the account it acts for. */
interface Caller {
  account: string;
  device: string;
  pending: boolean;
  primary: boolean;
  platform: string;
}

/** 256 random bits, base64url: the credential a device keeps. */
function mintToken(): string {
  const bytes = randomBytes(32);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** What is stored in place of a token. See `devices` in schema.sql. */
async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The device making this request, or null.
 *
 * `last_seen_at` is touched on the way past, on the device and on the account.
 * It is the only thing resembling telemetry in here: the device's is what
 * "Your devices" shows so an old browser session can be recognised and
 * removed, and the account's is so that one nobody has opened in a year can
 * eventually be swept up — not so anybody can be watched.
 */
async function authenticate(request: Request, env: Env): Promise<Caller | null> {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;

  const row = await env.DB.prepare(
    `SELECT device_id, account_id, status, is_primary, platform, created_at
       FROM devices WHERE token_hash = ?`,
  )
    .bind(await hashToken(token))
    .first<{
      device_id: string; account_id: string; status: string;
      is_primary: number; platform: string; created_at: number;
    }>();
  if (!row) return null;

  // A claim nobody approved in time. Gone, rather than left to be approved an
  // hour later by somebody who has forgotten what they were being asked.
  if (row.status === 'pending' && row.created_at + LINK_TTL_MS < now()) {
    await env.DB.prepare('DELETE FROM devices WHERE device_id = ?').bind(row.device_id).run();
    return null;
  }

  const at = now();
  await env.DB.batch([
    env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE device_id = ?').bind(at, row.device_id),
    env.DB.prepare('UPDATE accounts SET last_seen_at = ? WHERE account_id = ?').bind(at, row.account_id),
  ]);
  return {
    account: row.account_id,
    device: row.device_id,
    pending: row.status === 'pending',
    primary: row.is_primary === 1,
    platform: row.platform,
  };
}

const PLATFORMS = new Set(['ios', 'android', 'web']);

/** What a device says it is, bounded. Labels are hints for their owner, not facts. */
function describeDevice(body: unknown): { platform: string; label: string | null } {
  const source = (body && typeof body === 'object' ? body : {}) as { platform?: unknown; label?: unknown };
  const platform = typeof source.platform === 'string' && PLATFORMS.has(source.platform)
    ? source.platform : 'web';
  return { platform, label: cleanDisplayName(source.label) };
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
 * Mints an account, and the device that asked for it.
 *
 * Minted HERE rather than on the device so the server owns the entropy: a
 * client-chosen token is a credential somebody else chose the strength of.
 *
 * The first device shares its owner's time — it is the only one there is — so
 * it is the primary, unless it is a browser. A browser cannot be: it knows
 * where the computer is, which is not where the person is, and it is closed
 * more than it is open. In the app a browser only ever joins by being linked,
 * so this is a rule for the server to hold rather than a case the app meets.
 */
async function createAccount(request: Request, env: Env): Promise<Response> {
  // The name arrives with the account rather than in a second call, because the
  // very first thing anybody does with a new account is mint a code — and a
  // code whose share has no name on it hands the other end a blank row.
  const body = (await readJson(request)) as { name?: unknown } | null;
  const name = cleanDisplayName(body?.name);
  const { platform, label } = describeDevice(body);

  const accountId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const token = mintToken();
  const at = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO accounts (account_id, created_at, last_seen_at, display_name)
         VALUES (?, ?, ?, ?)`,
    ).bind(accountId, at, at, name),
    env.DB.prepare(
      `INSERT INTO devices (device_id, account_id, token_hash, platform, label, status,
                            is_primary, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).bind(deviceId, accountId, await hashToken(token), platform, label,
           platform === 'web' ? 0 : 1, at, at),
  ]);
  return json({ accountId, deviceId, token, primary: platform !== 'web' }, 201);
}

/**
 * The two things about an account that its owner chooses.
 *
 * One route rather than two because they are set together on one screen and
 * neither means much without the other: a name is what a follower calls you,
 * and the switch is how much they are told. Both are optional in the body, so
 * this doubles as "just change the switch".
 */
async function putProfile(request: Request, env: Env, account: string): Promise<Response> {
  const body = (await readJson(request)) as { name?: unknown; shareExact?: unknown } | null;
  if (!body) return fail('invalid_profile', 400);

  const name = 'name' in body ? cleanDisplayName(body.name) : undefined;
  // Nothing but a real boolean flips a privacy switch. A truthy string is
  // somebody's bug, and guessing which way they meant it is not this layer's
  // business when one direction is the safe one.
  const exact = typeof body.shareExact === 'boolean' ? body.shareExact : undefined;
  if (name === undefined && exact === undefined) return fail('invalid_profile', 400);

  if (name !== undefined) {
    await env.DB.prepare('UPDATE accounts SET display_name = ? WHERE account_id = ?')
      .bind(name, account).run();
  }
  if (exact !== undefined) {
    await env.DB.prepare('UPDATE accounts SET share_exact = ? WHERE account_id = ?')
      .bind(exact ? 1 : 0, account).run();
  }
  return json({ ok: true });
}

/**
 * The sharer's side: this is what time it is for me now.
 *
 * From the primary device only. The others are the same person reading on
 * another screen, and letting each of them report where it is would have the
 * account's time flip between them — see `devices` in schema.sql. Refused
 * here, not merely skipped in the app, so that a device which has missed the
 * news that it is no longer primary cannot drag anybody's time anywhere.
 */
async function putAnchor(request: Request, env: Env, caller: Caller): Promise<Response> {
  if (!caller.primary) return fail('not_primary', 409);
  const account = caller.account;
  const anchor = validateAnchor(await readJson(request));
  if (!anchor) return fail('invalid_anchor', 400);
  // A device says where its clock comes from; it does not get to say what a
  // follower is shown. An OffsetAnchor is this relay's own output — accepting
  // one back would mean storing a number with no rules attached, and losing the
  // daylight-saving correctness that computing it here exists to provide.
  if (anchor.kind === 'offset') return fail('invalid_anchor', 400);

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
    `SELECT s.id, s.sharer, s.expires_at, u.display_name AS name
       FROM shares s JOIN accounts u ON u.account_id = s.sharer
      WHERE s.code = ?`,
  )
    .bind(code)
    .first<{ id: string; sharer: string; expires_at: number; name: string | null }>();

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

  // The name comes back with the share so the new row arrives already called
  // something. Nothing else about the sharer does, and the follower can rename
  // it to whatever they like — locally, for good.
  return json({ shareId: share.id, name: share.name }, 201);
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
    `SELECT s.id AS shareId, a.payload, a.updated_at AS updatedAt,
            u.display_name AS name, u.share_exact AS shareExact
       FROM shares s
       JOIN accounts u ON u.account_id = s.sharer
       LEFT JOIN anchors a ON a.account_id = s.sharer
      WHERE s.follower = ?
      ORDER BY s.redeemed_at`,
  )
    .bind(account)
    .all<{
      shareId: string; payload: string | null; updatedAt: number | null;
      name: string | null; shareExact: number;
    }>();

  const people = results.map((row) => {
    // Validated on the way OUT as well as in. It was checked when it was
    // written, but the check has since been through a database and a JSON
    // round trip, and this is the last place that can decline to hand a
    // malformed row to a widget.
    const stored = row.payload ? validateAnchor(JSON.parse(row.payload) as unknown) : null;
    const anchor = anchorAsSeen(stored, row.shareExact === 1);
    return {
      shareId: row.shareId,
      // Their own name for themselves, offered as the label for this row. The
      // follower may already have replaced it with "Mum", which is their
      // business and happens entirely on their device.
      name: row.name,
      anchor,
      // The stamp goes with the anchor: an anchor we declined to show has no
      // age worth reporting either.
      updatedAt: anchor ? row.updatedAt : null,
    };
  });

  return json({ people });
}

/** The sharer's side: who is reading me, so that it can be stopped. */
async function listFollowers(env: Env, account: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT s.id AS shareId, s.code, s.created_at AS createdAt,
            s.redeemed_at AS redeemedAt, s.expires_at AS expiresAt,
            f.display_name AS name
       FROM shares s
       LEFT JOIN accounts f ON f.account_id = s.follower
      WHERE s.sharer = ? ORDER BY s.created_at`,
  )
    .bind(account)
    .all<{
      shareId: string;
      code: string | null;
      createdAt: number;
      redeemedAt: number | null;
      expiresAt: number;
      name: string | null;
    }>();

  // The join reaches accounts for the NAME and stops there. The follower's
  // account id is still deliberately absent: the sharer has no use for it, it
  // is somebody else's bearer token, and a name is the whole of what this
  // screen needs to say who is on the other end. LEFT, because an unredeemed
  // code has no follower to name yet.
  return json({
    followers: results.map((row) => ({
      shareId: row.shareId,
      // The other half of point 5: "somebody is following you" was true and
      // useless. A share that has been taken up now says by whom, using the
      // name they chose for themselves.
      name: row.name,
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
  // Every device goes with it — deleting is about the person, not the screen
  // they happened to press it on. One batch, so it cannot stop half-way.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM shares WHERE sharer = ? OR follower = ?').bind(account, account),
    env.DB.prepare('DELETE FROM anchors WHERE account_id = ?').bind(account),
    env.DB.prepare('DELETE FROM link_codes WHERE account_id = ?').bind(account),
    env.DB.prepare('DELETE FROM devices WHERE account_id = ?').bind(account),
    env.DB.prepare('DELETE FROM accounts WHERE account_id = ?').bind(account),
  ]);
  return json({ deleted: true });
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/**
 * Who this device is, and everything account-wide it needs to draw its screen.
 *
 * The one route a PENDING device may call, and what it polls while it waits:
 * it learns only that it is still waiting, and nothing about the account it is
 * asking to join until a device already linked has said yes.
 *
 * For an approved one: the profile, so a device that did not set the name
 * shows it rather than a blank; the account's anchor exactly as stored, so a
 * device that is not the primary can preview what followers are shown; and
 * every device, so any of them can be recognised and removed.
 */
async function getMe(env: Env, caller: Caller): Promise<Response> {
  if (caller.pending) return json({ status: 'pending', deviceId: caller.device });

  const [account, anchor, devices] = await Promise.all([
    env.DB.prepare('SELECT display_name, share_exact FROM accounts WHERE account_id = ?')
      .bind(caller.account)
      .first<{ display_name: string | null; share_exact: number }>(),
    env.DB.prepare('SELECT payload, updated_at FROM anchors WHERE account_id = ?')
      .bind(caller.account)
      .first<{ payload: string; updated_at: number }>(),
    env.DB.prepare(
      `SELECT device_id, platform, label, status, is_primary, created_at, last_seen_at
         FROM devices WHERE account_id = ? AND (status = 'active' OR created_at >= ?)
        ORDER BY created_at`,
    )
      .bind(caller.account, now() - LINK_TTL_MS)
      .all<{
        device_id: string; platform: string; label: string | null; status: string;
        is_primary: number; created_at: number; last_seen_at: number;
      }>(),
  ]);
  if (!account) return fail('unauthorized', 401);

  return json({
    status: 'active',
    accountId: caller.account,
    deviceId: caller.device,
    primary: caller.primary,
    name: account.display_name,
    shareExact: account.share_exact === 1,
    anchor: anchor ? validateAnchor(JSON.parse(anchor.payload) as unknown) : null,
    anchorUpdatedAt: anchor?.updated_at ?? null,
    devices: devices.results.map((row) => ({
      deviceId: row.device_id,
      platform: row.platform,
      label: row.label,
      pending: row.status === 'pending',
      primary: row.is_primary === 1,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    })),
  });
}

/** How many devices an account has, counting claims still waiting for an answer. */
async function deviceCount(env: Env, account: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM devices
      WHERE account_id = ? AND (status = 'active' OR created_at >= ?)`,
  )
    .bind(account, now() - LINK_TTL_MS)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * A code to type into the device being linked.
 *
 * One live per account: minting another replaces it, so a code read out and
 * then thought better of stops working the moment a new one is shown.
 */
async function createLinkCode(env: Env, caller: Caller): Promise<Response> {
  if (await deviceCount(env, caller.account) >= MAX_DEVICES) {
    return fail('too_many_devices', 409);
  }

  const at = now();
  const code = mintShareCode(randomBytes);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM link_codes WHERE account_id = ?').bind(caller.account),
    env.DB.prepare(
      `INSERT INTO link_codes (code, account_id, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
    ).bind(code, caller.account, caller.device, at, at + LINK_TTL_MS),
  ]);
  return json({ code, expiresAt: at + LINK_TTL_MS }, 201);
}

/**
 * The new device's side: I was shown a code on my other one.
 *
 * Unauthenticated, like creating an account, because a device with no token
 * is exactly who calls it. What it gets back is a token for a PENDING device,
 * which can do nothing until a device already linked approves it — so a code
 * guessed, or read out to the wrong person, gets them a request that can be
 * refused rather than an account. Spent on first use; see redeemShare for why
 * the DELETE is what decides a race.
 */
async function claimLinkCode(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const typed = (body as { code?: unknown } | null)?.code;
  const code = normaliseShareCode(typeof typed === 'string' ? typed : '');
  if (!code) return fail('invalid_code', 400);

  const link = await env.DB.prepare(
    'SELECT account_id, expires_at FROM link_codes WHERE code = ?',
  )
    .bind(code)
    .first<{ account_id: string; expires_at: number }>();
  // One answer for "no such code" and "expired", as for share codes.
  if (!link || link.expires_at < now()) return fail('invalid_code', 404);

  const spent = await env.DB.prepare('DELETE FROM link_codes WHERE code = ?').bind(code).run();
  if (!spent.meta.changes) return fail('invalid_code', 404);

  if (await deviceCount(env, link.account_id) >= MAX_DEVICES) {
    return fail('too_many_devices', 409);
  }

  const { platform, label } = describeDevice(body);
  const deviceId = crypto.randomUUID();
  const token = mintToken();
  const at = now();
  await env.DB.prepare(
    `INSERT INTO devices (device_id, account_id, token_hash, platform, label, status,
                          is_primary, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
  )
    .bind(deviceId, link.account_id, await hashToken(token), platform, label, at, at)
    .run();
  return json({ deviceId, token }, 201);
}

/** Yes, that one is mine. From any device already linked to the account. */
async function approveDevice(env: Env, caller: Caller, deviceId: string): Promise<Response> {
  const result = await env.DB.prepare(
    `UPDATE devices SET status = 'active'
      WHERE device_id = ? AND account_id = ? AND status = 'pending' AND created_at >= ?`,
  )
    .bind(deviceId, caller.account, now() - LINK_TTL_MS)
    .run();
  if (!result.meta.changes) return fail('not_found', 404);
  return json({ approved: deviceId });
}

/**
 * Removes a device, or turns down one asking to be linked — the same act.
 *
 * Any linked device may remove any other: they are all the same person. The
 * last one may not remove itself, because that would leave an account nothing
 * can reach, still visible to its followers and impossible to delete. Deleting
 * the account is the way to leave entirely, and says so.
 *
 * Removing the primary leaves the account with none until another is chosen.
 * Followers see the time age rather than change, which is honest: nobody is
 * currently saying where this person is.
 */
async function removeDevice(env: Env, caller: Caller, deviceId: string): Promise<Response> {
  const target = await env.DB.prepare(
    'SELECT status FROM devices WHERE device_id = ? AND account_id = ?',
  )
    .bind(deviceId, caller.account)
    .first<{ status: string }>();
  if (!target) return fail('not_found', 404);

  if (target.status === 'active') {
    const active = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM devices WHERE account_id = ? AND status = 'active'`,
    )
      .bind(caller.account)
      .first<{ n: number }>();
    if ((active?.n ?? 0) <= 1) return fail('last_device', 409);
  }

  await env.DB.prepare('DELETE FROM devices WHERE device_id = ? AND account_id = ?')
    .bind(deviceId, caller.account)
    .run();
  return json({ removed: deviceId });
}

/**
 * Makes a device the one that shares this person's time.
 *
 * Never a browser: see createAccount. The two updates go in one batch so there
 * is no moment with two primaries, which the partial index would refuse anyway,
 * or with none.
 */
async function makePrimary(env: Env, caller: Caller, deviceId: string): Promise<Response> {
  const target = await env.DB.prepare(
    `SELECT platform FROM devices WHERE device_id = ? AND account_id = ? AND status = 'active'`,
  )
    .bind(deviceId, caller.account)
    .first<{ platform: string }>();
  if (!target) return fail('not_found', 404);
  if (target.platform === 'web') return fail('cannot_be_primary', 400);

  await env.DB.batch([
    env.DB.prepare('UPDATE devices SET is_primary = 0 WHERE account_id = ?').bind(caller.account),
    env.DB.prepare('UPDATE devices SET is_primary = 1 WHERE device_id = ?').bind(deviceId),
  ]);
  return json({ primary: deviceId });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    const method = request.method;

    // The two routes that cannot be authenticated, because they are what issue
    // the thing you would authenticate with.
    if (path === '/v1/account' && method === 'POST') return createAccount(request, env);
    if (path === '/v1/devices/claim' && method === 'POST') return claimLinkCode(request, env);

    const caller = await authenticate(request, env);
    if (!caller) return fail('unauthorized', 401);

    if (path === '/v1/me' && method === 'GET') return getMe(env, caller);
    // A device waiting to be approved may ask whether it has been, and nothing
    // else. In particular it may not read the people this account follows.
    if (caller.pending) return fail('pending', 403);

    const account = caller.account;
    if (path === '/v1/anchor' && method === 'PUT') return putAnchor(request, env, caller);
    if (path === '/v1/profile' && method === 'PUT') return putProfile(request, env, account);
    if (path === '/v1/shares' && method === 'POST') return createShare(env, account);
    if (path === '/v1/shares/redeem' && method === 'POST') {
      return redeemShare(request, env, account);
    }
    if (path === '/v1/following' && method === 'GET') return listFollowing(env, account);
    if (path === '/v1/followers' && method === 'GET') return listFollowers(env, account);
    if (path === '/v1/me' && method === 'DELETE') return deleteAccount(env, account);

    const share = /^\/v1\/shares\/([A-Za-z0-9-]+)$/.exec(path);
    if (share && method === 'DELETE') return revokeShare(env, account, share[1]);

    if (path === '/v1/devices/link' && method === 'POST') return createLinkCode(env, caller);
    const device = /^\/v1\/devices\/([A-Za-z0-9-]+)(\/approve|\/primary)?$/.exec(path);
    if (device && !device[2] && method === 'DELETE') return removeDevice(env, caller, device[1]);
    if (device?.[2] === '/approve' && method === 'POST') return approveDevice(env, caller, device[1]);
    if (device?.[2] === '/primary' && method === 'POST') return makePrimary(env, caller, device[1]);

    return fail('not_found', 404);
  },
} satisfies ExportedHandler<Env>;

export type { Anchor };
