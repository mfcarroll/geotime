// src/map-highlight.ts
//
// Pure resolution of a zone's map style. Kept free of DOM/Google imports so the
// precedence rules can be tested directly — they are fiddly, and a regression
// here is invisible until someone hovers the right combination.

export interface ZoneStyle {
  fillColor: string;
  fillOpacity: number;
  strokeColor: string;
  strokeWeight: number;
  zIndex: number;
}

// Fill says which band a zone belongs to; outline says which single zone the
// pointer is on. They are separate channels because they answer different
// questions, and a zone can be in the selected band *and* under the cursor.
// Every one of these is lighter than it looks like it should be, and that is a
// consequence of where hover moved to. While pointing at a zone was a JUMP IN
// FILL, each level had to sit far enough below the next that the jump could be
// seen — so the standing state was as heavy as the hovered one needed it to be,
// and the map underneath paid for it. The outline carries hover now (see
// OUTLINE), which frees every fill to be only as strong as its own job needs.
export const FILLS = {
  base:            { fillColor: '#000000', fillOpacity: 0,    zIndex: 1 },
  gpsBand:         { fillColor: '#3F80FF', fillOpacity: 0.20, zIndex: 2 },
  // The clock you are living by, when that is a ship. Green rather than gold
  // because gold means "you picked this" — the ship is a fact about where you
  // are standing, in the same family as the blue band beside it, and the two
  // carry the same weight for that reason.
  shipBand:        { fillColor: '#34C759', fillOpacity: 0.19, zIndex: 4 },
  hoverBand:       { fillColor: '#FFFFFF', fillOpacity: 0.11, zIndex: 3 },
  gpsSegment:      { fillColor: '#3F80FF', fillOpacity: 0.36, zIndex: 5 },
  selectedBand:    { fillColor: '#FFD700', fillOpacity: 0.19, zIndex: 6 },
  // A wash, not a coat. At 0.8 the gold was opaque enough that the coastline,
  // the place names and the sea underneath it all went: the zone you picked was
  // the one part of the map you could no longer read.
  selectedSegment: { fillColor: '#FFD700', fillOpacity: 0.32, zIndex: 7 },
} as const;

/**
 * How much of the fill survives while a ship's chart is on the map.
 *
 * The bands answer "where else keeps this time", which is the question until
 * the moment a cruise is drawn on top of them — and then it is not. A wake, a
 * dotted route and a row of ports are fine lines and small rings, and they were
 * being read through a gold wash laid over the whole hemisphere they cross.
 *
 * Dimmed rather than dropped, because the band is still the reason half of what
 * is on screen is the colour it is. It should be legible and it should be
 * quiet, in that order — and the first attempt got that order backwards. At
 * 0.35 of a fill that was itself built for a fill-based hover, a selected
 * ship's band came out at 0.08 and simply was not there. The fills below have
 * since come down on their own account, so this no longer has to do the work of
 * two decisions at once.
 */
export const CHART_FILL_SCALE = 0.8;

/**
 * Hover, almost entirely — in brightness, at a constant weight.
 *
 * The outline carries hover because the alternative was making the FILL carry
 * it, and a fill big enough to be noticed is a fill that hides the coastline,
 * the place names and the sea under every highlighted zone on the map. That
 * much is settled and the fills below are lighter for it.
 *
 * What is NOT the way to carry it is thickness. Doubling the stroke was tried
 * and looked like exactly what the original note here warned it would: a
 * heavier, brighter line that draws attention to the boundary rather than to
 * the region, and shifts it by a pixel while it is at it. Four times the
 * brightness at the same weight is plenty, and leaves the map's own structure
 * looking the way it did before any of this.
 */
export const OUTLINE = {
  none:  { strokeColor: 'rgba(255,255,255,0.2)', strokeWeight: 1 },
  hover: { strokeColor: 'rgba(255,255,255,0.82)', strokeWeight: 1 },
} as const;

/**
 * How much of the hover is left for the fill to say.
 *
 * Small on purpose. Enough that a zone whose outline is hidden behind a card or
 * running off the edge of the map still answers a pointer, and not enough to
 * put the fill back in charge.
 */
export const HOVER_FILL_LIFT = 0.06;

/**
 * A nautical band rather than a country.
 *
 * The ocean is tiled into Etc/GMT±N, and the tiles are enormous — one of them
 * can be most of a zoomed-in chart. Anything that repaints a whole zone
 * therefore repaints the sea a ship is sailing on, which is the one part of
 * that view nobody is asking about.
 */
const isOcean = (tzid: string) => tzid.startsWith('Etc/');

/**
 * How much of hover's FILL a zone gets, given what is on the map.
 *
 * With a cruise drawn, an ocean band gets NONE. Zoomed in on a chart the band
 * under the ship is most of the screen, and painting it flashes the whole view
 * for a pointer that has not left the water — a change so large it reads as the
 * map doing something rather than as an answer. Land gets half, because a
 * country at that zoom is a shape you can see change without the change taking
 * over. The outline says the rest, and says it the same way for both.
 *
 * Applied to BOTH of hover's fills, which is the part that was missed the first
 * time. The lift on the hovered zone is the obvious one; the hover BAND is the
 * one that was actually being seen. It paints every zone sharing the hovered
 * zone's offset — including that zone — so pointing at open water outside the
 * selected band took the sea from nothing to white, a bigger jump than the lift
 * that had just been removed to prevent exactly this.
 */
