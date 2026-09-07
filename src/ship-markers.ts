// src/ship-markers.ts
//
// Ship positions on the world timezone map.
//
// A marker per ship on the World Clock list, plus the ship you are aboard —
// which has no clock row of its own, having collapsed into the Ship Time card,
// but is still the vessel a guest most wants to find on a map.
//
// Kept out of map.ts deliberately. That file already owns two maps, the zone
// layer, hover and selection; a marker set with its own refresh loop and its own
// freshness rules is a separate concern that happens to draw on the same canvas.
//
// This is the only place the app decides what a *stale* position looks like, and
// that judgement is the substance of the module rather than a detail of it. A
// clock is either right or it is withheld. A position is different: it always
// has an age, the age is often minutes and sometimes hours, and the honest
// treatment is to show it with its age rather than to pretend either that it is
// live or that it is unknown.

import { state } from './state';
import { shipKey, type ShipClock } from './ships';
import { shipTimeAvailable } from './rccl';
import { anchorOffsetHours, mapSelection, utcOffsetForCoordinates } from './time';
import {
  fleetFixes,
  fixForShip,
  markerBearing,
  shipTrackAvailable,
  FIX_MAX_AGE_MS,
  FIX_STALE_AGE_MS,
  makingWay,
  voyageTrack,
  type ShipFix,
  type ShipPort,
  type ShipVoyage,
  voyageForShip,
} from './shiptrack';
import { brighter, distance } from './utils';
import { routeAhead, wakeGaps, wakeRuns, type WakePort } from './wake';
import { callNote, departsAt, localDate, voyageYear, type PortCall } from './port-clock';

/**
 * A hull seen from above: pointed bow, flared sides, square stern.
 *
 * Plan view rather than the side profile the clock rows and the widget use, and
 * that is the one thing worth explaining. A side-on ship is the more obvious
 * "ship icon", but it cannot be turned — rotate a silhouette of a ship you are
 * looking at broadside and it reads as a ship falling over. A hull from above
 * rotates the way the vessel actually does, which is what lets one icon serve
 * both "this is a ship" and "this is the way it is pointing".
 *
 * It also replaces what used to be two shapes, an arrow under way and a dot at
 * rest. A hull needs no such split: a moored ship is still a hull lying at some
 * orientation, where an arrow at rest would have been claiming a direction of
 * travel it did not have.
 */
const HULL_PATH = 'M 0,-9 Q 4.5,-4.5 4.5,-1 L 4.5,6.5 L -4.5,6.5 L -4.5,-1 Q -4.5,-4.5 0,-9 Z';

// Crimson, chosen by elimination rather than taste.
//
// The default hull has to survive being confused with FOUR colours that already
// mean something on this map: the GPS blue, the ship green, the selected gold,
// and the white of hover. Turquoise failed on the first — it sat close enough to
// the blue band to blur into it. That leaves the far side of the wheel.
//
// Brown was the obvious alternative and is the wrong one: this map is dark
// water and dark slate, and a low-chroma colour is precisely what vanishes
// against it. Red carries "stop", which a ship is not. Orange lands next door to
// the gold and would blur under a selected band the way turquoise blurred under
// a blue one.
//
// This end of the wheel is far from all four and claims no meaning of its own,
// which is what a DEFAULT should do. The purple in the clock list is a different
// surface and never shares a screen region with this.
const HULL = '#7C2B4A';
// Lighter than the hull rather than darker: a stale mark is drawn at 0.55
// opacity on top of this, and fading a dark colour on a dark map fades it to
// nothing. Muted in saturation, not in lightness.
const HULL_STALE = '#644350';
const OUTLINE = '#101922';
// The same gold the zone layer paints a selected band with, so the marker and
// the region it lit read as one answer rather than two.
const SELECTED = '#FFD700';
// The same green the anchor card and the ship band carry: this is the clock you
// are living by, wearing the colour it wears everywhere else.
const ABOARD = '#34C759';
// White, and only ever a rim — hover says "the pointer is here", never "this is
// what the thing is", so it must not replace the colour that answers that.
const HOVER_RING = '#FFFFFF';

/**
 * Whether the wake's first crumb is close enough to the origin to be joined to it.
 *
 * The same window voyageTrack trims against, for the same reason: inside it the
 * gap is the sampling interval and the join is drawing what happened; outside
 * it the track does not begin at this origin at all, and a join would draw a
 * straight line across an ocean the ship never sailed.
 */
function nearOrigin(crumb: [number, number], origin: [number, number]): boolean {
  const NEAR_DEGREES = 0.4;
  return Math.abs(crumb[0] - origin[0]) < NEAR_DEGREES
      && Math.abs(crumb[1] - origin[1]) < NEAR_DEGREES;
}



