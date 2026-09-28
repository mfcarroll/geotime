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

**Location: none.** Neither Precise nor Coarse.

That answer is worth its own paragraph, because it was nearly the other one. An
earlier build of 2.0 sent the nearest town's name beside the zone, on the
argument that "Birmingham" makes a better row than "Europe/London". It does —
and Apple defines Coarse Location as location at lower resolution than three
kilometres, which a town name plainly is, so that build would have had to
declare it. Sending the town was dropped instead.

What can travel now is a zone id, and only if the user turns on "Share my exact
timezone" — off by default, in which case the relay passes on a bare offset and
not even the region. A zone is thousands of kilometres wide and describes
millions of people at once, so neither state is location under anybody's
definition, and the app declines to narrow it anywhere else either: the map
paints a whole offset band rather than the single zone within it.

## Google Play — Data safety

**Location:** nothing. Neither approximate nor precise. Same reasoning as
above: a timezone is not an approximate location, it is a fact about a clock —
and by default not even that is passed on, only an offset.

**Personal info → Name.** Collected: yes. Shared: yes, with the people the user
gives a code to. Required: no. Purpose: App functionality. Self-provided and
unverified.

**App activity / App info and performance:** nothing.

**Device or other IDs:** yes, since linked devices. Collected: yes. Shared: no.
Required: yes, for sharing. Purpose: App functionality. Play's own examples
include a Firebase installation ID, and the relay's per-device id is the same
kind of thing: generated by us, one per install, tied to the account. It is not
the hardware or advertising identifier, and the free-text is the place to say
so.

**App activity → App interactions:** yes, for the same reason as Apple's
Product Interaction above: the last-used time of each device. Purpose: App
functionality.

Data is encrypted in transit (HTTPS to the Worker, no plaintext path) and the
user can request deletion — both are separate yes/no questions on the form, and
both are yes. The deletion path is the **Delete my sharing data** button on the
Sharing card, which calls `DELETE /v1/me` and takes every linked device with
the account.

## The sentence both forms are really asking for

The app sends what time it is for you. It never sends where you are, and there
is nothing in what it does send that anyone could work that out from.
