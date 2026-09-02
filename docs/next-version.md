# Next minor version — planning

Three items raised after 1.5.0 went out. Nothing here is started. Written up for
planning rather than as a spec: the first and third are close to decided, the
second has a design question inside it that is worth settling before any code.

---

## 1. The ship's destination line is misleading

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

### What needs deciding

- **N.** Ships anchor off some ports and tender in, so the threshold is not
  "at the pier". Wants checking against a real voyage rather than guessing.
- **The last port has no departure.** `ShipPort.depart` is documented as
  `null` on the final call. Disembarkation day needs its own wording —
  probably the arrival, which is the number that matters then.
- **Which clock is `depart` in?** It is upstream's local time for that port,
  which is not necessarily ship time and definitely not the reader's. An
  unqualified time is the one thing this app spends its whole surface avoiding,
  so this needs an explicit basis. **This is why item 2 should land first** — if
  ship time becomes the stated reference while aboard, "Dep. 4:30 PM" reads
  correctly with no extra qualifier.

### Effort

An afternoon, most of it in the threshold and the final-port case. Both want a
real voyage to test against.

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

## 3. Red × appears on the wrong row

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

## Suggested order

1. **Item 3** — one line, unrelated to the others, no reason to wait.
2. **Item 2** — it decides the clock that item 1's departure time is stated in.
3. **Item 1** — cheaper and less ambiguous once the reference is settled.