/**
 * A port's ring says whether that port keeps the ship's clock. Nothing else.
 *
 * Painting every port in the vessel's colour was wrong in a way worth spelling
 * out: it made a claim rather than a decoration. Aboard Liberty of the Seas the
 * whole itinerary went green, and green means "this is the clock you are living
 * by" — but Lisbon, which she had just left, and Southampton, where she ends,
 * are both an hour off ship time. The map was stating something false about the
 * one question a passenger actually has at a port: do I change my watch here.
 *
 * So the ring answers that and only that: a port that keeps the ship's clock
 * wears the SHIP'S OWN colour, and a port that does not stays plain white.
 *
 * Taking her colour rather than a fixed green is what keeps it honest in both
 * modes. Aboard she is green, so the ports sharing your clock are green — which
 * is the only time green is in play at all. Select her and she is gold, and the
 * ports on her time go gold with her. Either way the ring means "same clock as
 * that ship", and it is never asserting membership of a zone you happened to
 * select, which is what a fixed gold would have implied.
 *
 * A ship neither aboard nor selected has no clock you are measuring against, so
 * her ports all sit at plain white and say nothing. That is correct: there is no
 * question being asked.
 *
 * Null offsets — a port we cannot place, a clock not yet resolved — read as "not
 * the same", because unknown is not a match.
 */
function portColour(
  port: { lat: number; lon: number }, shipOffset: number | null, shipHue: string,
): string {
  if (shipOffset === null) return PORT_PLAIN;
  return utcOffsetForCoordinates(port.lat, port.lon) === shipOffset ? shipHue : PORT_PLAIN;
}

/**
 * The colour a ship — and everything that belongs to her — is drawn in.
 *
 * Selected beats aboard beats ordinary, which is the same order the zone layer
 * resolves in: resolveZoneStyle tests `tzid === selectedTzid` before it tests
 * the ship or GPS bands. Gold answers "you picked this", green answers "this is
 * the clock you are living by", crimson answers "this is a ship". A hull can be
 * all three things at once and the most specific claim wins.
 *
 * Her ports and route take the SAME colour, because they are not separate
 * objects the user picked — they are the vessel's own voyage, and colouring them
 * by the zone they happen to sit in would say something nobody asked about.
 */
/**
 * Gold, but dimmer: a hull that merely keeps the selected time.
 *
 * The same statement the zone band makes, in the one place on the map the band
 * could not reach. A ship keeps a time without occupying a zone, so selecting
 * Cozumel used to light every shore on UTC-5 and leave the two vessels sitting
 * in that same hour looking like strangers to it — the one kind of answer this
 * app exists to give, withheld from the one kind of thing only it can show.
 *
 * Dimmer than SELECTED and no brighter than the wash it belongs to, so "this is
 * the one you picked" and "this keeps the same time" stay two different
 * sentences.
 */
const MATCHING = '#C9A227';

function shipColour(key: string): string {
  if (state.selectedShipKey === key) return SELECTED;
  if (state.aboardShipKey === key) return ABOARD;

  // Only a resolved offset can match. An unresolved ship has no time to compare
  // and must not read as one that happens to agree.
  const selected = mapSelection().offset;
  if (selected !== null) {
    const ship = state.shipClocks.find((s) => shipKey(s) === key);
    if (ship && ship.offsetHours !== null && ship.offsetHours === selected) return MATCHING;
  }
  return HULL;
}

/** Live markers, keyed by "R/ST". */
const markers = new Map<string, google.maps.marker.AdvancedMarkerElement>();

let pollTimer: number | null = null;

/**
 * The hull, turned to the way the vessel is lying.
 *
 * Falls back to north-up when the fix carries neither heading nor course, which
 * is rare — no vessel in the live fleet was missing both. An unrotated hull is a
 * weak claim in a way an unrotated arrow would not have been.
 */
function hullElement(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'ship-hull';
  // The viewBox is symmetric about the origin, so the hull rotates about its own
  // centre — the point the fix actually refers to — with no transform-origin to
  // keep in step. The path is drawn in those same units.
  el.innerHTML =
    `<svg viewBox="-10 -10 20 20"><path d="${HULL_PATH}" stroke="${OUTLINE}" stroke-width="1.5"/></svg>`;
  return el;
}

/**
 * Restyles a hull in place, rather than rebuilding it.
 *
 * The Symbol this replaced was a fresh object handed to setIcon on every
 * refresh. An element is retained and mutated, which is both cheaper and what
 * lets the CSS transition on .ship-hull svg smooth a turning ship instead of
 * snapping it — a Symbol could not be animated at all.
 */
function styleHull(
  el: HTMLElement, fix: ShipFix, stale: boolean, selected: boolean,
  colour: string, hovered: boolean,
): void {
  const svg = el.firstElementChild as SVGElement | null;
  const path = svg?.firstElementChild as SVGElement | null;
  if (!svg || !path) return;

  // One size, always. Growing on selection was compensation for a hull whose
  // default was near-white, where gold on a gold band really was hard to pick
  // out; against magenta the colour change carries it alone, and a marker that
  // changes size makes the map look like it moved.
  const scale = 1.15;
  const size = 20 * scale;
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.style.transform = `rotate(${markerBearing(fix) ?? 0}deg)`;

  path.setAttribute('fill', stale && !selected ? HULL_STALE : colour);
  // A rim rather than a fill, so hovering never hides which kind of ship it is.
  path.setAttribute('stroke', hovered ? HOVER_RING : OUTLINE);
  path.setAttribute('stroke-width', hovered ? '2.5' : '1.5');
  // Faded rather than hidden: an hour-old position is still worth seeing, it
  // just should not read as current.
  path.setAttribute('fill-opacity', stale && !selected ? '0.55' : '1');
  path.setAttribute('stroke-opacity', stale && !selected ? '0.55' : '0.9');
}

