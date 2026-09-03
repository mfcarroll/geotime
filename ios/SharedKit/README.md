# Widget logic tests

```
npm run test:shared          # or: cd ios/SharedKit && swift test
```

23 tests, ~0.03s, no simulator and no Xcode — the shared widget sources are
Foundation-only, so a Swift package can test them directly.

## What this is for

`ZoneRowResolver` decides which rows the home-screen widget shows, in what
order, and what each says relative to the others. Its rules are duplicated in
Android's `GeoTimeWidgetProvider`, a duplication the resolver's own comment
justifies with *"one test does not [drift]"*. This is that test.

The sources are **symlinked** from `ios/App/Shared`, not copied, so there is no
second copy able to diverge from what ships. The Xcode project still owns them.

## What it does and does not buy you

Two tiers, and the distinction matters:

- **Invariants** pin today's behaviour. Any diff here after a change is a
  regression rather than progress.
- **Properties** hold in every input and are meant to survive intended change —
  one anchor, the anchor names itself, every row is measured from the anchor,
  no row listed twice, `fit()` never hides a special row.

Verified by mutation rather than by passing: breaking the baseline, blanking the
anchor label, and listing a folded ship twice each fail exactly the tests that
should fail and no others.

**The gap this leaves is deliberate.** A crude re-base of the baseline onto the
ship's clock fails only *one* test, because the properties are stated relative
to whichever row is the anchor and so stay true after a re-base — which is
exactly what they are for. They will catch an accidental change; they will not
tell you a deliberate one was done right. That is the aboard matrix's job, and
it cannot be written until `resolve` has an aboard parameter to write it
against. The cases it owes are listed at the foot of
`Tests/GeoTimeSharedTests/ZoneRowResolverTests.swift`.

## Locale

`TimezoneDisplay.timeParts` and `.weekday` read `Locale.current`, so
`timeDigits`, `timePeriod` and the weekday fields are asserted by shape, never
by value — a test expecting "3:22 PM" would pass in Cupertino and fail on a
24-hour machine. Everything asserted literally (`relativeText`, names, ordering,
the role flags) is locale-independent.

## What this package cannot catch

It builds for macOS, where the availability floor is higher than the app's. An
API newer than the iOS deployment target compiles here and fails in Xcode —
`TimeZone.gmt` did exactly that, passing 41 tests and then breaking the app
build. Run a real `xcodebuild` before believing the suite about anything that
touches a platform API.
