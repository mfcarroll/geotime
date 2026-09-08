# GeoTime 2.0 — sharing your anchor time (planning)

Status: **decided, alpha in progress.** Written after 1.7.0 shipped
(7 September 2026), while the place model and the widget's row rules were fresh;
the decisions below were settled the same day and the alpha follows them.

## What it is

You can let someone else see your **anchor time** — the clock you are actually
living by — on their own home-screen widget. Ashore that is the timezone you are
standing in, named for the town; aboard a ship it is the ship's clock, which is
a crew-set offset with no timezone behind it. It updates whenever your device
has a network connection. Their widget shows a row for you the way it shows a
row for a saved city or a ship today.

That needs a server for the first time: two devices that never meet have to
exchange a small fact through something that is always on.

## What it is not

**It is not location sharing.** The fact that crosses the wire is *what time it
is for you*, expressed as a timezone id or an offset plus the name of the place
or ship — never coordinates. A timezone is a region the size of a country; a
town name is what the app already shows on a widget without a second thought.
Position stays on the device, as it does today. This is the single biggest
scoping decision and it should be made deliberately rather than drifted into,
because "share my time" and "share where I am" are different products with
different consent and different regulatory weight.

## How it fits what already exists

Almost every piece the follower's side needs is already built:

| Need | Already have |
| --- | --- |
| A clock with no timezone, set by an offset | Ship rows: `offsetMinutes` → fixed-offset zone, on the list, the map card and both widgets |
| A row named for a person or thing, sub-labelled with where it is | Place rows: `label` + `Timezone: X` / ship rows: name + line |
| The anchor as a first-class concept, land or sea | `aboardShip()`, `anchorOffsetHours`, the blue card, "Local time" / "Ship time" |
| Rows that are never collapsed into a timezone because they are not one | Ships sit outside the repeated-clock rule "in both directions" |
| A widget that fetches over the network on its own refresh cycle | `ShipTimeFetcher.refreshStaleShips` — `URLSession` from inside the iOS widget |
| A payload from app to both widgets through one bridge | `WidgetBridge.setTimezones` — parallel arrays plus `ships[]` |
| Edge functions, deployed from this repo | Three Workers: `utc-time`, `rccl-proxy`, `ship-track`; `npm run deploy:workers` |

So a followed person is, to the widget, **a ship row with a different icon**:
a name, a clock that may be a zone or an offset, and a line saying where they
are. The dedupe rules that took a day to get right in 1.7.0 need one addition —
a person is never a duplicate of a timezone, for the same reason a ship is not.

The one genuinely new thing is the relay in the middle.

## Shape of the system

```
  sharer's app                     relay (server)                  follower's app
  ─────────────                    ──────────────                  ──────────────
  anchor changes                   stores one anchor per account   app foreground /
  (zone, place; or ship, offset)   and who may read it             background refresh
        │                                 ▲          │                     │
        └── PUT /v1/anchor ───────────────┘          └── GET /v1/following ┘
                                                                            │
                                                              WidgetBridge.setTimezones
                                                              (people[] beside ships[])
                                                                            │
                                                                     home-screen widget
```

Push from the sharer, pull by the follower. A widget cannot hold a connection
open and refreshes on a budget the OS controls, so "real-time" is not on the
table on any platform; the realistic freshness is the widget's own refresh
cadence (tens of minutes), which is also all the feature needs — a timezone
does not change often, and even a ship's clock changes at most once a day.

### The fact that crosses the wire

```jsonc
{
  "kind": "zone" | "ship",
  "tz": "America/Vancouver",          // ashore: the follower's device works out DST itself
  "offsetMinutes": -240,              // aboard: crew-set, no zone exists
  "place": "Nelson",                  // what the sharer's own card says
  "ship": { "name": "Wonder of the Seas", "short": "Wonder" },   // aboard only
  "updatedAt": 1788770000000          // stamped by the server, not the device
}
```

Sending the **timezone id** ashore rather than an offset is what keeps the
server out of DST: the follower's device knows when America/Vancouver changes
and the server never has to. Aboard there is no id to send, so the offset goes
as it does for ships today. This is exactly the duality the app already lives
with; the wire format is the anchor as it stands.

`updatedAt` is what drives honesty on the far end. The app's existing rule for
positions — *a fact always has an age, and the honest treatment is to show it
with its age rather than pretend it is live or unknown* — applies here
unchanged. A row that has not been updated in a day says so — and keeps its
row. It is never hidden for being old: dropping it would be the app claiming to
know the person is gone, when all it knows is that it has not heard.

### Identity: codes, not accounts

The simplest thing that works and does not foreclose billing:

