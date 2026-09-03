# Next minor version — planning

Three items raised after 1.5.0 went out, plus a fourth that arrived by a
different route — item 4 is the write-up of a question we could only answer
from a ship, and we now have the answer.

**Items 1, 2 and 3 are done.** Item 4 is not scheduled: it is a refinement of
something that already works well enough without it, recorded so the
measurements do not have to be taken twice.

| | Status |
| --- | --- |
| 1. Ship destination is misleading | done |
| 2. Ship time as the reference while aboard | done |
| 3. Red x on the wrong row | done |
| 4. Browser ship detection | answered — not scheduled |

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

## 2. Ship time as the reference while aboard — DONE

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
layout has eaten.

Making the label merely *optional* was not enough, because the budget that grants
it is not sound. The city font is sized from a scale computed WITHOUT labels, and
`max(9, ...)` can override even that — so a label is granted without ever being
checked against the row it lands on. Ashore that rarely bites, since "Local time"
sits on a short name. Aboard it lands on the longest name in the list.

So on a single-line row a SHIP anchor shows no label at all. The ship mark is
already there and says as much. Rich rows keep it, on line 2, where it costs
nothing. The underlying budget flaw is left alone — it predates this work and no
arithmetic is worth spending on a garnish.

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

### Where it landed

All four surfaces measure from the anchor:

| Surface | |
| --- | --- |
| `ZoneRowResolver` | 41 tests, mutation-checked |
| iOS widget view | reads the anchor's label; markers compose |
| `GeoTimeWidgetProvider` | hand port of the same ten rules |
| Main app | `anchorOffsetHours()` in `src/time.ts`, used by the World Clock rows and both map chips |

Only things expressing a DIFFERENCE re-base. The Local, Ship and Device cards
each state a real clock and are labelled, so none of them moved, and the blue
GPS band still means "where you are".

**Android is compile-verified only.** Its `buildRows` is a hand port of logic
the Swift suite tests and the Java side does not — exactly the drift the
resolver's own comment warns about. The shared case table that would prevent it
still does not exist, and is the obvious next piece of work if this is ever
touched again.

### Android, checked on the emulator

Run aboard through the gateway harness. `aboardShipKey` reaches SharedPreferences
as `R/ST`, and the widget renders:

```
Vancouver −2 hrs 📍       Wednesday  10:15 PM
Star of the Seas  Ship time 🛳       12:15 AM
```

**One real bug found and fixed.** The offset TextView was gated on `!isLocal`,
which was the same row as the anchor for as long as those two were one flag.
Aboard they part, and the ground row — the one a guest checks before stepping
ashore — was the only row on screen with no offset. Now keyed on `!isAnchor`.

**The anchor label shows on a ship here, where iOS suppresses it.** Deliberate:
iOS hand-rolls a width budget that grants the label without checking the row it
lands on, so aboard it ate the vessel's name. Android lets the layout measure,
and the name survives beside the label. Copying the iOS workaround would make
this side worse to match a defect.

### Known, small, and left for later

The phone mark disappears from the ground row aboard. Not a logic fault — the
flag is set — but `row_device` is the last child of a `layout_weight="1"`
container in `widget_row.xml`, so the newly-added offset text consumes the width
and squeezes the icon to nothing. It appeared before the offset did. Fixing it
means reordering the row or bounding the city's width, which is a design choice
rather than a correction.

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

---

## 4. Browser ship detection — what the probe settled

Native detects the ship from `environment-marker` / `environment-ship-code` on
RCCL's own responses, which works because `CapacitorHttp` is not bound by CORS.
The browser cannot do that, so `?shipprobe` was built to ask the one question
shore cannot answer: **aboard, does the ship's gateway stamp responses from OUR
origin, or only from api.rccl.com?**

It was run aboard Star of the Seas on 2026-09-03. The answer is only.

### What the probe returned

All three attempts reported `marker: (none)`. More useful than the negative is
what the 24- and 27-header dumps contained: nothing injected. `via: 1.1 varnish`
is GitHub's own Fastly hop, `cf-ray: …-MIA` and `x-served-by: cache-mia…` are
simply the Miami edge that served her — which is where a Caribbean satellite
link makes landfall, not evidence of a ship.

The ship's network is a transparent path. The `environment-*` headers come from
RCCL's infrastructure, keyed on traffic arriving at *them*. **No host we control
will ever carry them**, so this is not a matter of finding the right host or the
right request — the route is closed.

The Worker returning only two headers is the same finding a third time, not a
bug: `Access-Control-Expose-Headers` only reveals headers that exist, and both
survivors (`cache-control`, `content-type`) are CORS-safelisted anyway. The
exposure list deployed for the probe was a no-op.