function hoverFillScale(tzid: string, chartShown: boolean | undefined): number {
  if (!chartShown) return 1;
  return isOcean(tzid) ? 0 : 0.5;
}

export interface ZoneStyleInput {
  tzid: string;
  /** Current UTC offset of `tzid`, precomputed on the feature. */
  offset: number;
  /**
   * Zone the user has selected, or null.
   *
   * Null while a *ship* is selected, which is the whole reason this and
   * `selectedOffset` are separate inputs: a ship keeps a time without occupying
   * a zone, so it lights the band and no zone ever becomes the solid segment.
   * Nothing on land *is* the ship.
   */
  selectedTzid: string | null;
  /**
   * Offset the selection keeps time by, or null when nothing is selected.
   *
   * For a zone this is just that zone's current offset; for a ship it is the
   * offset the crew set. Null for a ship whose offset has not resolved yet —
   * without that, an unresolved ship would read as 0 and light up UTC.
   */
  selectedOffset: number | null;
  /** GPS-derived local zone, or null. */
  gpsTzid: string | null;
  /** Zone under the pointer, or null. */
  hoveredTzid: string | null;
  /** The ship's offset when a marker confirms we are aboard; null ashore. */
  anchorShipOffset: number | null;
  /** Current UTC offset of an arbitrary zone id. */
  offsetOf: (tzid: string) => number;
  /**
   * True while a selected ship's chart is drawn over the map.
   *
   * Not merely "aboard": the chart a passenger's own ship draws is the standing
   * state of the app at sea, and fading the map permanently for it would make
   * the quiet version the only version. This is about a deliberate look at one
   * cruise.
   */
  chartShown?: boolean;
}

export function resolveZoneStyle(input: ZoneStyleInput): ZoneStyle {
  const { tzid, offset, selectedTzid, selectedOffset, gpsTzid, hoveredTzid, offsetOf,
          anchorShipOffset, chartShown } = input;

  const sameOffsetAs = (other: string | null) =>
    other !== null && offsetOf(other) === offset;

  const isHovered = tzid === hoveredTzid;

  // Structural rather than one of FILLS, because the hover band is scaled
  // rather than taken as it stands — see hoverFillScale.
  let fill: { fillColor: string; fillOpacity: number; zIndex: number };
  if (tzid === selectedTzid) fill = FILLS.selectedSegment;
  else if (tzid === gpsTzid) fill = FILLS.gpsSegment;
  // The GPS band wins over the selected band where they are the same band.
  // Picking a zone that already keeps your time shouldn't repaint the whole
  // region: it is still the band you are in, so it stays blue and only the
  // chosen zone goes gold. Gold spreads across a band only when that band is a
  // different time from yours.
  // Aboard, the ship's band is painted BEFORE the GPS band, so when the two
  // coincide — a ship keeping the port's time — the region reads green and
  // only the zone you are standing in stays a bright blue segment. Green for
  // the clock, blue for the ground: the same split the widget makes.
  else if (anchorShipOffset !== null && anchorShipOffset === offset) fill = FILLS.shipBand;
  else if (sameOffsetAs(gpsTzid)) fill = FILLS.gpsBand;
  else if (selectedOffset === offset) fill = FILLS.selectedBand;
  // Covers the hovered zone itself, which is why this is scaled and not just
  // the lift below — see hoverFillScale.
  else if (sameOffsetAs(hoveredTzid)) {
    fill = {
      ...FILLS.hoverBand,
      fillOpacity: FILLS.hoverBand.fillOpacity * hoverFillScale(tzid, chartShown),
    };
  }
  else fill = FILLS.base;

  const wash = (style: ZoneStyle): ZoneStyle => chartShown
    ? { ...style, fillOpacity: style.fillOpacity * CHART_FILL_SCALE }
    : style;

  if (!isHovered) return wash({ ...fill, ...OUTLINE.none });

  // Hovering always outlines the zone under the pointer, whatever fill it
  // already carries. Without this a zone inside the selected band returned the
  // band style and dropped out of the chain before hover was ever considered,
  // so pointing at a neighbour gave no feedback at all. Lift it above its own
  // band too, or the outline gets painted over by an adjacent zone.
  // The lift is applied AFTER the wash, so pointing at a zone still says so
  // while a chart is up — a proportional dimming of it would have made it
  // faintest in exactly the state where the map is quietest.
  return {
    ...wash({ ...fill, ...OUTLINE.hover, zIndex: fill.zIndex + 10 }),
    fillOpacity: Math.min(1,
      (chartShown ? fill.fillOpacity * CHART_FILL_SCALE : fill.fillOpacity)
        + HOVER_FILL_LIFT * hoverFillScale(tzid, chartShown)),
  };
}
