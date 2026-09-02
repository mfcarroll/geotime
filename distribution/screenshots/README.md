# App Store screenshots

Captured from the iOS Simulator at the three sizes App Store Connect asks for.
Regenerable — see below — so they do not have to be redone by hand each release.

| Folder | Display | Pixels | Device used |
| --- | --- | --- | --- |
| `6.9/` | 6.9" | 1320 x 2868 | iPhone 17 Pro Max |
| `6.5/` | 6.5" | 1242 x 2688 | iPhone 11 Pro Max |
| `6.3/` | 6.3" | 1206 x 2622 | iPhone 17 Pro |
| `ipad-13/` | iPad 13" | 2064 x 2752 | iPad Pro 13-inch (M5) |

Ordered so the first three are the ones that matter: App Store Connect shows
only the first three on the app installation sheet, though the full product page
takes up to ten.

1. **overview** — local vs device time, GPS, and the timezone map with the GPS
   band in blue and a selected band in gold
2. **ship-track** — a cruise's wake, the route ahead and its ports
3. **widget** — the home screen widget
4. timezone-map, 5. clocks — phone sets only

## Why three iPhone sizes when Apple scales one

App Store Connect scales a single iPhone set across every iPhone display size,
so a 6.9" set alone would cover a listing that has never had screenshots. This
one has: the 6.5" and 6.3" slots already hold images from the app's first
release, and the fallback fills *empty* slots rather than replacing filled ones.
Uploading only 6.9" would leave 2024 screenshots showing at the other two sizes.
Replacing all three is deterministic; deleting the old ones and trusting the
fallback is not.

iPad is a separate family rather than one of those "display sizes" — the app
ships with `TARGETED_DEVICE_FAMILY = "1,2"`, so it needs its own set. It is also
the only one that shows the small location map, since iPad clears the 1024px
three-column breakpoint that hides it on phones.

## Regenerating

The clock list is pre-seeded rather than typed in on each device, which is the
only part that was worth automating:

```
npx vite build --mode screenshots
npx cap copy ios
```

`--mode screenshots` turns on `src/screenshot-seed.ts`, which writes a fixed set
of cities and one ship into localStorage *if the list is empty*. It is compiled
out of every other build — verify with:

```
npx vite build && grep -c "Star of the Seas" dist/assets/main-*.js   # expect 0
```

Then per device: install, set the location, and drive the rest by hand. On iPad
grant the location prompt first — it appears on a fresh install and blocks the
view.

```
xcrun simctl boot <udid>
xcrun simctl install <udid> /path/to/App.app
xcrun simctl location <udid> set 40.7128,-74.0060
xcrun simctl status_bar <udid> override --batteryState charged --batteryLevel 100 \
  --cellularMode active --cellularBars 4 --wifiMode active --wifiBars 3
xcrun simctl launch <udid> ca.matthewcarroll.geotime
xcrun simctl io <udid> screenshot shot.png
```

Two things learned the hard way, both worth keeping:

- **Uninstall before installing** if the device has ever run the app. `install`
  over an existing copy keeps its storage, so the seed sees a non-empty list and
  skips — which showed up as one device carrying an extra auto-added city that
  the others did not have.
- **Do not override the status bar clock.** Apple's own 9:41 contradicts the
  Device Time on screen, and in an app whose entire subject is what time it is,
  a status bar disagreeing with the clock beneath it reads as a bug. Leaving the
  real time makes the two agree.

Only one simulator at a time — three booted at once was enough for Xcode to kill
one for memory.