/** "3 min ago", "2 hr ago" — relative, never a clock time. */
function ageLabel(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? '1 hr ago' : `${hours} hr ago`;
}

/**
 * Hover text for a marker.
 *
 * Deliberately relative ("14 min ago") rather than absolute ("09:41"). In an app
 * whose whole subject is what time it is somewhere, an absolute time here would
 * be read as a clock — and it would be a clock in an unstated zone, which is the
 * one thing this app exists not to do. The same reasoning kept a fetched-at time
 * off the ship clock rows.
 */
function titleFor(ship: ShipClock, fix: ShipFix, age: number | null): string {
  const parts = [ship.name];
  if (age !== null) parts.push(ageLabel(age));
  if (fix.sog !== null) parts.push(fix.sog > 0.5 ? `${Math.round(fix.sog)} kn` : 'stopped');
  if (fix.destination) parts.push(`→ ${fix.destination}`);
  return parts.join(' · ');
}

/**
 * Every ship that should carry a marker.
 *
 * The whole stored list, including the ship we are aboard — which is the one
 * place this differs from visibleClocks(), where the aboard ship is filtered out
 * because it has become the Ship Time card. On a map it should still be drawn:
 * it is the vessel a guest most wants to find.
 *
 * Gated on ship *time* rather than ship *track* because that gate decides
 * whether ships exist in the UI at all. With no app key there are no ship rows,
 * so a marker would be a position for something the user cannot see.
 */
function markableShips(): ShipClock[] {
  return shipTimeAvailable() ? state.shipClocks : [];
}

function removeMarker(key: string): void {
  const marker = markers.get(key);
  if (!marker) return;
  marker.map = null;
  markers.delete(key);
}

/**
 * Rebuilds the marker set from the ship list and the last fleet snapshot.
 *
 * Cheap and idempotent — existing markers are moved and restyled rather than
 * recreated, so this can be called on every poll and on every list change
 * without the markers flickering.
 */
export function refreshShipMarkers(): void {
  const map = state.timezoneMap;
  if (!map || !shipTrackAvailable()) return;

  const wanted = new Set<string>();

  for (const ship of markableShips()) {
    const key = shipKey(ship);
    const fix = fixForShip(key);
    if (!fix) continue;   // no IMO, or no position for it in the feed

    const age = fix.tst !== null ? Date.now() - fix.tst * 1000 : null;

    // A day-old fix is not stale information, it is wrong information: a ship
    // covers several hundred miles in that time, so the marker would sit in open
    // water nowhere near the vessel. Drawing nothing is the honest answer.
    if (age !== null && age > FIX_MAX_AGE_MS) continue;

    const stale = age !== null && age > FIX_STALE_AGE_MS;
    const position = { lat: fix.lat, lng: fix.lon };

    const selected = state.selectedShipKey === key;

    let marker = markers.get(key);
    if (!marker) {
      marker = new google.maps.marker.AdvancedMarkerElement({
        map,
        position,
        content: hullElement(),
        // Above the zone layer, below the blue GPS dot — that dot answers "where
        // am I", which no ship marker should ever be mistaken for.
        zIndex: 50,
        // Off by default on an AdvancedMarkerElement, unlike the Marker this
        // replaced, so the tap below would silently never fire without it.
        gmpClickable: true,
      });
      // Announced rather than handled here, so this module does not have to
      // import from map.ts, which imports from it. main.ts owns the wiring.
      marker.addListener('gmp-click', () => {
        document.dispatchEvent(new CustomEvent('shipmarkerclick', { detail: { key } }));
      });

      // Hover rides on the content element rather than a maps event: an
      // AdvancedMarkerElement's content is ordinary DOM, and pointerenter is
      // both simpler and free of the synthetic-event ordering the data layer
      // has. Touch is filtered by the listener, not here — the same pointer
      // that taps also fires enter, and a card that appears on tap is fine.
      const hull = marker.content as HTMLElement;
      hull.addEventListener('pointerenter', () => {
        document.dispatchEvent(new CustomEvent('shipmarkerhover', { detail: { key } }));
      });
      hull.addEventListener('pointerleave', () => {
        document.dispatchEvent(new CustomEvent('shipmarkerhover', { detail: { key: null } }));
      });
      markers.set(key, marker);
    } else {
      marker.position = position;
    }

    styleHull(marker.content as HTMLElement, fix, stale, selected,
              shipColour(key), state.hoveredShipKey === key);
    marker.title = titleFor(ship, fix, age);
    // Selected sits above its neighbours, which matters where ships cluster in
    // the same port.
    marker.zIndex = selected ? 60 : 50;
    wanted.add(key);
  }

  // Anything left is a ship that was removed from the list, lost its fix, or
  // aged out.
  for (const key of [...markers.keys()]) {
    if (!wanted.has(key)) removeMarker(key);
  }
}

// ---------------------------------------------------------------------------
// The chart: one ship's wake, the route ahead, and the ports along it.
//
// Only ever the selected ship. Forty-four overlapping tracks would be noise
// even if they were free, and they are not — the track and route come from a
// per-ship request where positions come from one shared one.
// ---------------------------------------------------------------------------