1. **Each install mints an `accountId`** — a random UUID — on first launch and
   keeps it in the Keychain (iOS) / Keystore-backed storage (Android). No
   sign-in, no email, no password. It is the bearer token for the API.
2. **Pairing is by share code.** The sharer taps *Share my time*, the relay
   mints a short single-use code (or a link that deep-links into the app), the
   follower enters it, and the relay records *follower may read sharer's
   anchor*. Generating the code is the consent; it expires unredeemed within a
   day; either side can revoke at any time.
3. **The follower names the row** — "Dad", "Sarah" — the way they name any
   saved place. The sharer's own place or ship name is the sub-label.

Why this and not Sign in with Apple / Google: an account system brings password
recovery, multi-device linking, the App Store's in-app account-deletion rule,
and a privacy policy that talks about accounts — for a feature whose only
shared fact is a timezone. The `accountId` gives billing something to attach to
(see below) without any of that. If multi-device or recovery becomes a real
need, Sign in with Apple can be added later to *link* two `accountId`s; nothing
has to be migrated.

## The API lives on a name we own

Decided while building the alpha, and applied to the three Workers that
predate it as well as the new one:

```
geotime-api.matthewcarroll.ca/time/…    → geotime-utc-time
                             /rccl/…    → geotime-rccl-proxy
                             /ships/…   → geotime-ship-track
                             /anchor/…  → geotime-anchor-share
```

**Why now.** These URLs are compiled into binaries that go to the App Store and
Play, and a shipped build calls whatever it was built with for as long as it is
installed. `*.workers.dev` is Cloudflare's name, not ours: the day any of it has
to move, every install still points at the old one and the only fix is an update
every user has to take. 2.0 is the release that changes these URLs anyway.

**Why a gateway rather than four names.** A Cloudflare custom domain binds a
whole hostname to one Worker, so four Workers on one hostname needs something to
dispatch between them. Four flat hostnames would work and is four CSP entries
and not a namespace; nesting them (`anchor.geotime-api.…`) falls outside
Cloudflare's universal certificate, which covers exactly one level of subdomain.
So: a small Worker that routes by path prefix, strips it, and forwards over a
service binding — Worker to Worker inside the network, no second trip off the
edge.

**Stripping the prefix is what makes it free.** The RCCL proxy forwards
`url.pathname` upstream verbatim and the ship tracker matches `/fleet` exactly;
both would break if they could see a prefix. Handled at the gateway, none of the
three needed a line changed, and their `*.workers.dev` names keep working for
every 1.7.0 install in the field. Nothing shipped breaks.

**Infrastructure as code.** Everything is declarative except one thing:

| | How |
| --- | --- |
| Workers | `wrangler.jsonc` each; `wrangler deploy` reconciles |
| The hostname, its DNS record and certificate | `routes: [{ custom_domain: true }]` — wrangler creates them |
| Service bindings | a list in the gateway's config |
| D1 schema | `schema.sql`, re-runnable, one npm script |
| **Creating the D1 database** | `npm run provision` — the gap, because an id is generated at creation and cannot be written down in advance |

`scripts/provision.mjs` closes that last one: it asks what exists before making
anything, records the generated id where the binding will look for it, refuses
to overwrite an id it did not put there, and dry-runs by default. Terraform
would cover the same ground and is more machinery than four Workers and one
database deserve — the escalation path if this ever grows a second environment.

## Platform options

The workload: tiny writes (one anchor per person, when it changes), tiny reads
(one query per follower per widget refresh), a handful of tables, no long-lived
processes, no heavy compute. Hobby scale for a long time; should not need
re-platforming if it grows.

| | Fit | For | Against |
| --- | --- | --- | --- |
| **Cloudflare Workers + D1** | ★★★★★ | Already run three Workers from this repo with deploy scripts wired; zero servers; scales to zero; global edge; D1 is SQLite so the schema is three tables and a migration file; generous free tier at this scale | Not Node (though `nodejs_compat` covers most); D1 is the newest piece; one more vendor dependency, though it is one you already have |
| **Cloud Run + Firestore** (GCP) | ★★★★ | Real container runtime; scales to zero; Firestore's offline SDKs if you ever want a live-updating client; stays inside GCP where you already have a footprint | A Docker image, IAM, a build pipeline, cold starts; Firestore's data model is a worse fit than SQL for "who may read whom"; more moving parts for the same three tables |
| **Firebase** (Auth + Firestore + Functions) | ★★★ | Batteries-included auth if accounts are wanted; realtime out of the box | Pulls the app into Google's identity model and a heavy client SDK; realtime is a feature the widget cannot use anyway |
| **Supabase** | ★★★ | Postgres with row-level security; auth built in; good free tier | Another vendor, another dashboard, for a workload that does not need Postgres |
| **The small GCP VPS** | ★★ | Total control; SQLite or Postgres; nothing new to learn | A machine to patch, monitor, back up and keep up; single region, single point of failure — the weakest reliability per unit of effort for something other people's widgets will depend on. Right for a prototype or anything needing a long-lived process, and nothing here does |
| Others (Fly.io, Lambda + DynamoDB, Vercel functions) | ★★ | Each fine in isolation | Each is a new vendor for no advantage over the two you already operate |

