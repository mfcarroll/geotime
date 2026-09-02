# Next minor version — planning

Three items raised after 1.5.0 went out.

**Items 1 and 3 are done.** Item 2 remains, and is the one with a design
question inside it. The write-ups for the finished two are kept because they
record why each was built the way it was.

| | Status |
| --- | --- |
| 1. Ship destination is misleading | done |
| 2. Ship time as the reference while aboard | **resolver done, view + Android open** |
| 3. Red x on the wrong row | done |

---

## 1. The ship's destination line is misleading — DONE

### What it says now

```
Star
+2 hrs
→ Cozumel · ETA
September 2, 11:15
```

Three faults, of which the third is the substantive one.

**No AM/PM.** Every other time in the app runs through our own formatter; this
one never has. `eta` is upstream's raw string passed straight through:

```ts
// workers/ship-track/src/index.ts
eta: typeof payload?.eta === 'string' ? payload.eta : null,
```

and `setShipVoyageLine()` in `src/map.ts` prints it verbatim. So it inherits
whatever convention CruiseMapper used, which is 24-hour and unlabelled.

**It states an arrival that has already happened.** The example above was
captured at 16:05 ship time on 2 September, against an ETA of 11:15 the same
day. The vessel had been alongside for five hours. An ETA in the past is worse
than no ETA: it reads as a live prediction and is not one.

**It answers the wrong question.** Alongside in Cozumel, "when do we arrive" is
settled. The passenger's question is *when does the ship leave* — the one number
that decides how long they have ashore.

### The data is already there

| Signal | Where | Note |
| --- | --- | --- |
| Speed over ground | `ShipFix.sog` | its own comment already says *"0 means alongside or at anchor"* |
| Port positions | `ShipVoyage.ports[].lat/lon` | |
| Departure time | `ShipPort.depart` | from upstream `dep_datetime` |
| Distance helper | `distance()` in `src/utils.ts` | already used by `onLocationSuccess` |

So no new upstream call and no Worker change — the fields are already shaped and
crossing the wire.

### Proposed rule

```
if sog ≈ 0 and within N km of a port that has a departure still ahead:
    Cozumel · Dep. 4:30 PM
otherwise:
    → Cozumel · ETA 11:15 AM
```

### What was decided

- **N is 10 km, gated behind speed.** Several Caribbean calls are tender ports
  where the ship anchors well offshore, so "at the pier" was never the test. A
  vessel under 0.7 knots that close to a scheduled call is at it, and the speed
  gate is what lets the distance be loose. 0.7 rather than 0, because AIS
  reports a tenth of a knot of drift on a moored hull and a hard zero would
  flicker the line between fixes.
- **The last port says `In <port>`** rather than inventing an arrival. A call
  whose departure has already passed says the same — a ship running late or a
  stale itinerary both get the place without a time, which is still the useful
  half.
- **Which clock: port time, and this did not need item 2 after all.** The card
  had already decided, in a comment predating this whole thread, that an
  itinerary time is "a scheduled arrival at that port, in that port's time —
  the conventional reading and the only one it can have". Following the decision
  already in the code beat re-opening it. What is new is that the times are now
  **labelled** `port time` when the port's clock and the ship's disagree, and
  left unlabelled when they match, which is the common case alongside.

### Verified

All three branches, against live vessels rather than fixtures:

| Branch | Ship | Result |
| --- | --- | --- |
| At sea | Star of the Seas | `→ Roatan Island · ETA 12:15 PM port time` — label fired, Roatan being UTC-6 against the ship's UTC-5 |
| In port, departure ahead | Anthem of the Seas | `Sitka · Dep. 5:00 PM` — no label, both on Alaska time |
| In port, final call | Serenade of the Seas | `In Vancouver` — replacing an ETA of *August 31*, two days stale |

The Serenade case is the original complaint reproduced on a second ship, which
is worth noting: the stale ETA was never specific to one voyage.

---

## 2. Ship time as the reference while aboard

### The proposal

While — and only while — the wifi signal confirms we are aboard, offsets are
calculated from ship time instead of the geographic zone.

```
Nelson    2:10 PM
-2 hrs

Star 🛳   4:10 PM
Ship time

Havana ↗  5:10 PM
+1 hr
```

