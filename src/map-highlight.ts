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
export const FILLS = {
  base:            { fillColor: '#000000', fillOpacity: 0,    zIndex: 1 },
  gpsBand:         { fillColor: '#3F80FF', fillOpacity: 0.26, zIndex: 2 },
  // The clock you are living by, when that is a ship. Green rather than gold
  // because gold means "you picked this" — the ship is a fact about where you
  // are standing, in the same family as the blue band beside it, and the two
  // carry the same weight for that reason.
  shipBand:        { fillColor: '#34C759', fillOpacity: 0.24, zIndex: 4 },
  hoverBand:       { fillColor: '#FFFFFF', fillOpacity: 0.14, zIndex: 3 },
  gpsSegment:      { fillColor: '#3F80FF', fillOpacity: 0.55, zIndex: 5 },
  selectedBand:    { fillColor: '#FFD700', fillOpacity: 0.22, zIndex: 6 },
  // A wash, not a coat. At 0.8 the gold was opaque enough that the coastline,
  // the place names and the sea underneath it all went: the zone you picked was
  // the one part of the map you could no longer read.
  selectedSegment: { fillColor: '#FFD700', fillOpacity: 0.5,  zIndex: 7 },
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
 * quiet, in that order.
 */
export const CHART_FILL_SCALE = 0.35;

// Same weight throughout — hover reads as a brighter border, not a thicker one.
// A weight change nudges the boundary by a pixel, which looks like the shape
// moved; brightness alone plus the fill lift is enough to pick a zone out.
export const OUTLINE = {
  none:  { strokeColor: 'rgba(255,255,255,0.2)', strokeWeight: 1 },
  hover: { strokeColor: '#FFFFFF', strokeWeight: 1 },
} as const;

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

  let fill: (typeof FILLS)[keyof typeof FILLS];
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
  else if (sameOffsetAs(hoveredTzid)) fill = FILLS.hoverBand; // covers the hovered zone itself
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
  // The hover lift is applied AFTER the wash, so pointing at a zone still says
  // so while a chart is up — a proportional dimming of the lift would have made
  // it invisible in exactly the state where the map is quietest.
  return {
    ...wash({ ...fill, ...OUTLINE.hover, zIndex: fill.zIndex + 10 }),
    fillOpacity: Math.min(1, (chartShown ? fill.fillOpacity * CHART_FILL_SCALE : fill.fillOpacity) + 0.15),
  };
}