## Recommendation

**A fourth Worker, `workers/anchor-share`, backed by a D1 database.** Deployed
the way the other three are.

Why: the marginal operational cost is nearly zero because the tooling exists,
the workload is exactly what edge functions are for, and it costs nothing at
hobby scale while growing without a re-platform. Cloud Run is the honest
runner-up if you would rather consolidate on GCP or foresee needing a full Node
runtime; it is more machinery for the same result.

Suggested shape (three tables, one Worker, six routes):

```sql
devices      (device_id, account_id, platform, created_at, last_seen_at)
anchors      (account_id PRIMARY KEY, payload JSON, updated_at)
shares       (id, sharer_account, follower_account NULL, code, status,
              created_at, redeemed_at, revoked_at)
-- later:
entitlements (account_id, plan, source, expires_at, verified_at, raw)
```

```
POST   /v1/devices           register; returns nothing new — the accountId is the token
PUT    /v1/anchor            sharer: the fact above; server stamps updatedAt
POST   /v1/shares            sharer: mint a code (single-use, ~40 bits, expires unredeemed)
POST   /v1/shares/redeem     follower: code → recorded share
GET    /v1/following         follower: [{ shareId, anchor, updatedAt }] — one query
DELETE /v1/shares/:id        either side: revoke
DELETE /v1/me                everything about this account, immediately
```

Widget integration: **the app fetches, not the widget, in 2.0.** On foreground
and on background refresh the app calls `/v1/following` and hands the result to
`WidgetBridge.setTimezones` as a `people[]` array beside `ships[]`. Both widgets
already know how to draw the shape. Widget-side fetching (the
`ShipTimeFetcher` pattern) is a 2.1 refinement if staleness between app opens
turns out to matter; it will matter less than it sounds, because WidgetKit's
refresh budget bounds freshness either way.

Ship anchors do **not** leak the RCCL app key. The sharer's device resolves the
ship's offset as it does today and shares the *resolved offset*; the follower
never talks to the ship API. The key stays where it is.

## Forward-looking: subscriptions

Not built in 2.0, but 2.0 must not make it hard. Three things settle that:

1. **Mint the `accountId` now**, even though nothing bills against it. It is
   also the value to pass as Apple's `appAccountToken` and Google's
   `obfuscatedAccountId` at purchase time, which is how a store transaction gets
   tied to *this* identity without an account system. Costs nothing today;
   saves a migration later.
2. **Gate on the server, not the client.** Whatever the paid line turns out to
   be, the check belongs in the Worker at the point a share is minted or
   redeemed. The client shows the paywall; the server enforces it. Then the
   line can move — 1 follower free, 5 paid; or free to follow, paid to be
   followed; or paid for friends' *ship* tracking — without re-architecture.
3. **In-app purchase is the only route on the stores.** Digital features
   unlocked inside the app must go through StoreKit 2 and Play Billing; Stripe
   is out for iOS/Android. Verification is a server job: App Store Server API
   (signed JWS transactions) and Google Play Developer API plus RTDN webhooks.
   Both are plain HTTPS and fit in a Worker; the `entitlements` table above is
   where the verified result lands.

Where the paid line goes is a product decision, not an architectural one — see
question 5.

## Decided

Settled 7 September 2026, before the alpha was built.

| | Decision |
| --- | --- |
| Identity | **Share codes**, no accounts. An `accountId` is minted anyway, as the hook billing will need later. |
| What is shared | **The anchor only.** Never coordinates. This is a feature of the privacy policy, not a limitation to apologise for. |
| Share lifetime | **Until revoked** — by the sharer, or by the recipient deleting the row. No TTL. |
| Paid in 2.0.0 | **No.** Free, to learn from. The server-side gate goes in anyway, so the line can be drawn later without re-architecture. |
| Staleness | **Stale after 24 hours, but never hidden.** The row stays and says so. Hiding a row because it is old is the app pretending it knows something it does not. |
| Web follow | **Not in 2.0.** |