### Why this is right, not an exception

It reads at first like a carve-out from the app's principle that true geographic
time is the baseline. It is better understood as a sharpening of it.

The principle was never really "geographic time wins". It is *"the baseline is
the clock you are actually living by, and it is stated explicitly."* Ashore
those are the same thing, so the distinction never had to be made. Aboard they
come apart: ship time is what every announcement, dinner booking and gangway
time refers to, while geographic time aboard is close to meaningless — the
vessel is often in a zone nobody observes, and the crew sets the clock
deliberately against it.

By that reading, re-basing while aboard follows the principle rather than
breaking it. Refusing to re-base is what would make the app inconsistent: it
would show a passenger offsets from a clock nobody on the ship is using.

It also makes the GPS row earn its place. `Havana ↗ +1 hr` says how far the
shore you are about to step onto is from the ship's clock, which is exactly the
number a passenger wants before going ashore.

### The condition: the anchor label must never be trimmed

This is the one hazard, and it is not hypothetical. The widget already drops
labels when width is short:

```swift
// ios/App/GeoTimeWidget/GeoTimeWidget.swift
let showLocalLabel: Bool   // "Local time" tag on the local row (single-line only)
```

If that same trimming ever reaches the ship-time anchor, every offset in the
list silently changes meaning with nothing on screen to say so. That is
precisely the failure this app exists to prevent, and it would be invisible in
testing on a wide device.

**The "Ship time" label must be exempt from the width budget, ahead of every
other label — full weekday names, "Device time", and "Local time" included.** If
it will not fit, something else gives way.

### Where the baseline actually lives

Better news than expected. It is a single variable in each of three places.

| Surface | Site | Baseline |
| --- | --- | --- |
| Web app | `src/time.ts` (~190, ~196) | `formatOffsetDiff(offset - localOffset)` and `getTimezoneOffset(entry.tzid, localTimezone)` |
| iOS widget | `ios/App/Shared/ZoneRowResolver.swift:33` | `let localOffset = local.secondsFromGMT(for: now)`, fed to every `relativeOffset(…, deviceSeconds:)` at ~88, ~114, ~139 |
| Android widget | `GeoTimeWidgetProvider.java` | its own equivalent |

The arithmetic change is therefore small. The risk is entirely in labels and in
the two rules that currently key off the same variable — see below.

### The boundary for the main app

The part that was hard to picture. The rule that resolves it:

> **Re-base offsets. Do not touch absolute times.**

| Surface | Changes? | Why |
| --- | --- | --- |
| Local / Ship / Device cards | **No** | absolute times, each already labelled; nothing there is relative |
| World Clock row offsets | **Yes** | relative to the ship |
| The ship's own row | **Yes** | reads "Ship time" instead of an offset |
| Selected-zone chip on the map (`Nuuk +3 hrs`) | **Yes** | same baseline, or the map disagrees with the list beneath it |
| Blue GPS band on the map | **No** | geographic, and means "where you are" |

That keeps the whole change to one idea: *offsets are from the clock you are
living by.* The cards stay as they are, which also means the Ship Time card at
the top of the page keeps stating the anchor in full.

### Settled while writing the tests

The expected values had to be written by hand, and doing that is what exposed
the design flaw: **`isLocal` was doing two jobs.** Ashore the GPS zone is both
where you are and what everything is measured from, so one flag covered both and
nobody noticed. Aboard they separate, and both facts still want saying — so the
row gained `isAnchor` beside `isLocal`. The GPS row keeps its pin and gains an
offset, exactly as the mockup had it.

The parameter is `aboardShipKey: String?`, not a Bool: the list may hold several
ships and only one is underfoot. `nil` is ashore, which is also the default, so
every existing caller keeps its behaviour and the ashore tests stay valid
unchanged. A key naming a ship that is not in the list — an offset that never
resolved — falls back to the geographic anchor rather than anchoring on nothing.

The fold still compares against the GEOGRAPHIC offset rather than the anchor: it
exists to lend a name to a row that would otherwise read "UTC−5" mid-ocean, and
that is a fact about where you are, not about which clock you keep.

### Still open

