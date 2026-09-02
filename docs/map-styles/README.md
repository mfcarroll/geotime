# Setting the cloud map styles

The maps are cloud-styled vector maps, so the palette lives in Google Cloud
console against two Map IDs rather than in this repo. There is **no API for
this** — the whole Maps service catalogue has nothing for creating a style or
binding one to a Map ID, so it cannot be scripted or driven by `gcloud`. Console
only.

| Map ID | Style | What it is |
| --- | --- | --- |
| `c75a3fdf244efe751e1f1767` | Location Map | The small map under GPS Location |
| `c75a3fdf244efe75fccc5434` | World Clock Map | The big timezone map |

## Map styles

The `google-maps-styles.json` file here is **modern JSON styling** and can be imported directly into
the maps styles editor.

Both Map IDs now share the same set of styles.

## Both maps are vector, sharing one style

The **World Clock Map** (`c75a3fdf244efe75fccc5434`) and the **Location Map**
(`c75a3fdf244efe751e1f1767`) are both vector, both defaulted in `src/map.ts`.

They now share one style — `google-maps-styles.json`, imported against both Map
IDs. An earlier version of this section said they were deliberately different,
the location map carrying local roads the world map suppressed. That is no
longer true, and the two IDs are kept only so the styles *can* diverge again
without a code change; nothing today requires two.

Local roads being visible in the shared style costs the world map nothing,
because Google does not draw them at the zoom it sits at. If the two ever do
need to differ, this is the line that would drive it.

This section used to say only one map could be vector, on the strength of a
WKWebView failure that was real but misdiagnosed — see the resolved section
below. The cause was a missing `worker-src` in our own CSP, not a limit on
vector map instances.

## Styles take a few minutes to appear

After saving a style in the console it does not apply immediately. A map that is
still the default beige right after publishing is usually propagation rather
than anything wrong — wait a few minutes and hard-refresh before changing
anything.

## RESOLVED: the blank vector map was our own CSP

Both maps are vector. The section this replaces recorded a WebGL context limit
in WKWebView, which was wrong.

The real cause: `index.html` set no `worker-src`, so the directive fell back to
`script-src`, which does not allow `blob:`. Google's vector renderer spawns its
WebGL workers from `blob:` URLs, and every one was blocked. A second grant was
needed too — `connect-src data:`, for the label worker's glyph atlases, which
workers inherit from the document policy.

The observations that led to the wrong answer were all sound:

| Where | Result |
| --- | --- |
| WKWebView, two vector maps | failed reproducibly — one map flat beige across three builds, pixel unchanged over 50s |
| WKWebView, one vector map | worked |
| A Chromium browser, two vector maps | four consecutive reloads fine, 32 spare WebGL contexts |
| Chrome, in ordinary use | intermittent — fine for a while, then beige again |

What made them mislead:

- **A browser comparison that was not a comparison.** The standalone prototypes
  carried no CSP meta tag, so they were never subject to the rule that was
  breaking the app. "Chromium handles both fine" measured a different document.
- **The one-map case worked**, which fit a context limit exactly, so the
  hypothesis kept earning its place.
- **Chrome's intermittency**, which a static policy should not produce. It came
  from a service worker serving a cached build over `http://` while the dev
  server spoke `https://` — so which bundle, and which policy, was live varied.
- **Google's own CSP probe was being blocked** by an ad blocker
  (`gen_204?csp_test=true` → `ERR_BLOCKED_BY_CLIENT`), so the API never warned.

The failure is silent by nature — no error, no `webglcontextlost`, and
`getRenderingType()` still reports `VECTOR` — so both directives now carry a
comment in `index.html` saying what breaks without them. A flat map points
nobody at a Content Security Policy; it cost two long detours before the console
was read carefully enough.

### Re-measured after the fix

Simulator, iPhone 17, both maps vector, cold launches. Mean colour of the map
region separates a styled render from the beige failure; a flat fill also
collapses the colour count and luminance spread.

| Map | Launches | Result |
| --- | --- | --- |
| Location | 6 | cool slate `#3b4a5a` every time, identical from launch 3 on |
| World | 3 | pixel-identical — 2662 colours, σ30.53, `#2c3d50` |

No CSP violation reached the device log, and no WebGL context loss. Label glyphs
and coastlines are crisp at 1:1 device pixels, which is the visible difference
from the scaled raster tiles that prompted this whole thread.

Then confirmed on a real iPhone, which is the check that counts — the
simulator's WebGL does not use the driver a phone does, and a context limit, the
wrong answer here, is precisely the sort of thing that would have differed.

## Getting it wrong is cheap

Nothing here ships in the app, so a bad style is fixed in the console without a
release. And setting `VITE_MAP_ID_LOCATION` or `VITE_MAP_ID_TIMEZONE` to an
empty string falls the app back to the old raster path with the styles in
`src/map-styles.ts`, which still work.

## Keeping the tracked style in step

`google-maps-styles.json` is exported from the console, not generated from this
repo. Edit the style in the console, then use its **Export JSON** and overwrite
that file, so the tracked copy stays the thing the console would actually
re-import.

There was a `scripts/export-map-styles.mjs` that went the other way, generating
JSON from `src/map-styles.ts`. It has been removed: it emitted the legacy
`MapTypeStyle[]` format, which is the format the console silently refuses to
import — so following its instructions could only waste your time. Those arrays
are now an old raster palette kept for the no-Map-ID fallback, nothing more.
