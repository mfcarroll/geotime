// src/map-fly.ts
//
// Moving the map, rather than teleporting it.
//
// Every framing in the app used to be a setCenter or a fitBounds, which put the
// camera where it belonged one frame later with nothing in between. That is
// fine when you asked for the place you are looking at and wrong when you did
// not: the map after the jump is a different map, and working out that it is
// the same one somewhere else costs a beat every time.
//
// The path itself lives in map-camera, free of the API and under test. What is
// here is the part that needs a real map: reading where the camera is, running
// the clock, and knowing when to get out of the way.

import { boxCamera, flight, type Box, type Camera } from './map-camera';

/** The one movement in progress, if any. There is only ever one map moving. */
let active: { frame: number; release: () => void } | null = null;

/** Stops whatever the camera was doing, wherever it had got to. */
export function cancelFlight(): void {
    if (!active) return;
    cancelAnimationFrame(active.frame);
    active.release();
    active = null;
}

/**
 * Someone who does not want to be moved.
 *
 * Not everyone wants animation, and for some people it is not a preference but
 * a symptom. Asked to keep still, we keep still: the camera arrives, which was
 * the point of the movement anyway.
 */
function reducedMotion(): boolean {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function currentCamera(map: google.maps.Map): Camera | null {
    const centre = map.getCenter();
    const zoom = map.getZoom();
    if (!centre || zoom === undefined) return null;
    return { lat: centre.lat(), lng: centre.lng(), zoom };
}

function place(map: google.maps.Map, at: Camera): void {
    const centre = { lat: at.lat, lng: at.lng };
    // One camera update rather than two. setCenter and setZoom each settle the
    // camera separately, which on a vector map is a visible pair of steps at
    // sixty of them a second.
    const move = (map as { moveCamera?: (c: google.maps.CameraOptions) => void }).moveCamera;
    if (typeof move === 'function') {
        move.call(map, { center: centre, zoom: at.zoom });
        return;
    }
    map.setCenter(centre);
    map.setZoom(at.zoom);
}

/** Slow off the mark and slow into the stop; van Wijk's own pacing between. */
const ease = (t: number) => t * t * (3 - 2 * t);

/**
 * Carries the map to `to`, or puts it there directly when flying is no use.
 *
 * A new flight cancels the one before it: the last thing asked for is the thing
 * wanted, and two animations sharing one camera would fight over every frame.
 * So does a drag — a hand on the map outranks anything the app was in the
 * middle of saying.
 */
export function flyTo(map: google.maps.Map, to: Camera): void {
    cancelFlight();

    const from = currentCamera(map);
    const width = map.getDiv()?.clientWidth ?? 0;
    if (!from || width <= 0 || reducedMotion()) {
        place(map, to);
        return;
    }

    const path = flight(from, to, width);
    if (path.duration <= 0) {
        place(map, to);
        return;
    }

    const grabbed = map.addListener('dragstart', () => cancelFlight());
    const release = () => google.maps.event.removeListener(grabbed);

    const start = performance.now();
    const step = (now: number) => {
        const t = Math.min(1, (now - start) / path.duration);
        place(map, path.at(ease(t)));
        if (t < 1 && active) {
            active.frame = requestAnimationFrame(step);
            return;
        }
        release();
        active = null;
    };
    active = { frame: requestAnimationFrame(step), release };
}

/**
 * Carries the map to a box, framed the way fitBounds would have framed it.
 *
 * Falls back to fitBounds itself where the box cannot be turned into a camera —
 * a map with no size yet, or a degenerate box — so the framing still happens
 * even when the flying cannot.
 */
export function flyToBox(
    map: google.maps.Map,
    bounds: google.maps.LatLngBounds,
    padding: number,
): void {
    const div = map.getDiv();
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const box: Box = {
        south: sw.lat(),
        west: sw.lng(),
        north: ne.lat(),
        east: ne.lng(),
    };
    const view = { width: div?.clientWidth ?? 0, height: div?.clientHeight ?? 0 };
    const to = view.width > 0 && view.height > 0 ? boxCamera(box, view, padding) : null;

    if (!to) {
        cancelFlight();
        map.fitBounds(bounds, padding);
        return;
    }
    flyTo(map, to);
}