/**
 * Every line is drawn twice: a dark wider casing underneath, the real line on
 * top.
 *
 * Not decoration. A single light line has to stay legible over dark ocean,
 * slate land, the blue GPS band and the gold band the selection itself just
 * painted — and the gold is the problem, because a pale line on a pale wash
 * disappears exactly when the user has asked to look at it. The casing gives
 * every segment its own contrast regardless of what it crosses.
 */
const CASING = '#0B1219';

/** How much wider than its line a casing is drawn, in pixels. */
const CASING_WIDTH = 2;

/**
 * The dot geometry, and why the spacing is what it is.
 *
 * These itineraries are round trips: the route out and the route home are the
 * same polyline through the same water, so at most zooms it is drawn over
 * itself. Symbol spacing is measured along the PATH, which means the homeward
 * pass lands at whatever phase its own accumulated length happens to give it —
 * and where that phase is half a period, the two trains interleave and the gaps
 * fill in. The line reads solid, and appears to change spacing with zoom,
 * because the pixel length of the outbound leg changes and with it the phase.
 *
 * The pattern therefore has to survive being drawn twice at the worst possible
 * offset. Interleaved, a mark of L every R leaves gaps of R/2 - L, which is
 * why R stays near 4L. It was 5 and 13, leaving 1.5 — indistinguishable from
 * solid, which is what was reported.
 *
 * Dots rather than dashes because a dash long enough to read as a dash is
 * expensive under that rule: it buys its own length back four times over in
 * empty space, and the line went sparse.
 *
 * The spacing is then set BELOW what that rule would allow, deliberately. At 6px
 * a single pass reads as a fine dotted line, which is what the route wanted; a
 * leg the ship retraces reads closer to solid, because two trains of 4px marks
 * 3px apart have nowhere to leave a gap. That trade was made with both versions
 * on screen — the retraced legs are a minority of any itinerary, and the whole
 * line being too sparse was the fault worth fixing. 9px is where they separate
 * again, if it ever wants going back.
 *
 * The dot carries its own dark rim instead of a casing polyline underneath.
 * Casing a dotted line would be worse than not casing it: the halo is wider
 * than the mark, so the halos merge at spacings where the dots do not, and the
 * result is a dark line with beads on it.
 */
const DOT_RADIUS = 1.5;
const DOT_RIM = 1;
const DOT_REPEAT_PX = 6;

/**
 * The dotted stretch across a gap in the wake.
 *
 * Deliberately not any vessel's colour — the wake's hue says WHICH ship, and a
 * grey says this stretch is not the ship's track at all. Light enough to read as
 * subordinate to every real line on the chart.
 */
const GAP = '#9AA4B2';

/**
 * The colour of a port that says nothing.
 *
 * Not the hull colour, which is what it was and which was wrong for a reason
 * worth keeping. Ports are only ever on screen at all when a ship is selected or
 * aboard — so they always appear in company with a row of green or gold rings
 * beside them. A saturated default among those does not read as "no claim", it
 * reads as a third claim, and the eye goes to it.
 *
 * Near-white rather than pure white: #FFFFFF is what hover paints, and a port
 * ring that exactly matched it would blur two different statements together.
 */
const PORT_PLAIN = '#E8EEF4';

// One colour for the whole track, solid behind and dashed ahead. Solid for
// travelled and dashed for planned is a convention that needs no legend, and the
// hue is the vessel's own — see shipColour — so a route reads as belonging to
// the ship it leaves, rather than as a third thing on the map.

/**
 * Everything the chart owns, so it can be torn down without hunting.
 *
 * A union rather than a common base type: AdvancedMarkerElement is not an
 * MVCObject and detaches by assigning `map`, where a Polyline still wants
 * setMap(null). Naming both is what keeps clearChart from having to guess.
 */
type ChartPiece = google.maps.Polyline | google.maps.marker.AdvancedMarkerElement;
let chart: ChartPiece[] = [];

function clearChart(): void {
  for (const piece of chart) {
    if (piece instanceof google.maps.Polyline) piece.setMap(null);
    else piece.map = null;
  }
  chart = [];
  // The rings are not part of it — see the port layer below — but the chart's
  // own calls are, and they go with the lines they belonged to.
  chartCalls = [];
}

/** A solid line, cased. Dotted lines case themselves — see dottedRoute. */
function polyline(
  map: google.maps.Map,
  path: google.maps.LatLngLiteral[],
  options: google.maps.PolylineOptions
): void {
  // Casing first, so it sits under its own line.
  chart.push(new google.maps.Polyline({
    map,
    path,
    clickable: false,
    strokeColor: CASING,
    strokeOpacity: 0.55,
    strokeWeight: (options.strokeWeight ?? 2) + CASING_WIDTH,
    zIndex: (options.zIndex ?? 10) - 1,
  }));
  chart.push(new google.maps.Polyline({ map, path, clickable: false, ...options }));
}

/**
 * The route still to come: her own colour, dotted, rimmed rather than cased.
 *
 * `strokeOpacity: 0` with a repeating symbol is how the Maps API draws anything
 * but a solid line — the stroke itself is invisible and the symbols are the
 * whole of what is seen. `repeat` in px is screen distance, so the spacing is
 * the same at every zoom; see DOT_REPEAT_PX for the part that only looked as
 * though it were not.
 */
