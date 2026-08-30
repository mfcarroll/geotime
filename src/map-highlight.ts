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
  gpsBand:         { fillColor: '#3F80FF', fillOpacity: 0.35, zIndex: 2 },
  hoverBand:       { fillColor: '#FFFFFF', fillOpacity: 0.18, zIndex: 3 },
  gpsSegment:      { fillColor: '#3F80FF', fillOpacity: 0.75, zIndex: 5 },
  selectedBand:    { fillColor: '#FFD700', fillOpacity: 0.3,  zIndex: 6 },
  selectedSegment: { fillColor: '#FFD700', fillOpacity: 0.8,  zIndex: 7 },
} as const;

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
  /** Zone the user has selected, or null. */
  selectedTzid: string | null;
  /** GPS-derived local zone, or null. */
  gpsTzid: string | null;
  /** Zone under the pointer, or null. */
  hoveredTzid: string | null;
  /** Current UTC offset of an arbitrary zone id. */
  offsetOf: (tzid: string) => number;
}

export function resolveZoneStyle(input: ZoneStyleInput): ZoneStyle {
  const { tzid, offset, selectedTzid, gpsTzid, hoveredTzid, offsetOf } = input;

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
  else if (sameOffsetAs(gpsTzid)) fill = FILLS.gpsBand;
  else if (sameOffsetAs(selectedTzid)) fill = FILLS.selectedBand;
  else if (sameOffsetAs(hoveredTzid)) fill = FILLS.hoverBand; // covers the hovered zone itself
  else fill = FILLS.base;

  if (!isHovered) return { ...fill, ...OUTLINE.none };

  // Hovering always outlines the zone under the pointer, whatever fill it
  // already carries. Without this a zone inside the selected band returned the
  // band style and dropped out of the chain before hover was ever considered,
  // so pointing at a neighbour gave no feedback at all. Lift it above its own
  // band too, or the outline gets painted over by an adjacent zone.
  return {
    ...fill,
    ...OUTLINE.hover,
    fillOpacity: Math.min(1, fill.fillOpacity + 0.15),
    zIndex: fill.zIndex + 10,
  };
}