### What the browser has instead, and why no new control

`platformSupportsShipTime()` is true whenever `PROXY_BASE` is set, which it
always is — so **the ship picker already works on the web**. A passenger adds
her ship and reads its clock today, with no detection at all.

An "I am aboard this ship" toggle was considered and rejected: adding the ship
*is* the manual control, and a second way to say the same thing is worse than
none.

The one thing detection buys that adding does not is the **anchor** — with
`aboardShipKey` set, everything else is expressed relative to ship time (item
2). `setAboardShip` is only ever called from the detection paths in
`shiptime.ts`, so on the web the anchor stays on the device zone. If that gap is
ever worth closing, the natural gesture is *"anchor to this row"* on a clock
already in the list, which generalises past ships and needs none of what
follows.

### Position matching, if the anchor is ever wanted on the web

The fleet feed already carries `lat`, `lon`, `sog` and `tst` per ship, from our
own Worker, in the JSON body — no headers, no CORS. The browser already has GPS.
So the ingredients are present.

The trap is treating a position report as a position. `tst` says when the fix
was *reported*, and ships out of terrestrial AIS range are only seen on
satellite passes:

```
median fix age 6 min    p90 52 min    max 217 min
worst case: Allure Of The Seas, 217 min at 17 kn -> a 114 km circle
```

**But fix age is not what decides matchability — isolation is.** Measured
against our own fleet, every one of 27 under-way ships was unambiguous despite
those circles, because the nearest fleetmate was 260 km away. Meanwhile four
ships alongside had perfect fixes and were hopeless: Oasis and Adventure 0.1 km
apart, Jewel and Wonder 0.2 km. An Oasis-class hull is 360 m, so walking aft
moves a phone further than the gap between two ships, and AIS reports the
antenna, not the vessel.

Accuracy is best exactly where separation is worst.

### The other-vessels problem is solvable, and it matters

Our fleet is 45 ships; the sea has more. That exposure looked unmeasurable until
the `filter` parameter was tested.

**`filter` is a cruise-line index, not a ship-type filter.** The API doc says
type; the Worker comment says line; the Worker is right. Widening it from
`2,10` to `1..25` returns **278 vessels across 35 lines** — Carnival, MSC,
Norwegian, Princess, Holland America, Disney, essentially the whole industry —
from the same endpoint, with the same `UPSTREAM_HEADERS`, in one request. The
SQL exception the doc warns about was not reached at 25.

It immediately caught two false positives invisible to the fleet-only view:

```
UNDER WAY   Anthem of the Seas    1.4 km from ms Westerdam           (Holland America)
            Liberty Of The Seas   3.7 km from Oceania Nautica        (Oceania)
```

Without this we would have shipped a rule that tells someone on the Westerdam
they are on Anthem. Two of 26 is a 7% error rate on the case we most wanted to
automate.

In port it confirms the abstain rule and shows the problem is far larger than
the fleet-only count suggested — **11 of 18 crowded, not 4**, including Star of
the Seas at 0.6 km from MSC Seascape.

### The rule that follows

Two quantities were being conflated. Keep them apart:

| | |
| --- | --- |
| **Ambiguity** between candidates | compare uncertainty circles |
| **Acceptance** of a match | a *tight* radius, ~10 km |

A stale fix must not widen acceptance. Allure's 217-minute-old fix means "we do
not know where Allure is", not "you are within 114 km of Allure, welcome
aboard". Stale means abstain.

Against one coherent snapshot of all 278 vessels:

```
UNDER WAY   26 ships   matchable 19   abstain  2 crowded /  6 stale
ALONGSIDE   18 ships   matchable  7   abstain 11 crowded /  0 stale
OVERALL     44 ships   matchable 26   = 59%
```

The other 41% abstain rather than guess, and abstaining costs nothing because
adding the ship manually still works. Auto-detect at sea, abstain in port — the
opposite of what the fix-freshness numbers first suggested, and the right way
round: at sea is where "what time is it on this ship?" is genuinely hard, and in
port she can see the terminal.

### Cost, and two design notes

Near zero. Same endpoint, same headers, same Worker, one parameter widened.

- **Do not widen the existing `/fleet` query.** It feeds the clock list and
  would carry 278 vessels instead of 45 for no benefit there. Detection wants a
  *small bbox around the user's GPS* — only vessels within ~10 km matter — which
  is far smaller than either.
- **Web only.** Native has the header route and must never pay for this.

### The vessel name field

`ship_name` is present on all 278 records and **empty on all 278**. The name is
in `hover` ("Carnival Legend"), which is clean text — no markup, none empty.
`imo` and `mmsi` are both populated on every record; `imo` is the identity key,
and is what the fleet feed already uses.