function dottedRoute(
  map: google.maps.Map, path: google.maps.LatLngLiteral[], colour: string
): void {
  chart.push(new google.maps.Polyline({
    map,
    path,
    clickable: false,
    strokeOpacity: 0,
    zIndex: 15,
    icons: [{
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: DOT_RADIUS,
        fillColor: colour,
        fillOpacity: 0.9,
        // The rim is the casing: dark, tight to the dot, and 1px of it is
        // enough to hold a gold dot off the gold band it is standing on.
        strokeColor: CASING,
        strokeOpacity: 0.75,
        strokeWeight: DOT_RIM,
      },
      offset: '0',
      repeat: `${DOT_REPEAT_PX}px`,
    }],
  }));
}

/**
 * A gap in the wake, drawn as what it is: a guess at the shape of an absence.
 *
 * Grey rather than the vessel's colour, and dotted rather than drawn, because
 * the line is not saying "she sailed this". It is saying "she got from here to
 * there and the feed does not say how" — the same thing a mapping app means by a
 * dotted leg where it has no path.
 *
 * No casing under it, unlike polyline(): the casing exists to lift a real track
 * off the sea, and lifting this one would give an inference the weight of a
 * fact. `strokeOpacity: 0` with a repeating dash is how the Maps API draws a
 * dotted line at all — the stroke itself is invisible and the icons are the
 * whole of what is seen.
 */
function dottedGap(map: google.maps.Map, path: google.maps.LatLngLiteral[]): void {
  chart.push(new google.maps.Polyline({
    map,
    path,
    clickable: false,
    strokeOpacity: 0,
    zIndex: 19,   // under the wake, so a real track always wins an overlap
    icons: [{
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 1,
        fillColor: GAP,
        fillOpacity: 0.8,
        strokeOpacity: 0,
        strokeWeight: 0,
      },
      offset: '0',
      // Smaller and unrimmed, so a guess never reads as heavily as the route it
      // sits beside even where the two run parallel.
      repeat: '9px',
    }],
  }));
}

/**
 * What a port announces about itself when it is pointed at or tapped.
 *
 * Carries coordinates rather than a zone, because resolving one needs the
 * boundary data in time.ts and this module has no business loading it. The
 * listener in map.ts is already holding both.
 */
export interface PortMarkerDetail {
  name: string;
  lat: number;
  lon: number;
  /** "day 4 · arrives Tue 8:00 AM", or empty. The subtitle, never the name. */
  detail: string;
}

/**
 * Her ports of call, each resolved to instants and to the line it should say.
 *
 * Done once per redraw and handed to every layer, because the wake, the route
 * ahead, the rings and their tooltips are all answering the same question —
 * where is she in this itinerary — and had better answer it identically.
 *
 * The zone a time is stated in is the PORT's, from its own coordinates, and
 * getting that wrong is not cosmetic: read in the device's zone instead, every
 * Caribbean call sat three hours in the future for a reader in Vancouver, and
 * the route ahead ran backwards to the port she had just left. Her own clock
 * stands in where the boundary data has not loaded — she is alongside the
 * place, so it is the closest thing to hand — and UTC where even that is
 * unknown.
 *
 * "Today", by contrast, is the ANCHOR's day: the clock the reader is living by,
 * which aboard is the ship's and ashore is the ground's.
 */
interface Call extends WakePort {
  port: ShipPort;
  name: string;
  /** "day 4 · arrives Tue 8:00 AM". */
  note: string;
}

function portCalls(voyage: ShipVoyage, shipOffset: number | null): Call[] {
  const year = voyageYear(voyage.voyage.startDate, voyage.voyage.endDate);
  const now = Date.now() + state.timeOffset;
  const todayDate = localDate(now, anchorOffsetHours());

  const resolved = voyage.ports.map((port) => {
    const offset = utcOffsetForCoordinates(port.lat, port.lon) ?? shipOffset ?? 0;
    return {
      port,
      call: {
        day: port.day,
        arrive: port.arrive ?? null,
        depart: port.depart,
        arrivesAt: departsAt(port.arrive ?? null, offset, year),
        departsAt: departsAt(port.depart, offset, year),
      } satisfies PortCall,
    };
  });

  // Only the call she has most recently left keeps its departure time; see
  // callNote. Latest by the clock rather than by itinerary order, so a voyage
  // whose ports arrive out of order cannot pick the wrong one.
  let latest = -Infinity;
  for (const { call } of resolved) {
    if (call.departsAt !== null && call.departsAt <= now) latest = Math.max(latest, call.departsAt);
  }

  return resolved.map(({ port, call }) => ({
    port,
    lon: port.lon,
    lat: port.lat,
    departsAt: call.departsAt,
    name: port.name ?? voyage.destination ?? 'Port of call',
    note: callNote(call, {
      now,
      todayDate,
      latestDeparture: call.departsAt !== null && call.departsAt === latest,
      year,
    }),
  }));
}

/**
 * Draws the selected ship's chart. Safe to call repeatedly; replaces itself.
 *
 * The wake is clipped to the voyage in progress — see voyageTrack(). Drawing the
 * raw window would reach back through previous sailings, which answers a
 * question nobody asked.
 */
