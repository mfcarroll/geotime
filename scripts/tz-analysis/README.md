# Timezone boundary analysis

Throwaway-looking scripts that are not throwaway: `public/timezones.topojson` is
regenerated whenever tzdb ships, and every regeneration needs the same checks.

Run them with the TypeScript resolver hook, because most import `src/zone-order.ts`
so they measure the precedence the app actually uses rather than a second guess
at it:

```
node --import ./scripts/ts-resolve.mjs scripts/tz-analysis/<script>.mjs
```

## Which instrument to trust

This is the most important thing here, and it cost more than anything else to
learn. Three ways of asking "does any zone cover this ground" gave three
different answers, and two of them were wrong:

| method | verdict | why |
|---|---|---|
| `-erase` zones from a world rectangle | **understates** | snaps slivers away as it runs; reported 0 gaps while a real hole existed at Eupen |
| `-mosaic`, count `n=0` tiles | **overstates** | labels tiles it cannot attribute; claimed 6,314 km² off Enderby Land where dense sampling finds 1 uncovered point in 48,000 |
| `booleanPointInPolygon` | **trust this** | the same question `findTimezoneFromGeoJSON` asks |

Use `coverage-sweep.mjs` for gaps. Use `region-probe.mjs` when you have a
specific place to look at — a global sweep at one sample per 2,550 km² cannot
see a small hole, and the one real hole in this data was found by eye first.

`-mosaic` IS reliable for overlaps (`n>1`), which is what `mosaic-audit.mjs` and
`exact-overlaps.mjs` use it for.

## The scripts

**Coverage and correctness**
- `coverage-sweep.mjs` — uncovered ground, by point sampling. The gap check.
- `region-probe.mjs` — what covers each point of a box. The workhorse for a specific place.
- `accuracy.mjs` — resolves all 63,493 cities in the shipped index against their known zone.
- `remaining.mjs` — groups whatever `accuracy.mjs` still gets wrong.
- `region-drift.mjs` / `ocean-drift.mjs` — shipped data vs the unsimplified source, locally and globally.

**Overlaps**
- `mosaic-audit.mjs` — holes and overlaps in one line. Read the hole figure with the caveat above.
- `exact-overlaps.mjs` — every overlapping pair by area. Exhaustive, not sampled.
- `overlap-impact.mjs` — which overlaps put the two zones on different clocks, sampled across a year so DST divergence is not missed.
- `verify-order.mjs` — proves a precedence change alters nothing except at overlaps.
- `ocean-enclaves.mjs` — band pieces walled in by land; the input to the adoption rule.
- `hole-report.mjs` — locates holes with their nautical fallback. Overstates, see above.

**Geometry and cost**
- `probe-rings.mjs` — whether two zones trace a shared coastline identically. Found the `keep-shapes` defect.
- `zonecheck.mjs` — all 444 zones present with geometry.
- `quant.mjs` — a topojson's quantization step in metres.
- `bench.mjs` — parse, decode, heap and lookup cost.

**The map overlay**
- `build-debug-layers.mjs` — writes the three gitignored layers `?debug=geometry` draws:
  magenta (claimed by 2+ zones), red (claimed by nothing), green (was a band, adopted by land).
  Regenerate after every rebuild; a production build strips them (see `dropDebugLayers` in vite.config.js).
