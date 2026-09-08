# Store privacy declarations, as of 2.0.0

Both stores ask what the app collects, in their own vocabulary, and both
answers changed in 2.0.0 — before it, the honest answer on both was "nothing".
This is the derivation, so the next person filling the forms in does not have
to re-read the client to work out what to tick.

These are console tasks. Nothing in the repo sets them, and a build that ships
with a stale declaration is a policy violation on both platforms even when the
code and the privacy policy are correct.

## What actually leaves the device

Everything below happens only after somebody taps **Share your time** or enters
a code. An install that never does that has no record on the server at all —
see `ensureAccount` in `src/anchor-share.ts`, which is deliberately lazy.

| What | Where it is built | Sent when |
|---|---|---|
| A random account id | minted by the relay, `POST /v1/account` | first pairing, then in every request as a bearer token |
| An IANA zone id, e.g. `America/Vancouver` | `anchorFrom` in `src/anchor.ts` | on change, and every 6h (`HEARTBEAT_MS`) |
| The nearest town's name, e.g. `Nelson` | same, from `state.localPlaceName` | with the zone, whenever the app has one |
| A ship's name and its offset | same, while aboard | instead of the zone |

Never sent: coordinates, a device identifier, an advertising identifier, an
email address, a name, contacts, or any history. The relay keeps one anchor per
account and each write replaces the last (`schema.sql`).

The name you give somebody you follow never leaves the device at all.

## Apple — App Privacy

Two data types. Neither is used for tracking, and no third-party SDK collects
anything, so **Data Used to Track You** stays empty.

**Identifiers → User ID.** Purpose: App Functionality. Linked to the user: yes
— it is the account the shares hang off, which is what "linked" means here,
even though it is tied to no real-world identity.

**Location → Coarse Location.** Purpose: App Functionality. Linked to the user:
yes.

Coarse Location is the one that takes a moment's thought, and the answer is
yes. Apple defines it as location at lower resolution than three kilometres,
and a town name is exactly that. The zone id alone would not qualify — a
timezone is thousands of kilometres wide — but the app sends the town beside it
whenever it has one, and a declaration that covered only the zone would be
wrong. Precise Location stays unticked: coordinates never leave the device.

## Google Play — Data safety

**Location → Approximate location.** Collected: yes. Shared: yes — with the
people the user gives a code to, which is the point of the feature. Processed
ephemerally: no, it is stored until replaced or deleted. Required: no, the
feature is optional. Purpose: App functionality.

**App activity / App info and performance:** nothing.

**Device or other IDs:** no. The account id is minted by our own server and is
not a device identifier; Play's category is about advertising and device IDs.
It is worth writing "an account identifier we generate, not a device ID" in the
free-text if the form offers one.

Data is encrypted in transit (HTTPS to the Worker, no plaintext path) and the
user can request deletion — both are separate yes/no questions on the form, and
both are yes. The deletion path is the **Delete my sharing data** button on the
Sharing card, which calls `DELETE /v1/me`.

## The sentence both forms are really asking for

The app sends what time it is for you and, when it knows one, the name of your
nearest town. It never sends where you are.