export async function drawShipChart(key: string, voyage: Promise<ShipVoyage | null>): Promise<void> {
  const map = state.timezoneMap;
  if (!map) return;

  const resolved = await voyage.catch(() => null);

  // The selection may have moved on while that was in flight. Drawing now would
  // put one ship's route under another ship's highlight. The ship you are ON is
  // exempt: her chart is not a response to a selection, so nothing about a
  // selection can invalidate it.
  if (state.selectedShipKey !== key && state.aboardShipKey !== key) return;

  // Her ROUTE wears the vessel's colour; her ports answer a different question
  // entirely — see portColour.
  const routeColour = shipColour(key);
  const shipOffset = state.shipClocks.find((c) => shipKey(c) === key)?.offsetHours ?? null;

  clearChart();
  if (!resolved) return;

  const toLatLng = (p: [number, number]) => ({ lat: p[1], lng: p[0] });

  // Only the part still to come, starting at the vessel. The wake covers where
  // it has been, so the two meet at the ship and neither repeats the other.
  const fix = fixForShip(key);
  const now = Date.now() + state.timeOffset;
  const calls = portCalls(resolved, shipOffset);
  // Her course only counts as a course while she is moving — see routeAhead.
  const ahead = routeAhead(
    resolved.route, calls, resolved.voyage.endDate,
    fix ? [fix.lon, fix.lat] : null,
    fix && makingWay(fix) ? markerBearing(fix) : null, now);
  if (ahead.length >= 2) dottedRoute(map, ahead.map(toLatLng), routeColour);

  // The wake is the least reliable of the three layers, and silently so: the
  // upstream `track` array can come back EMPTY for a ship that had 720 points a
  // few hours earlier, while its route and position keep working. Observed on
  // Star of the Seas within a single day, with two other vessels unaffected. So
  // no wake is a normal state, not a failure to report — the route still frames
  // the cruise and the marker still says where the ship is.
  // Copied, not aliased: voyageTrack returns the stored array itself on several
  // paths, and the fix appended below would then be written into the cached
  // voyage — growing its track by one point on every redraw.
  const wake = [...voyageTrack(resolved)];
  // Joined to the voyage at BOTH ends, because the breadcrumbs are a sample and
  // neither end of a sample lands where the thing it samples begins or stops.
  //
  // Astern: voyageTrack trims to the first crumb within about 25 nm of the
  // departure point, so the line started up to that far offshore of the port it
  // sailed from. Ahead: the crumbs stop at the last fix the track feed holds,
  // which can be an hour behind the position the hull is drawn at, so the line
  // ended in open water short of its own ship.
  //
  // Both gaps are artefacts of sampling rather than facts about the voyage, and
  // the two points that close them are already known — the route's own origin,
  // and the fix the marker is standing on.
  const origin = resolved.route[0];
  if (origin && wake.length > 0 && nearOrigin(wake[0], origin)) wake.unshift(origin);
  if (fix) wake.push([fix.lon, fix.lat]);

  // Solid where the trail is continuous, dotted across whatever it does not
  // account for. The alternative to the dotted stretch is not "nothing missing"
  // — it is a wake that stops in open water with no explanation, which reads as
  // a rendering fault rather than as an absence of data.
  const gaps = wakeGaps(wake, calls, now);
  const runs = wakeRuns(wake, gaps);
  for (const run of runs) {
    if (run.length < 2) continue;
    polyline(map, run.map(toLatLng), {
      strokeColor: routeColour,
      strokeOpacity: 0.95,
      strokeWeight: 2,
      zIndex: 20,
    });
  }
  for (let i = 1; i < runs.length; i++) {
    const before = runs[i - 1][runs[i - 1].length - 1];
    const after = runs[i][0];
    dottedGap(map, [before, after].map(toLatLng));
  }

  chartCalls = calls;
  chartColour = routeColour;
  chartShipOffset = shipOffset;
  refreshPortMarkers();
}

// ---------------------------------------------------------------------------
// Ports of call.
//
// Their own layer rather than part of the chart, because they outlive it. A
// port kept on the World Clock is a place the user has said they care about,
// and it should be on the map at launch — before any ship is selected, and
// after the cruise it came from has sailed and been replaced by the next one.
//
// The chart's own calls are drawn here too, so the two cannot disagree about a
// port that is both. Chart first: it knows the day, the times, and whether the
// call keeps the ship's time, where a saved row knows only where it is.
// ---------------------------------------------------------------------------

/** The selected ship's calls, or none. Set by drawShipChart, cleared with it. */
let chartCalls: Call[] = [];
let chartColour = PORT_PLAIN;
let chartShipOffset: number | null = null;

const portMarkers = new Map<string, google.maps.marker.AdvancedMarkerElement>();

/** One port, wherever it came from, in the form the marker layer needs. */
interface PortPin {
  key: string;
  name: string;
  lat: number;
  lon: number;
  note: string;
  colour: string;
}

/** Ports are the same place at 11 m, which is finer than any of them is known. */
const pinKey = (lat: number, lon: number) => `${lat.toFixed(4)},${lon.toFixed(4)}`;

