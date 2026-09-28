-- The relay's whole database.
--
-- Apply:  npm run db:anchor-share          (local)
--         npm run db:anchor-share:remote   (the real one)
--
-- Three tables for the feature's three facts — who is asking, what time it is
-- for them, and who may read that — and two for the devices a person reads it
-- on. There is deliberately no table for where anybody is: the anchor is a zone
-- id or an offset, and a position has nowhere to go here even if one were sent.
--
-- Written to be re-runnable: every statement is IF NOT EXISTS, so applying it
-- to a database that already has it is a no-op rather than an error.

-- One row per person.
--
-- The account_id is NOT a secret. It was, in the alpha — it was the bearer
-- token — and that made it wrong for the two things it is for: a person with a
-- second device needs one account behind two credentials, and billing will hand
-- this id to Apple as appAccountToken and to Google as obfuscatedAccountId,
-- which would have meant handing the stores a password. Credentials live in
-- `devices` below, one per device, stored only as hashes.
--
-- display_name is what the person calls THEMSELVES, and the only text in this
-- database that a human chose. It goes both ways: a follower sees it as the
-- suggested label for their new row, and the sharer sees the follower's in
-- "who can see your time". Nothing else about either of them crosses, and the
-- recipient is free to overwrite the label locally — "Mum" is theirs to pick.
--
-- share_exact is the one privacy switch. 0, the default, means a follower is
-- given a bare offset computed at read time; 1 means they are given the zone id
-- itself. It lives on the ACCOUNT rather than on each share because it is a
-- fact about the person, and a control that only applied to shares made after
-- you flipped it would be a trap.
--
-- NOTE FOR AN EXISTING DATABASE: SQLite has no ADD COLUMN IF NOT EXISTS, so a
-- change to this table means dropping it rather than migrating. That is a
-- deliberate non-problem while nothing has shipped, and the alpha's rows were
-- test data. The devices change below needed no column here, so it did not.
--
-- An alpha account has no device, so nothing can sign in as it any more. Its
-- rows are inert, and the app drops the old id on update (see account.ts).
CREATE TABLE IF NOT EXISTS accounts (
  account_id   TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  display_name TEXT,
  share_exact  INTEGER NOT NULL DEFAULT 0
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

-- One row per device that can act for an account: a phone, a tablet, a browser.
--
-- The TOKEN is the credential: 256 random bits, minted here, sent as
-- `Authorization: Bearer <token>`, and stored only as its SHA-256. A copy of
-- this table lets nobody sign in. A fast hash rather than a slow one is right
-- for a random token — slowness is for passwords a person chose, where there
-- is a small space worth searching; here there is none.
--
-- Exactly one device per account shares that person's time: is_primary, which
-- the partial index below keeps unique. Everything else is account-wide —
-- the people you follow, who can see you, your name and your switch — because
-- it is one person reading it on more than one screen. Only the time is not,
-- because two devices in two places would take turns being "where you are":
-- a tablet left at home would drag you back there on every heartbeat.
--
-- status 'pending' is a device that has claimed a link code and is waiting to
-- be approved on one that is already linked. Until then it can do nothing but
-- ask whether it has been. An unapproved one lapses with its code's window.
CREATE TABLE IF NOT EXISTS devices (
  device_id    TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  platform     TEXT NOT NULL,          -- ios | android | web
  label        TEXT,                   -- "iPhone", "Chrome on macOS"; see src/device-label.ts
  status       TEXT NOT NULL,          -- active | pending
  is_primary   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS devices_account ON devices(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS devices_one_primary ON devices(account_id) WHERE is_primary = 1;

-- A code shown on a linked device, to be typed into a new one.
--
-- Stricter than a share code in every way, because it hands over more: a share
-- code lets somebody read your time, and a link code lets a device act as you.
-- Ten minutes rather than a day, one live per account, spent on first use — and
-- even then it only makes a PENDING device, which a device already linked has
-- to approve. Reading one out to the wrong person gets them a request you can
-- refuse, not your account.
CREATE TABLE IF NOT EXISTS link_codes (
  code       TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,            -- the device showing it
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS link_codes_account ON link_codes(account_id);
