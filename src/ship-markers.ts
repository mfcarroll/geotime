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
  type ShipFix,
} from './shiptrack';

/**
 * A vessel under way: an arrow, rotated to its course.
 *
 * The concave tail is the convention every AIS plot uses, and it earns its
 * keep — it makes the pointed end unambiguous at a size where a plain triangle
 * reads equally well in either direction, which for a heading marker is the
 * whole point.
 */
const UNDER_WAY_PATH = 'M 0,-9 L 5.5,7 L 0,3.5 L -5.5,7 Z';

// Distinct from the blue GPS dot on the same map, and legible on all four
// grounds it has to sit on: dark water, slate land, and the blue and gold band
// washes the zone layer paints underneath.
const HULL = '#F2F6FA';
const HULL_STALE = '#9BAAB8';
const OUTLINE = '#101922';

/** Live markers, keyed by "R/ST". */
const markers = new Map<string, google.maps.Marker>();

let pollTimer: number | null = null;

/**
 * Course-up arrow, or a dot when there is no course to point.
 *
 * A vessel alongside or at anchor reports `sog` 0 and whatever heading it
 * happens to be lying at, which is real but says nothing about where it is
 * going — and an arrow is a claim about direction. A dot makes no claim. Same
 * for a fix with neither course nor heading.
 */
function symbolFor(fix: ShipFix, stale: boolean): google.maps.Symbol {
  const bearing = markerBearing(fix);
  const moving = (fix.sog ?? 0) > 0.5 && bearing !== null;

  return {
    path: moving ? UNDER_WAY_PATH : google.maps.SymbolPath.CIRCLE,
    scale: moving ? 1 : 4.5,
    rotation: moving ? bearing! : 0,
    fillColor: stale ? HULL_STALE : HULL,
    // Faded rather than hidden: an hour-old position is still worth seeing, it
    // just should not read as current.
    fillOpacity: stale ? 0.55 : 1,
    strokeColor: OUTLINE,
    strokeWeight: 1.5,
    strokeOpacity: stale ? 0.55 : 0.9,
  };
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
  marker.setMap(null);
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

    let marker = markers.get(key);
    if (!marker) {
      marker = new google.maps.Marker({
        map,
        position,
        // Above the zone layer, below the blue GPS dot — that dot answers "where
        // am I", which no ship marker should ever be mistaken for.
        zIndex: 50,
      });
      markers.set(key, marker);
    } else {
      marker.setPosition(position);
    }

    marker.setIcon(symbolFor(fix, stale));
    marker.setTitle(titleFor(ship, fix, age));
    wanted.add(key);
  }

  // Anything left is a ship that was removed from the list, lost its fix, or
  // aged out.
  for (const key of [...markers.keys()]) {
    if (!wanted.has(key)) removeMarker(key);
  }
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