function portPins(): PortPin[] {
  const pins = new Map<string, PortPin>();

  for (const call of chartCalls) {
    pins.set(pinKey(call.lat, call.lon), {
      key: pinKey(call.lat, call.lon),
      name: call.name,
      lat: call.lat,
      lon: call.lon,
      note: call.note,
      colour: portColour(call.port, chartShipOffset, chartColour),
    });
  }

  // A KEPT port the chart has not already drawn. It carries no itinerary of its
  // own — no day, no times — so it says only its name, which is the whole of
  // what a row on the World Clock knows about it.
  //
  // Kept means on the list, not merely visited. selectPort records a port's
  // name, kind and position the moment it is picked, because the temporary row
  // needs all three to render and the pin needs them to survive being pressed —
  // so reading zonePlaces alone drew every port anyone had ever tapped, for the
  // rest of the session, with nothing left on screen to explain them.
  for (const tzid of state.addedTimezones) {
    const at = state.zonePlaces[tzid];
    if (!at || state.zoneKinds[tzid] !== 'port') continue;
    const key = pinKey(at.lat, at.lon);
    if (pins.has(key)) continue;
    pins.set(key, {
      key,
      name: state.zoneLabels[tzid] ?? tzid,
      lat: at.lat,
      lon: at.lon,
      note: '',
      colour: PORT_PLAIN,
    });
  }

  return [...pins.values()];
}

/**
 * Rebuilds the port rings. Cheap and idempotent, like refreshShipMarkers.
 *
 * Recreated rather than restyled, because a ring's content is three attributes
 * of one SVG and rebuilding it is less code than reaching into it — and because
 * a pin's identity is its position, which never changes while it exists.
 */
export function refreshPortMarkers(): void {
  const map = state.timezoneMap;
  if (!map) return;

  const wanted = new Set<string>();
  const selected = state.selectedPort;

  for (const pin of portPins()) {
    wanted.add(pin.key);
    // Detach the previous ring at this position before replacing it.
    const previous = portMarkers.get(pin.key);
    if (previous) previous.map = null;
    const isSelected = !!selected && pinKey(selected.lat, selected.lon) === pin.key;

    const ring = document.createElement('div');
    ring.className = isSelected ? 'ship-port is-selected' : 'ship-port';
    // Hover and selection are the same colour further up the scale, handed to
    // CSS rather than repainted here — see .ship-port in style.css, and
    // brighter(). Never white: the ring's own colour is an answer, and hover
    // must not overwrite it with the question.
    ring.style.setProperty('--port-hover', brighter(pin.colour));
    // Three circles: the halo that says this one is picked, the ring you see,
    // and a transparent one twice its size that is what you actually hit. A 4px
    // ring is a fine thing to look at and a poor thing to aim a finger at.
    ring.innerHTML =
      `<svg viewBox="-11 -11 22 22" width="22" height="22">` +
      `<circle r="10" fill="transparent"/>` +
      `<circle class="port-halo" r="8" fill="none" stroke="${brighter(pin.colour)}" ` +
      `stroke-width="1.5"/>` +
      `<circle class="port-ring" r="4" fill="${CASING}" fill-opacity="0.9" ` +
      `stroke="${pin.colour}" stroke-width="2" stroke-opacity="0.95"/></svg>`;

    const marker = new google.maps.marker.AdvancedMarkerElement({
      map,
      position: { lat: pin.lat, lng: pin.lon },
      title: pin.note ? `${pin.name} · ${pin.note}` : pin.name,
      content: ring,
      // Under the ship itself, over the lines. The selected one rises above its
      // neighbours, which matters where two calls share a coastline.
      zIndex: isSelected ? 45 : 40,
      // Off by default on an AdvancedMarkerElement, so the tap would silently
      // never fire without it.
      gmpClickable: true,
    });

    // Announced rather than handled here, for the same reason the hull's are:
    // this module cannot import from map.ts, which imports from it. main.ts
    // owns the wiring.
    //
    // Hover rides on the content element rather than a maps event — an
    // AdvancedMarkerElement's content is ordinary DOM — and what it paints is
    // pure CSS, so pointing at a port costs no redraw.
    const detail: PortMarkerDetail = {
      name: pin.name, lat: pin.lat, lon: pin.lon, detail: pin.note,
    };
    marker.addListener('gmp-click', () => {
      document.dispatchEvent(new CustomEvent('portmarkerclick', { detail }));
    });
    ring.addEventListener('pointerenter', () => {
      document.dispatchEvent(new CustomEvent('portmarkerhover', { detail }));
    });
    ring.addEventListener('pointerleave', () => {
      document.dispatchEvent(new CustomEvent('portmarkerhover', { detail: null }));
    });
    portMarkers.set(pin.key, marker);
  }

  for (const [key, marker] of [...portMarkers]) {
    if (wanted.has(key)) continue;
    marker.map = null;
    portMarkers.delete(key);
  }
}

/** Removes the chart. For deselection, and for selecting a zone instead. */
export function clearShipChart(): void {
  clearChart();
  // The saved ports outlive it and have to be put back; see the port layer.
  refreshPortMarkers();
}

/**
 * Brings a ship into view: the whole cruise if we can, the ship itself if not.
 *
 * Takes the voyage as a promise rather than fetching it, so selection can be
 * instant and the map settles a moment later — the highlight, the card and the
 * marker do not wait on a network round trip.
 *
 * Fitting the ROUTE rather than the position is the difference between framing
 * a cruise and framing a dot in an ocean. Where there is no route — a
 * repositioning leg, a vessel between voyages — the position is the best
 * available answer, and a modest zoom beats dropping the viewer at world scale
 * onto a single marker.
 */
