# App Store screenshots

Captured from the iOS Simulator at the three sizes App Store Connect asks for.
Regenerable — see below — so they do not have to be redone by hand each release.

| Folder | Display | Pixels | Device used |
| --- | --- | --- | --- |
| `6.9/` | 6.9" | 1320 x 2868 | iPhone 17 Pro Max |
| `6.5/` | 6.5" | 1242 x 2688 | iPhone 11 Pro Max |
| `6.3/` | 6.3" | 1206 x 2622 | iPhone 17 Pro |

Five per size: the local/device split, the timezone map with a zone lit, the
World Clock list, a ship's track, and the home screen widget.

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

Then per device: install, set the location, and drive the rest by hand.

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
