# GeoTime — environment notes

Things about *this machine* that have cost time more than once. Nothing here is
about how the code works; that lives in the code's own comments.

## The Android SDK is at /Users/Shared/android/sdk

**Not** `~/Library/Android/sdk`, which also exists, is on the default search
path, and is missing `system-images` entirely. An emulator started against it
dies with `Cannot find AVD system path. Please define ANDROID_SDK_ROOT`, which
reads like "no system images are installed on this machine" and is not what it
means. That misreading has happened more than once.

The AVDs in `~/.android/avd` (Pixel_7 and four `wa-*`) all want
`system-images/android-33/google_apis_playstore/arm64-v8a/`, which the shared
SDK has and the home-directory one does not.

```bash
export ANDROID_SDK_ROOT=/Users/Shared/android/sdk
export ANDROID_HOME=/Users/Shared/android/sdk
/Users/Shared/android/sdk/emulator/emulator -avd Pixel_7 -no-boot-anim &
/Users/Shared/android/sdk/platform-tools/adb devices     # wait for `device`
```

Gradle needs the same two variables. `adb` from the home-directory SDK talks to
the same daemon, so a stray `adb` on PATH is harmless — only the emulator and
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

Play at **100%**, and an App Store submission with automatic release. There is
no staging step. Never push to `main` without being asked.
