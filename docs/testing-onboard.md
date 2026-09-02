# Testing the aboard path from shore

Ship detection rests on two headers a cruise ship's own gateway injects into
every response — `environment-marker` and `environment-ship-code`. No shore
machine produces them, so without a stand-in the aboard path cannot be exercised
at all. That matters more here than it usually would: this feature shipped with
no on-ship access, so the aboard path is the part least likely to have been
tried by anyone.

There are two harnesses, because there are two transports.

## The web build

Already built into the dev server:

```
RCCL_SIM_SHIP=ST npm run dev
```

Every response through the `/rccl-api` proxy then claims to come from that ship.
See `rcclDevProxy()` in `vite.config.js`. `RCCL_SIM_SHIP_TIME` overrides the
onboard wall-clock header.

## Native (iOS and Android)

The dev proxy cannot help here: native talks to `api.rccl.com` directly, and has
to, because on a ship's wifi it is the only reachable host on the internet. So a
local process impersonates the gateway instead.

```
npm run ship-gateway                     # aboard Star of the Seas, port 8899
npm run ship-gateway -- --ship ID        # aboard Independence
```

It proxies the real API, so everything except the two headers is genuine —
real offsets, real voyages, real failures. The app key comes from the
environment or `.env.local` and is never written anywhere.

Then build the app to talk to it, and install as usual:

```
npm run build:shiptest:ios       # then: npx cap sync ios,     build, run
npm run build:shiptest:android   # then: npx cap sync android, build, run
```

Step ashore and back without restarting anything:

```
echo shore > /tmp/ship-mode
echo ship  > /tmp/ship-mode
```

Relaunch the app (or resume it, or rejoin wifi) to make it re-check. Aboard, the
Ship Time card appears and the ship's World Clock row loses its remove button;
ashore, the card goes and the button returns.

## Why `--mode shiptest`, and why it cannot leak

The hook in `apiBase()` reads `__SHIP_GATEWAY__`, which `vite.config.js` defines
as `null` in every mode except `shiptest`. An ordinary `vite build` therefore
does not merely leave it unused — the branch is dead code and eliminated, and
the string never enters the bundle. Confirmed by grepping a release build.

Two further guards, because the failure this could cause is the nasty kind. A
release quietly asking `localhost` for ship time would look exactly like a ship
that cannot be reached, which is a state the app is designed to tolerate
silently — so it would not announce itself:

- `--mode shiptest` with no `VITE_SHIP_GATEWAY` fails the build.
- A gateway that is not a loopback or emulator-host address fails the build,
  rather than being ignored.

Android needs cleartext to reach the gateway on `10.0.2.2`, which is granted by
a debug-only manifest overlay in `android/app/src/debug/`. Gradle merges it into
debug builds only; the release manifest has no such permission.

## What this does not simulate

The header *names*. They come from the API write-up rather than from the wire —
inferred from a decompiled client, never observed — so a mismatch there would
defeat detection no matter how correct everything downstream is. Everything
after the names is exercised faithfully; the names themselves need one report
from a real vessel. `src/diagnostics.ts` exists for that: six taps on the grey
place name under **Device Time** dumps every live probe header.