The questions below are what those answers were chosen from, kept because the
reasoning is worth more than the conclusion when one of them is reopened.

## Questions considered

Identity and consent

1. **Codes, or accounts?** Recommendation above is codes. Confirm.
2. **Share the anchor only, or position too?** Recommendation: anchor only,
   and say so in the privacy policy as a feature.
3. **One-way or mutual?** One-way is simpler and mutual is just two one-ways.
   Recommendation: one-way, with an "ask them to share back" affordance.
4. **Does a share expire?** Indefinite until revoked, or a TTL ("for this
   cruise", 30 days)? Both are one column. Leaning indefinite, with the
   anchor's own staleness doing the work.

Product

5. **Where is the paid line?** Options: followers you can *have* (being
   followed by more than N), people you can *follow*, ship-mode features for
   friends, history. Also: is anything paid in 2.0 at all, or is 2.0 free to
   learn from?
6. **Is there a free cap in 2.0 regardless**, to bound cost and leave room
   above it? A soft cap of ~5 followees costs nothing and is honest.
7. **Staleness UX.** How old before a row says "as of yesterday"? How old
   before it is hidden? *Decided: stale past 24 hours, said plainly on the row;
   never hidden, however old. Server-side deletion of untouched anchors is a
   housekeeping question, not a UI one, and is left for later.*
8. **Naming.** Follower names the row; does the sharer's *own* display name
   travel too (so a code redeemed shows "Sarah" before you rename it)?
9. **Web parity.** Does geotime.app (GitHub Pages) get a follow view? Useful,
   but the web has no widget and a weaker place to keep an `accountId`.
   Recommendation: not in 2.0.

Behaviour

10. **Update cadence from the sharer.** On every anchor change, plus a
    heartbeat while aboard (the ship's clock can change overnight)? Every 6–12
    hours is plenty and costs nothing in battery.
11. **Multiple devices, one person.** Two `accountId`s until Sign in with
    Apple links them. Acceptable for 2.0?
12. **Offline follower.** Cache the last `/v1/following` response and keep
    drawing it, aged. Yes — this is the app's existing philosophy.

Compliance and hygiene

13. **Privacy policy.** `privacy.html` needs a section: what is shared (a
    timezone and a place name, never coordinates), with whom (people you gave
    a code to), for how long, and how to delete it.
14. **Deletion.** `DELETE /v1/me` and a button for it. Not strictly required
    by the App Store without accounts, but it is the right thing and it is
    cheap.
15. **Abuse.** Codes are single-use, short-lived and high-entropy;
    rate-limit redemption attempts. Anchors are tiny, so cost abuse is not a
    real vector.

## Phasing

**2.0** — the relay and the rows. Worker + D1; `accountId` minted; share
codes; `PUT /v1/anchor` from the sharer on change; `GET /v1/following` from the
follower's app; `people[]` through the bridge; rows on the list, the map card
and both widgets; revoke; delete; privacy policy. Free, with a soft cap.

**2.0.0-alpha** — the vertical slice, in this order, so each step is usable
before the next exists: the Worker and its schema, tested on its own; the
client's identity and transport; minting and redeeming a code; the anchor
pushed and the followed pulled; rows in the app. The widgets come last because
they are the best-understood part — a person is a ship row with a different
icon — and because everything above has to be right first.

**2.1** — polish that needs real use to tune. Staleness thresholds; heartbeat
while aboard; widget-side fetch if app-open frequency proves too low; the
"share back" affordance.

**2.x** — billing, when there is something worth charging for. StoreKit 2 +
Play Billing on the client; verification in the Worker; the `entitlements`
table; the server-side gate at share creation. The paywall line chosen from
whatever 2.0 taught.

**Later, if needed** — Sign in with Apple to link devices; a web follow view.

## Risks worth naming now

- **Freshness expectations.** Users may expect a live clock and get one that
  updates every 15–60 minutes and only when the sharer's device has signal. Set
  the expectation in the UI ("updated 20 min ago"). At sea the sharer may be
  offline for a day; the row should age gracefully rather than vanish.
- **Widget refresh budgets** are the real ceiling on both platforms and no
  server choice changes them.
- **A dependency on a paid service.** Today the app degrades gracefully when
  every external service is down. Followed rows should too: last-known,
  aged, never blank.
- **Scope creep toward location.** "Since we have a server, why not show where
  they are on the map?" is the obvious next ask and a different product. Decide
  it on purpose (question 2).
- **Account Holder dependencies.** In-app purchase setup, agreements and
  banking on the App Store side need Todd, as the 1.7.0 submission did. Build
  billing on a timeline that assumes that.