export async function fitToShip(key: string, voyage: Promise<ShipVoyage | null>): Promise<void> {
  const map = state.timezoneMap;
  if (!map) return;

  const resolved = await voyage.catch(() => null);

  // The user may have picked another ship, or deselected, while that was in
  // flight. Moving the map now would be answering a question they stopped
  // asking.
  if (state.selectedShipKey !== key) return;

  // Framed on what will be DRAWN, not on what upstream measured.
  //
  // `extent` is the route's own bounding box and nothing else, so a wake that
  // wanders outside the planned line gets cropped — and wakes do, because a
  // route is a handful of great-circle waypoints and a track is where the hull
  // actually went. Wonder of the Seas' route spanned 25.08 to 25.85 north while
  // her wake reached 26.52, so the top of her own trail was off the map she had
  // just been framed to. Her position can fall outside it too, for the same
  // reason.
  const fix = fixForShip(key);
  const bounds = new google.maps.LatLngBounds();
  let framed = false;
  const include = (lon: number, lat: number) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    bounds.extend({ lat, lng: lon });
    framed = true;
  };

  if (resolved) {
    for (const [lon, lat] of resolved.route) include(lon, lat);
    // The clipped wake, which is what the chart draws — not the rolling window,
    // which reaches back through previous sailings.
    for (const [lon, lat] of voyageTrack(resolved)) include(lon, lat);
    for (const port of resolved.ports) include(port.lon, port.lat);
  }
  if (fix) include(fix.lon, fix.lat);

  // Upstream's box only where we have nothing of our own — a voyage whose route
  // and track both came back empty still frames somewhere better than the world.
  const extent = resolved?.extent;
  if (!framed && extent && extent.length === 4 && extent.every((n) => Number.isFinite(n))) {
    const [minLat, minLon, maxLat, maxLon] = extent;
    include(minLon, minLat);
    include(maxLon, maxLat);
  }

  if (framed) {
    // Enough margin that the route does not run into the edges, where the ports
    // at each end of it would be half off the map.
    map.fitBounds(bounds, 48);
    return;
  }

  if (!fix) return;
  map.setCenter({ lat: fix.lat, lng: fix.lon });
  map.setZoom(Math.max(map.getZoom() ?? 2, 4));
}

/** Drops every marker. For when ship features go away entirely. */
export function clearShipMarkers(): void {
  for (const key of [...markers.keys()]) removeMarker(key);
}

/** True when at least one ship on the list could have a position drawn. */
function worthPolling(): boolean {
  return shipTrackAvailable() && markableShips().length > 0;
}

/**
 * Keeps the wake current for every ship on the list, not just a selected one.
 *
 * voyageForShip was only ever called for a SELECTION, so the detail bundle — and
 * with it the track the Worker retains and serves back during port calls — was
 * refreshed only while somebody had that ship open on the map. Adding a ship to
 * the World Clock refreshed nothing: the list needs an offset, and that comes
 * from a different endpoint entirely.
 *
 * That mattered once the survey showed upstream serves no track while a ship is
 * alongside. The retained copy is what gets drawn at every port call, and it was
 * only as fresh as the last time someone happened to be looking at the map while
 * she was under way. Star of the Seas was four days stale by that route.
 *
 * Cheap, because both caches are already sized for it: voyageForShip holds a
 * voyage for thirty minutes and the Worker's edge cache holds the response for
 * the same, so this is at most two requests per watched ship per hour no matter
 * how often the poll runs, and upstream sees one of them however many people are
 * watching. It also inherits the poll's manners — nothing happens while the page
 * is hidden, or while the list holds no ships.
 */
function refreshWatchedVoyages(): void {
  for (const ship of markableShips()) void voyageForShip(shipKey(ship)).catch(() => {});
}

async function pollOnce(): Promise<void> {
  if (!worthPolling()) return;
  await fleetFixes();
  refreshShipMarkers();
  refreshWatchedVoyages();
}

/**
 * Keeps positions current while the app is in front of someone.
 *
 * Paced to the Worker's own cache rather than to anything the UI needs: asking
 * more often than 60 s cannot produce a newer answer. Polling stops entirely
 * when the page is hidden and when the list holds no ships, so an app left open
 * on a phone in a pocket is not quietly making requests all day against
 * somebody else's endpoint.
 */
export function startShipMarkerWatch(): void {
  const POLL_MS = 60 * 1000;

  const stop = () => {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const start = () => {
    // Not while hidden. Without the visibility check here, a launch that begins
    // in the background — which is every launch in a hidden pane, and any app
    // resumed straight into another task — sets a timer that then polls all day
    // with nobody looking at the map.
    if (pollTimer !== null || document.hidden || !worthPolling()) return;
    pollTimer = window.setInterval(() => void pollOnce(), POLL_MS);
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stop();
      return;
    }
    // Coming back into view: the cached snapshot is almost certainly older than
    // the poll interval, so ask now rather than waiting a minute to look right.
    void pollOnce();
    start();
  });

  // Adding or removing a ship changes whether there is anything to poll for, and
  // a newly added ship should appear on the map without waiting for the tick.
  document.addEventListener('shipclockschanged', () => {
    void pollOnce();
    if (worthPolling()) start();
    else stop();
  });

  void pollOnce();
  start();
}