**The widget view, which is where the documented hazard actually lives.**
`GeoTimeWidget.swift` hardcodes the string `"Local time"` and gates it on
`metrics.showLocalLabel`, so it neither reads the anchor's label nor protects
it from the width budget. The resolver now produces the right text; nothing
displays it yet. This is the next piece and it is the risky one.

**Android.** `GeoTimeWidgetProvider.java` still has the old single-baseline
rule. The shared case table that would stop the two drifting does not exist yet.

**The main app.** `src/time.ts` is untouched; the extraction that makes its
baseline testable has not been done.

### Two decisions the matrix forced into the open

Both are live choices rather than defects, and both are written as tests so the
current answer is visible and a change of mind fails a test rather than drifting
silently.

1. **Does the device row still appear when it matches the ground but not the
   ship?** Currently yes — everything is gated against the anchor, keeping the
   resolver's "ONE RULE for every special row". The cost is a visibly redundant
   row: the same figure as the pin row beside it, on the smallest surface the
   app has.
2. **Should the ground row say more than a bare offset once it stops being the
   anchor?** Currently no — it reads "+1 hr" and the pin carries the meaning,
   which is what the mockup showed. The case against is that the pin is the
   smallest thing on the row and the first thing dropped when width runs short.

### Open questions

**The row-fold rule inverts.** `ZoneRowResolver.swift:49` folds a ship whose
offset matches the base into the local row:

```swift
let agreeingShip = ships.first { $0.offsetMinutes * 60 == localOffset }
```

That is the "like Vancouver" behaviour added in 1.4.0. With the ship as the
base it still merges, but which label wins? Almost certainly "Ship time" — it
is the anchor, and losing it to "Local time" would remove the only thing making
the other offsets readable. Wants confirming on a device.

**The dedup rule shifts with it.** `ZoneRowResolver.swift:124` drops zones whose
offset equals the base:

```swift
if offset == localOffset { continue }
```

Change the base and a different set of the user's saved cities disappears from
the widget. Probably correct, possibly surprising, worth seeing.

**The transition.** Boarding or leaving re-bases every offset at once. If it
happens while someone is looking at the list, every number changes with no
explanation. The label changing from an offset to "Ship time" may well be
explanation enough — but this is the part to watch on a real transition rather
than reason about. The onboard gateway harness (`scripts/ship-gateway.mjs`) can
drive it from a desk: `echo shore > /tmp/ship-mode` flips it live.

**Only on confirmed-aboard.** The trigger must stay the wifi marker, never a
guess from proximity or from having a ship on the list. A wrongly re-based list
ashore would be the worst version of this.

### Effort

The arithmetic is a day. The label discipline, the two rules above and testing
the transition are the rest, and they are where this could go wrong quietly.

---

## 3. Red × appears on the wrong row — DONE

### Reproduced

Seen while capturing the 1.5.0 screenshots: tapping × on Los Angeles left the
*Star of the Seas* row's × showing red. It was written off at the time as a
hover state. It is one.

### Cause

```html
<!-- index.html -->
<button class="remove-btn text-gray-500 hover:text-red-400 transition-colors">
```

`tailwind.config.js` does not set `hoverOnlyWhenSupported`, so Tailwind 3
compiles `hover:` to a bare `:hover` with no `@media (hover: hover)` guard. On
touch, iOS keeps `:hover` applied to whatever was last tapped until something
else is tapped. The list re-renders on removal, the next row slides into the
tapped position, and it wears the red.

That accounts for both halves of the report: *another* entry, and *never at any
other time*.

### Fix

Add to `tailwind.config.js`:

```js
future: { hoverOnlyWhenSupported: true },
```

It also fixes the pin button's yellow hover, which has the same bug and has not
been noticed.

Worth a quick sweep for any `hover:` that was doing load-bearing work on touch,
though there should not be one — a hover style that mattered on a touch device
was already broken in the other direction.

### Effort

Minutes, plus a rebuild and a look on device.

---

## What happened to the order

The plan was 3, then 2, then 1 — on the reasoning that item 2 would settle which
clock item 1's times are stated in. Item 1 went ahead of item 2 instead, and the
question resolved itself: this card had **already** decided, in a comment
predating all of this, that itinerary times are port time. Following the
decision already in the code beat re-opening it, and the basis label covers the
case where it matters.

Item 2 is unaffected by that and still stands on its own.
