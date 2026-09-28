# GeoTime — environment notes

Things about *this machine* that have cost time more than once. Nothing here is
about how the code works; that lives in the code's own comments.

## The Android SDK is at /Users/Shared/android/sdk

**Not** `~/Library/Android/sdk`, which also exists, is on the default search
path, and is missing `system-images` entirely. An emulator started against it
dies with `Cannot find AVD system path. Please define ANDROID_SDK_ROOT`, which
reads like "no system images are installed on this machine" and is not what it
means. That misreading has happened more than once.

## Use the GeoTime_Test AVD, never the ones in ~/.android/avd

GeoTime has its own throwaway AVD, `GeoTime_Test` (android-36, Play Store
image, Pixel 7 profile), kept in its own directory so that nothing GeoTime does
touches anyone else's emulators:

```bash
export ANDROID_SDK_ROOT=/Users/Shared/android/sdk
export ANDROID_HOME=/Users/Shared/android/sdk
export ANDROID_AVD_HOME=/Users/Shared/android/avd-geotime
/Users/Shared/android/sdk/emulator/emulator -avd GeoTime_Test -no-boot-anim -no-snapshot &
/Users/Shared/android/sdk/platform-tools/adb devices     # wait for `device`
```

**Never boot the `WA_*` AVDs in `~/.android/avd`.** They are sealed base images
for another project. Its clones use their disks as copy-on-write backing files,
so booting one silently corrupts every clone (see the README beside them). The
`Pixel_7` AVD these notes used to name is gone. Without `ANDROID_AVD_HOME`,
`-avd GeoTime_Test` fails with "Unknown AVD name", which is the safe failure.

If `GeoTime_Test` is ever missing, recreate it in the same place:

```bash
echo no | ANDROID_AVD_HOME=/Users/Shared/android/avd-geotime \
  /Users/Shared/android/sdk/cmdline-tools/latest/bin/avdmanager create avd \
  -n GeoTime_Test -k "system-images;android-36;google_apis_playstore;arm64-v8a" -d pixel_7
```

On this image `adb shell monkey -p …` does not launch the app. Use
`adb shell am start -n ca.matthewcarroll.geotime/.MainActivity`.

Debug builds log Capacitor plugin return values to logcat, and one of those is
the RCCL app key. Filter logcat before pasting it anywhere.

Gradle needs the same two SDK variables. `adb` from the home-directory SDK talks
to the same daemon, so a stray `adb` on PATH is harmless: only the emulator and
Gradle care which root they are given.

## `npx cap sync ios` needs a UTF-8 locale

CocoaPods aborts with `Unicode Normalization not appropriate for ASCII-8BIT`
otherwise, and the failure comes *after* the web assets have already been
copied — so it looks like a sync that half worked.

```bash
LANG=en_US.UTF-8 npx cap sync ios
```

## Production builds go through 1Password

`npm run build:prod` wraps vite in `op run`, which is what injects
`VITE_GOOGLE_MAPS_API_KEY` and the RCCL key. When the vault is locked it fails
with `error initializing client: authorization timeout` and vite never runs —
but a following `cap sync` will happily copy the *previous* `dist`, so the
simulator quietly gets a stale bundle. Check for `✓ built in` before syncing.

Confirm the key actually landed:

```bash
grep -oE "AIza[A-Za-z0-9_-]{10}" dist/assets/*.js | head -1
```

## The RCCL app key is never committed

It comes from 1Password at build time. The API research under `docs/` that
describes those endpoints is excluded via `.git/info/exclude`, not
`.gitignore` — a fresh clone will not have that exclusion.

## Merging to `main` ships to production

Play at **100%**, an App Store submission with automatic release, and the web
app to geotime.app (a Worker, `workers/web`, deployed by `deploy.yml`). There is
no staging step. Never push to `main` without being asked.

The Workers behind the API are deployed by hand (`npm run deploy:<name>`), and
four of them serve 1.7.0 in the field on their `*.workers.dev` names. Check that
a Worker's code on this branch matches what is deployed before redeploying it.
