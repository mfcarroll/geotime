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

## If the JSON import will not take

The `.json` files here are **legacy JSON styling** — the format the old raster
styled maps used. The newer vector style editor does not reliably accept it, and
the suppression rules (`administrative.land_parcel`, `poi`, `transit`,
`road.labels`) are the sort that get rejected.

Worth one try: the import option is usually offered when a style is **created**
("Create your own style" → import JSON), not when editing an existing one. If a
fresh style takes the import, associate that style with the Map ID and stop
reading here.

## Otherwise, do it by hand — it is shorter than it looks

Start from the console's **dark** preset, which gets most of the way, then set
only what follows. The base map's whole job is to be a quiet backdrop: the
timezone bands and the ship layers are what the user is looking at, and anything
loud in the base competes with them.

| What | Value |
| --- | --- |
| Landscape / geometry | `#3b4a5a` |
| Water / geometry | `#1d2c3a` |
| All labels / text fill | `#8a99a8` |
| All labels / text stroke | `#3b4a5a` |
| Administrative / borders | `#4a6078` |
| Road / geometry | `#4a6078` |

Then hide: **points of interest**, **transit**, **road labels**, **land
parcels**, **neighbourhoods**, and man-made landscape. Keep **localities**
visible — city names are the only labels that earn their place on a world map.

Both Map IDs take the same treatment; the two styles differ only in details that
do not matter much at the sizes these render.

## Only one map is vector

Two vector maps on a page do not both work in WKWebView. Measured in the app on
iOS: one renders and the other stays a flat beige — no error, no console output,
and unchanged after a minute, so not a loading state. Chromium runs both without
complaint, which is why this is invisible in a browser and why it first looked
like a styling fault. A WebGL context limit is the likely cause.

So the **World Clock Map** is vector and the **Location Map** is not. That is the
right way round: the world map is large, read at a glance, and its labels sit
under the timezone bands, while the location map is a small high-zoom view of a
few streets around a blue dot where raster tiles are indistinguishable.

Sharing a single Map ID between the two does not dodge it — tested, and the
second map is beige just the same. The limit is on vector map instances, not on
distinct styles, so there is nothing to gain by merging the styles. Keep them
separate: the location map's is deliberately the more detailed of the two, since
local roads are the whole point of a map showing where you are standing, and the
world map suppresses exactly those.

The Location Map ID stays styled and ready in case WKWebView stops caring —
building with `VITE_MAP_ID_LOCATION=c75a3fdf244efe751e1f1767` turns it on, and
the way to check is the app on a device, not a browser.

## Styles take a few minutes to appear

After saving a style in the console it does not apply immediately. A map that is
still the default beige right after publishing is usually propagation rather
than anything wrong — wait a few minutes and hard-refresh before changing
anything.

## Getting it wrong is cheap

Nothing here ships in the app, so a bad style is fixed in the console without a
release. And setting `VITE_MAP_ID_LOCATION` or `VITE_MAP_ID_TIMEZONE` to an
empty string falls the app back to the old raster path with the styles in
`src/map-styles.ts`, which still work.

## Regenerating the JSON

```
node scripts/export-map-styles.mjs --out docs/map-styles
```

`src/map-styles.ts` remains the only copy of the palette under source control,
even though it no longer drives anything at runtime.
