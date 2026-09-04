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
import {
  fleetFixes,
  fixForShip,
  markerBearing,
  shipTrackAvailable,
  FIX_MAX_AGE_MS,
  FIX_STALE_AGE_MS,
  routeAhead,
  voyageTrack,
  type ShipFix,
  type ShipPort,
  type ShipVoyage,
} from './shiptrack';

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

// Distinct from the blue GPS dot on the same map, and legible on all four
// grounds it has to sit on: dark water, slate land, and the blue and gold band
// washes the zone layer paints underneath.
const HULL = '#F2F6FA';
const HULL_STALE = '#9BAAB8';
const OUTLINE = '#101922';
// The same gold the zone layer paints a selected band with, so the marker and
// the region it lit read as one answer rather than two.
const SELECTED = '#FFD700';

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
function styleHull(el: HTMLElement, fix: ShipFix, stale: boolean, selected: boolean): void {
  const svg = el.firstElementChild as SVGElement | null;
  const path = svg?.firstElementChild as SVGElement | null;
  if (!svg || !path) return;

  // A touch larger when selected, on top of the colour change — the gold alone
  // is hard to pick out against the gold band it just lit.
  const scale = selected ? 1.5 : 1.15;
  const size = 20 * scale;
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.style.transform = `rotate(${markerBearing(fix) ?? 0}deg)`;

  path.setAttribute('fill', selected ? SELECTED : stale ? HULL_STALE : HULL);
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

    styleHull(marker.content as HTMLElement, fix, stale, selected);
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

// One colour for the whole track, solid behind and dashed ahead. Solid for
// travelled and dashed for planned is a convention that needs no legend, and
// spending a second hue on it would put the route in competition with the gold —
// which on this map means one thing only: the thing you selected. Gold is
// therefore left to the band, the ship and its ports.
const TRACK = '#E8EEF4';
const PORT_RING = '#FFD700';

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
}

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
    strokeWeight: (options.strokeWeight ?? 2) + 3,
    zIndex: (options.zIndex ?? 10) - 1,
    icons: options.icons,
  }));
  chart.push(new google.maps.Polyline({ map, path, clickable: false, ...options }));
}

/** "Coco Cay · day 2 · departs 17:00", as much of it as we actually know. */
function portTitle(port: ShipPort, fallbackName: string | null): string {
  const parts = [port.name ?? fallbackName ?? 'Port of call'];
  if (port.day !== null) parts.push(`day ${port.day}`);
  if (port.depart) {
    // The upstream string is "2026-08-31 17:00:00" in the port's own local time.
    // Only the clock part is shown, and deliberately without a zone: this is a
    // scheduled departure as the itinerary states it, not a moment converted
    // into anybody's timezone. Naming a zone we have not established would be
    // the one mistake this app exists to avoid.
    const clock = port.depart.slice(11, 16);
    if (clock) parts.push(`departs ${clock}`);
  }
  return parts.join(' · ');
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
  // put one ship's route under another ship's highlight.
  if (state.selectedShipKey !== key) return;

  clearChart();
  if (!resolved) return;

  const toLatLng = (p: [number, number]) => ({ lat: p[1], lng: p[0] });

  // Only the part still to come, starting at the vessel. The wake covers where
  // it has been, so the two meet at the ship and neither repeats the other.
  const fix = fixForShip(key);
  const ahead = routeAhead(resolved, fix ? [fix.lon, fix.lat] : null);
  if (ahead.length >= 2) {
    polyline(map, ahead.map(toLatLng), {
      // strokeOpacity 0 with a repeating icon is how the Maps API draws a dashed
      // line — the stroke itself is invisible and the dashes are the symbols.
      strokeOpacity: 0,
      strokeWeight: 2,
      zIndex: 15,
      icons: [{
        icon: {
          path: 'M 0,-1 0,1',
          strokeColor: TRACK,
          strokeOpacity: 0.85,
          strokeWeight: 2,
          scale: 2.5,
        },
        offset: '0',
        repeat: '13px',
      }],
    });
  }

  // The wake is the least reliable of the three layers, and silently so: the
  // upstream `track` array can come back EMPTY for a ship that had 720 points a
  // few hours earlier, while its route and position keep working. Observed on
  // Star of the Seas within a single day, with two other vessels unaffected. So
  // no wake is a normal state, not a failure to report — the route still frames
  // the cruise and the marker still says where the ship is.
  const wake = voyageTrack(resolved);
  if (wake.length >= 2) {
    polyline(map, wake.map(toLatLng), {
      strokeColor: TRACK,
      strokeOpacity: 0.95,
      strokeWeight: 2.5,
      zIndex: 20,
    });
  }

  for (const port of resolved.ports) {
    const ring = document.createElement('div');
    ring.className = 'ship-port';
    ring.innerHTML =
      `<svg viewBox="-8 -8 16 16" width="16" height="16"><circle r="4" fill="${CASING}" ` +
      `fill-opacity="0.9" stroke="${PORT_RING}" stroke-width="2" stroke-opacity="0.95"/></svg>`;
    chart.push(new google.maps.marker.AdvancedMarkerElement({
      map,
      position: { lat: port.lat, lng: port.lon },
      title: portTitle(port, null),
      content: ring,
      // Under the ship itself, over the lines.
      zIndex: 40,
    }));
  }
}

/** Removes the chart. For deselection, and for selecting a zone instead. */
export function clearShipChart(): void {
  clearChart();
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

  const extent = resolved?.extent;
  if (extent && extent.length === 4 && extent.every((n) => Number.isFinite(n))) {
    const [minLat, minLon, maxLat, maxLon] = extent;
    map.fitBounds(
      new google.maps.LatLngBounds({ lat: minLat, lng: minLon }, { lat: maxLat, lng: maxLon }),
      // Enough margin that the route does not run into the edges, where the
      // ports at each end of it would be half off the map.
      48
    );
    return;
  }

  const fix = fixForShip(key);
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

async function pollOnce(): Promise<void> {
  if (!worthPolling()) return;
  await fleetFixes();
  refreshShipMarkers();
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
