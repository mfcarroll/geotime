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

### The anchor label is a garnish, not a guarantee

This was written up as the one hazard of the whole change: that the widget's
width budget would drop the label naming what everything is measured from, and
every offset would silently change meaning. So the label was made mandatory
aboard.

On a real widget that was worse than the problem. The row rendered:

```
St.. Ship time 🛳   11:23 PM
```

The vessel lost its **name** so the label could be kept. And the file already
said not to do that:

> Names are decided BEFORE the optional labels, because a name is content and a
> label is garnish: it would be wrong to keep "Tuesday" at the cost of
> abbreviating a vessel.

A guest aboard knows which ship they are on. They cannot recover a name the
layout has eaten. So the anchor label is optional like every other, and the ship
mark carries the meaning when the words will not fit — which is exactly how
"Local time" has always behaved ashore.

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

### The rule set, as settled

1. The candidates are device, ground, ship, and the saved world-clock entries.
2. The anchor is the ship when a marker confirms we are aboard, otherwise the
   ground.
3. Every offset is measured from the anchor.
4. The ground is always shown, with its pin.
5. Aboard, the ship is always shown, with its mark.
6. The phone gets a row only when it agrees with neither ship nor ground.
7. When it agrees with the anchor, it marks that row instead — aboard only.
8. When it agrees with the ground and the ground is not the anchor, it marks the
   ground row.
9. Saved zones fill what space is left, dropping any whose clock already appears
   above, nearest the anchor first. **Ships are outside this rule in both
   directions** — a vessel is not a timezone, so a saved city never hides a ship
   and a ship never hides a saved city.
10. The ground's offset is stated plainly aboard, in the same words every other
    row uses.

### What changed from the first attempt

The first design kept the 1.4.0 fold and gated everything on the anchor alone.
That was more complicated and worse. Rules 4 and 5 delete the fold outright —
ship and ground are two different facts and each earns a line — and rule 6
replaces a redundant phone row with a mark on the row it agrees with.

Three reversals of long-standing behaviour, all deliberate:

- **Saved zones sharing an offset are now deduped** in the widget. The reasoning
  that kept both was that they diverge in November; the answer is that the
  widget is the summary and the app is the complete list, so they should
  diverge *there*, on the day it starts meaning something.
- **Ship and ground no longer merge when their clocks agree**, except in the one
  case the fold was ever really for: mid-ocean, where the ground has no name and
  its row would read "UTC−5" beside a ship showing the same hour.
- **Trimming keeps the zones nearest the anchor.** It used to keep the first N of
  an offset-sorted list, which meant whichever cities lay furthest west — an
  accident of the sort order rather than a decision.

### Ships are not timezones

The no-repeated-clocks rule applies to *zones*. A ship is a named thing you are
on or about to board, and a city that happens to keep the same hour is not
another copy of it — so neither hides the other, in either direction.

The case that settles it: in Vancouver, with San Francisco saved, and a ship
docked alongside. All three keep the same clock, and the right answer is two
rows.

| | |
| --- | --- |
| Vancouver | kept — where you actually are wins the slot |
| San Francisco | folded — a second copy of the same hour |
| Star of the Seas | kept — not a timezone, so not a duplicate |

The ground claims its offset before any saved city is considered, which is why
the Vancouver-beats-San-Francisco half needed no code at all. Only the ship
needed exempting.

**Proximity, in the general case, is not computable here.** The widget receives
zone identifiers and no coordinates, so "keep the nearest" cannot mean
geographic distance. What it does mean is that the row for where you are claims
its clock first. Two *saved* cities sharing an offset with each other and not
with you — London and Lisbon, say — are still resolved by list order, which is
arbitrary. Worth knowing; not obviously worth fixing.

### What the old fold did with this case

Worse than either dropping the ship or showing it. The ship's name did not join
your row, it **replaced** your place name:

```swift
name: agreeingShip?.name ?? localPlaceName ?? TimezoneDisplay.displayName(...)
```

So standing in Vancouver with a ship alongside, your own pinned row read "Star of
the Seas" and Vancouver was nowhere — silently, since the matching clocks made
the time right either way.

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
