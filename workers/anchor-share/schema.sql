-- The relay's whole database.
--
-- Apply:  npm run db:anchor-share          (local)
--         npm run db:anchor-share:remote   (the real one)
--
-- Three tables, because the feature is three facts: who is asking, what time it
-- is for them, and who may read that. There is deliberately no fourth table for
-- where anybody is — the anchor is a zone id or an offset, and a position has
-- nowhere to go here even if one were sent.
--
-- Written to be re-runnable: every statement is IF NOT EXISTS, so applying it
-- to a database that already has it is a no-op rather than an error.

-- One row per install.
--
-- The account_id IS the bearer token: minted here so the server controls its
-- entropy, kept in the Keychain or the Keystore on the device, and sent as
-- `Authorization: Bearer <id>`. There is nothing else to authenticate with —
-- no email, no password, nothing to recover, nothing to breach.
--
-- It also exists so that billing has something to attach to later. Apple's
-- appAccountToken and Google's obfuscatedAccountId both want a stable opaque
-- id at purchase time, and minting one now costs nothing and saves a migration.
CREATE TABLE IF NOT EXISTS accounts (
  account_id   TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

-- One anchor per account: the latest, not a history.
--
-- A history would be a record of somebody's movements, which is the thing this
-- feature exists NOT to build. Each write replaces the last.
--
-- updated_at is stamped here, never taken from the device. A clock that is
-- wrong is the failure the whole app was built around, and a device asserting
-- its own freshness is exactly that failure with a network in front of it.
CREATE TABLE IF NOT EXISTS anchors (
  account_id TEXT PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  payload    TEXT NOT NULL,          -- JSON, validated by validateAnchor before it lands
  updated_at INTEGER NOT NULL
);

-- Who may read whom.
--
-- A row is created when the sharer mints a code, and completes when somebody
-- redeems it. Until then `follower` is null and `code` is set; afterwards the
-- code is cleared, which is what makes it single-use — there is no state column
-- to disagree with the data.
--
-- The SHARE has no expiry. It lives until it is revoked, by either side. The
-- CODE does: an unredeemed one is a loose end, and one left in a chat log a
-- month ago should not still open a door.
CREATE TABLE IF NOT EXISTS shares (
  id          TEXT PRIMARY KEY,
  sharer      TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  follower    TEXT REFERENCES accounts(account_id) ON DELETE CASCADE,
  code        TEXT,                  -- null once redeemed; UNIQUE below tolerates many nulls
  created_at  INTEGER NOT NULL,
  redeemed_at INTEGER,
  expires_at  INTEGER NOT NULL       -- of the CODE, not of the share
);

-- A partial index, so the uniqueness applies to live codes only. Every redeemed
-- share has a null code, and a plain UNIQUE would be fine with that too — but
-- being explicit says which rows the constraint is about.
CREATE UNIQUE INDEX IF NOT EXISTS shares_code ON shares(code) WHERE code IS NOT NULL;

-- The read path: one query per follower per refresh, joining anchors.
CREATE INDEX IF NOT EXISTS shares_follower ON shares(follower) WHERE follower IS NOT NULL;

-- The revoke path, and the cap on how many people may follow one person.
CREATE INDEX IF NOT EXISTS shares_sharer ON shares(sharer);
