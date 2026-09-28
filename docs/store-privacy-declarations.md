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
| A random account id | minted by the relay, `POST /v1/account` | first pairing. Not a credential |
| A random key per device | minted by the relay; it stores only the SHA-256 | in every request, as the bearer token |
| The device's kind and a label, e.g. `Chrome on macOS` | `deviceLabel` in `src/device-label.ts`, from the user agent | when the account is created, or a device is linked |
| When each device was last used | stamped by the relay on each request | always; shown under "Your devices" |
| A display name you type | `state.shareName`, `PUT /v1/profile` | with the account, and whenever you change it |
| An IANA zone id, e.g. `America/Vancouver` | `anchorFrom` in `src/anchor.ts` | on change, and every 6h (`HEARTBEAT_MS`) |
| A ship's name and its offset | same, while aboard | instead of the zone |

Never sent: **anything narrower than a zone**. Not coordinates, and not the
town name either — the device knows its nearest town and its own widget draws
it, and that is where the knowledge stops. `ZoneAnchor` has no field for one,
`anchorFrom` has no parameter for one, and `validateAnchor` drops one if a
payload arrives carrying it, at both ends, because both ends run that same
file. `anchor.test.ts` fails if any of that stops being true.

Also never sent: the device's own identifiers (no IDFV, no Android ID, no
advertising identifier), an email address, contacts, or any history. The relay
keeps one anchor per account and each write replaces the last (`schema.sql`).
The per-device key is the relay's own random number, and the label is the
browser or platform name, which is what lets somebody recognise their tablet in
"Your devices" and remove it.

The name you give somebody you follow never leaves the device at all.

## Apple — App Privacy

Nothing is used for tracking, and no third-party SDK collects anything, so
**Data Used to Track You** stays empty.

**Identifiers → User ID.** Purpose: App Functionality. Linked to the user: yes
— it is the account the shares hang off, which is what "linked" means here,
even though it is tied to no real-world identity.

**Identifiers → Device ID.** Purpose: App Functionality. Linked to the user:
yes. New with linked devices: each device has its own random key and id on the
relay, tied to the account. Apple's definition is "the device's advertising
identifier, or other device-level ID", and this is a device-level ID even
though it is ours rather than the platform's. Declaring it is the safe reading;
leaving it out is the one that can come back as a rejection.

**Usage Data → Product Interaction.** Purpose: App Functionality. Linked to the
user: yes. The relay keeps when each device and the account were last used.
That is a timestamp, not analytics, and it is arguable either way; declaring it
costs nothing and matches what "Your devices" visibly shows.

**Contact Info → Name.** Purpose: App Functionality. Linked to the user: yes.
Self-provided, unverified, and shown to the people you share with, which is the
entire reason it exists — a row on somebody's home screen with a clock and no
name on it says nothing. Declared anyway: it is a name, the user typed it, and
it leaves the device.

**Location → Coarse Location.** Purpose: App Functionality. Linked to the
user: yes. Not used for tracking.

This was "none" until 28 September 2026, and the reasoning behind that did not
hold. It rested on a misquoted threshold: Apple's Coarse Location is anything
coarser than a latitude and longitude to three decimal places — about 110 m —
with no lower bound at all. (The three kilometres the old text quoted is
Google's, and Google's is a minimum area, not a maximum.) By the definition as
written, a town is coarse location, a region is, and so, read literally, is a
timezone.

And the relay does hold one. A zone id like `Australia/Sydney` says roughly
where somebody is, the app works it out from the device's GPS, and the relay
stores it for every sharer — "Share my exact timezone" only decides what
FOLLOWERS are shown (see anchorAsSeen), not what the server keeps. Aboard, it
stores the ship's name, and a ship's position is public. Declaring it costs one
line on the label; not declaring it is the answer that can come back as a
rejection.

What stays true, and is the point of the design: nothing narrower than a zone
ever leaves the device. An earlier build of 2.0 sent the nearest town's name
beside the zone, on the argument that "Birmingham" makes a better row than
"Europe/London". Sending the town was dropped, and the map paints a whole
offset band rather than the single zone within it.

**Linked to the user — yes, for every type above.** Apple's test is "linked to
the user's identity (via their account, device, or details)", and everything
the relay holds hangs off an account id and device ids. That the account is
tied to no email or real-world identity does not make it unlinked: "Not
Linked" is for data de-identified before collection, such as an analytics
event with no id, and nothing here is. The display name is also personal
information in the sense Apple's note means — its whole purpose is to tell the
people who follow somebody who they are, and those people know.

## Google Play — Data safety

Play Console → **Policy and programs → App content → Data safety**. The form
applies to the app as a whole, not to a release, so it can be submitted before
2.0 ships; over-declaring for 1.7.0 in the meantime is harmless. The privacy
policy URL is on its own card on the same page, and unlike Apple's can be
changed at any time: `https://geotime.app/privacy`.

**Data collection and security**

- Collects or shares required user data types: **Yes**.
- All user data encrypted in transit: **Yes** — HTTPS to the Workers, with no
  plaintext path.
- Account creation: GeoTime has no sign-up, no login and nothing to recover, so
  "My app does not allow users to create an account" describes it. The account
  on the relay is an anonymous record behind the Share and Follow buttons, not
  something a person creates or signs in to. If Play pushes back, the other
  answer is "Other", with the privacy policy's deletion paragraph as the
  deletion link.
- Users can request that data is deleted: **Yes** — **Delete my sharing data**
  on the Sharing card, which calls `DELETE /v1/me` and takes every linked
  device with the account.

**Data types** — four categories, five types:

| Category | Type | Why |
|---|---|---|
| Location | Approximate location | the zone or ship; Google's definition is any area of 3 km² or more, "such as the city you're in" |
| Personal info | Name | the name somebody types for themselves |
| Personal info | User IDs | the account id — Play's examples are "an account ID, account number, or account name", the counterpart of Apple's User ID |
| App activity | App interactions | each device's last-used time |
| Device or other IDs | Device or other IDs | the relay's per-device id; Play's own examples include a Firebase installation ID, the same kind of thing. Not the hardware or advertising id |

**For each type, the same four answers:**

- Collected or shared: **Collected** only. Play does not count as sharing a
  transfer "based on a specific user-initiated action where the user
  reasonably expects the data to be shared" — which is exactly what giving
  somebody a code is — nor a transfer to a service provider, which is what
  Cloudflare is.
- Processed ephemerally: **No**. It is stored.
- Required or optional: **Users can choose** — none of it exists until
  somebody taps Share your time or follows a code.
- Purpose: **App functionality**.

## The sentence both forms are really asking for

The app sends what time it is for you. The narrowest thing it sends is the
timezone you are in — a region shared by millions of people, never a town or a
position — and unless you choose otherwise, the people you share with are told
only how far your clock is from theirs. That is coarse location by the forms'
definitions, and it is declared as such; it is not where you are.
