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

## Track history, and why the Worker holds some

`ship.json`'s `track` array goes empty intermittently — observed on a vessel
that had 720 points hours earlier while its route and position kept working, and
confirmed from an unrelated network, so it is upstream's data rather than us
being throttled. No request recovers it; the only remedy is to have kept a copy.

Two layers do that, and they cover different cases:

- **The Worker**, in KV, keyed `track:<imo>:<voyage start>`. Serves the stored
  track when upstream sends an empty one. Shared, so the first person to look
  after a drop still gets history.
- **The client**, in localStorage, which keeps the last voyage it saw. Covers
  being offline, which the Worker cannot.

The key carries the sailing so a retained track can never appear under a
different cruise. Writes happen only when nothing is stored for that voyage yet
or what is stored is empty — upstream re-decimates the whole span on every
request, so a fresh non-empty response is never worse than a stored one. That is
about one write per vessel per sailing; entries expire after 30 days.

A track can also be seeded by hand, which is how one vessel's lost history was
restored from a capture taken before the drop:

```
wrangler kv key put "track:9829942:30Aug2026" --path track.json \
  --binding SHIP_TRACKS --config workers/ship-track/wrangler.jsonc --remote
```

The value is the bare `[[lon, lat], ...]` array, shaped as the Worker would
return it. Worth checking a hand-made value against a live response for the same
vessel first — everything but the track should be identical.

## Why a deploy might look like it did nothing

The Worker builds its cache key itself rather than taking it from the request,
so nothing a caller sends can vary it and there is no way to ask for a fresh
copy. That is deliberate — it is what holds our load on someone else's endpoint
to roughly a request a minute — but it means a change to the response shape is
invisible until the entry expires, up to 30 minutes for the detail bundle.

`CACHE_VERSION` in the Worker is the lever. Bump it when the response shape
changes: old entries are orphaned immediately and expire on their own. There is
deliberately no bypass parameter and no delete route, since either would hand a
stranger a way to force upstream traffic.

## What this does not simulate

The header *names*. They come from the API write-up rather than from the wire —
inferred from a decompiled client, never observed — so a mismatch there would
defeat detection no matter how correct everything downstream is. Everything
after the names is exercised faithfully; the names themselves need one report
from a real vessel. `src/diagnostics.ts` exists for that: six taps on the grey
place name under **Device Time** dumps every live probe header.

# The maps are cloud-styled vector maps

`src/map.ts` passes a Map ID per map and asks for `RenderingType.VECTOR`. The
base map used to be raster tiles styled server-side, which meant every label was
baked pixels — upscaled on a 3x display and soft whatever colours it was given.
Measured on device, raster served 512px tiles into 256 CSS px in every
configuration, styled or not, so the softness was never something styling or
resolution could fix. Vector draws labels client-side at device resolution.

The trade is that the Maps API ignores inline `styles` when a Map ID is present,
so the palette lives in Cloud console styling now. `src/map-styles.ts` is kept as
the only version-controlled copy of it, and

```
node scripts/export-map-styles.mjs --out docs/map-styles
```

regenerates the JSON to paste into the console's style editor. One file per Map
ID, named to match. Changing the TypeScript changes nothing until the cloud style
is re-imported.

Map IDs are public identifiers rather than secrets — they travel in every tile
request, and the API key carries the restrictions — so they are defaulted in
code. As environment-only values they would be absent in CI and the maps would
quietly fall back to raster in exactly the builds nobody inspects by hand.
Setting `VITE_MAP_ID_LOCATION` or `VITE_MAP_ID_TIMEZONE` to an empty string is
the deliberate way back to the raster path.

Verified on device: both maps report zero raster tiles and render to canvas, the
444-feature timezone layer still draws and styles, and markers and polylines are
unaffected. Building the layers was marginally faster than raster.
