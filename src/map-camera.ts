// src/map-camera.ts
//
// Where the camera should end up, and the path it takes to get there.
//
// Two pure pieces, both free of the Maps API so they can be tested without one:
// the Mercator arithmetic that turns a bounding box into a camera, and the
// interpolation that carries one camera to another.
//
// The interpolation is van Wijk and Nuij's, from "Smooth and Efficient Zooming
// and Panning" (2003) — the same one behind Mapbox's and Leaflet's flyTo. Its
// point is that a straight tween between two cameras is wrong in a specific and
// very visible way: hold the zoom and cross an ocean, and the ground beneath
// tears past at a speed the eye cannot track, so the movement reads as a
// flicker rather than a journey. The paper's answer is to treat the camera's
// height as part of the path — climb, cross, descend — with the height of the
// arc falling out of the distance rather than being chosen by hand. Near hops
// barely climb at all, which is what makes it safe to use for every movement
// instead of only the long ones.

/** A place to point the camera. Longitude is `lng`, as the Maps API has it. */
export interface Camera {
    lat: number;
    lng: number;
    zoom: number;
}

/** A bounding box, in the order LatLngBounds hands its corners over. */
export interface Box {
    south: number;
    west: number;
    north: number;
    east: number;
}

/** The map's own pixel size — what a zoom is relative to. */
export interface Viewport {
    width: number;
    height: number;
}

/** A movement, sampled by time rather than run by anyone in particular. */
export interface Flight {
    /** How long the whole move should take, in milliseconds. */
    duration: number;
    /** Where the camera is at `t` in [0, 1]. */
    at(t: number): Camera;
}

/** Google's world is 256px square at zoom 0, and every zoom doubles it. */
const WORLD = 256;

/**
 * The latitude where a square Mercator world runs out.
 *
 * Mercator sends the poles to infinity, so every implementation picks a cutoff;
 * this is the one that makes the projection square, and the one Google uses.
 */
const EDGE = 85.05112878;

export function worldX(lng: number): number {
    return (WORLD * (lng + 180)) / 360;
}

export function worldY(lat: number): number {
    const sin = Math.sin((Math.max(-EDGE, Math.min(EDGE, lat)) * Math.PI) / 180);
    return WORLD * (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI));
}

export function lngAtX(x: number): number {
    return (x / WORLD) * 360 - 180;
}

export function latAtY(y: number): number {
    return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / WORLD))) * 180) / Math.PI;
}

/** Longitude folded back into [-180, 180), which is where the API wants it. */
export function wrapLng(lng: number): number {
    // Left exactly alone when it is already in range. Folding unconditionally
    // costs a couple of ulps, and a flight that lands on -21.939999999999998
    // instead of the -21.94 it was sent to is a flight that did not quite land.
    if (lng >= -180 && lng < 180) return lng;
    const turned = (lng + 180) % 360;
    return (turned < 0 ? turned + 360 : turned) - 180;
}

/**
 * The camera that frames a box with `padding` pixels of margin on every side.
 *
 * What fitBounds does, worked out here so the destination is known BEFORE the
 * map moves — which is what makes it possible to fly there rather than arrive
 * instantly.
 *
 * A box whose east is west of its west has crossed the antimeridian, which is
 * how LatLngBounds says so: Alaska's box runs from 172°E to 130°W, not the
 * whole world backwards.
 */
export function boxCamera(
    box: Box,
    view: Viewport,
    padding: number,
    maxZoom = 21,
): Camera | null {
    if (![box.south, box.west, box.north, box.east].every(Number.isFinite)) return null;

    // South is a LARGER y than north: the projection counts down from the pole.
    const spanY = worldY(box.south) - worldY(box.north);
    let spanX = worldX(box.east) - worldX(box.west);
    if (spanX < 0) spanX += WORLD;

    const usableW = Math.max(view.width - padding * 2, 1);
    const usableH = Math.max(view.height - padding * 2, 1);

    // A span of zero constrains nothing — a box with no height still has a width
    // to be framed by. Only when BOTH vanish does the zoom come from the cap.
    const fit = (span: number, usable: number) =>
        span > 0 ? Math.log2(usable / span) : Infinity;
    const zoom = Math.min(maxZoom, fit(spanX, usableW), fit(spanY, usableH));
    if (!Number.isFinite(zoom)) return null;

    return {
        lat: latAtY((worldY(box.north) + worldY(box.south)) / 2),
        lng: wrapLng(lngAtX(worldX(box.west) + spanX / 2)),
        zoom,
    };
}

/**
 * van Wijk's ρ: how eagerly the arc climbs.
 *
 * The paper derives 1.42 as the value that minimises the journey's perceived
 * length, and observes that the result is insensitive to getting it exactly
 * right. Larger climbs higher and travels faster; smaller stays low and slides.
 */
const RHO = 1.42;

/** Long enough to read as a movement, short enough not to be a wait. */
function durationFor(S: number): number {
    // S is van Wijk's own measure of the journey, in units of roughly one
    // screenful — so pacing on it keeps a hop across a bay brisk and a crossing
    // of the Atlantic unhurried, with neither timed by hand.
    return Math.min(1100, Math.max(260, S * 380));
}

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

/**
 * The path from one camera to another, across a viewport `width` pixels wide.
 *
 * Returns a function of time rather than moving anything, so the same path can
 * be tested, sampled, or thrown away half-run without a map being involved.
 */
export function flight(from: Camera, to: Camera, width: number): Flight {
    const landed: Camera = { lat: to.lat, lng: wrapLng(to.lng), zoom: to.zoom };

    const x0 = worldX(from.lng);
    const y0 = worldY(from.lat);
    let x1 = worldX(wrapLng(to.lng));
    const y1 = worldY(to.lat);

    // The short way round. Vancouver to Tokyo crosses the dateline, and without
    // this the camera would take the scenic route back over America and Europe.
    if (x1 - x0 > WORLD / 2) x1 -= WORLD;
    else if (x0 - x1 > WORLD / 2) x1 += WORLD;

    // The viewport's width in world units is what "how high the camera is"
    // means here: half the zoom, twice the width.
    const w0 = width / 2 ** from.zoom;
    const w1 = width / 2 ** to.zoom;
    const u1 = Math.hypot(x1 - x0, y1 - y0);

    const camera = (x: number, y: number, w: number): Camera => ({
        lat: latAtY(y),
        lng: wrapLng(lngAtX(x)),
        zoom: Math.log2(width / w),
    });

    const arrive = (path: Flight): Flight => ({
        duration: path.duration,
        // Exactly the camera that was asked for, rather than the one floating
        // point arrives at after a few hundred samples of hyperbolic functions.
        at: (t) => (t >= 1 ? { ...landed } : path.at(t)),
    });

    if (!(width > 0) || ![w0, w1, u1].every(Number.isFinite)) {
        return { duration: 0, at: () => ({ ...landed }) };
    }

    // Same place, different height. The general solution divides by the distance
    // travelled, so a straight climb is its own case rather than a limit of it.
    if (u1 < 1e-9) {
        const climb = Math.log(w1 / w0);
        return arrive({
            duration: durationFor(Math.abs(climb) / RHO),
            at: (t) => camera(x0, y0, w0 * Math.exp(climb * clamp01(t))),
        });
    }

    const rho2 = RHO * RHO;
    // b(i) and r(i) as the paper has them, at each end of the journey.
    const r = (i: 0 | 1): number => {
        const w = i === 0 ? w0 : w1;
        const sign = i === 0 ? 1 : -1;
        const b = (w1 * w1 - w0 * w0 + sign * rho2 * rho2 * u1 * u1) / (2 * w * rho2 * u1);
        return Math.log(-b + Math.sqrt(b * b + 1));
    };
    const r0 = r(0);
    const S = (r(1) - r0) / RHO;

    // Geometry too extreme to have a path — deliver the destination rather than
    // a screen full of NaN.
    if (!Number.isFinite(S) || S <= 0) return { duration: 0, at: () => ({ ...landed }) };

    const coshR0 = Math.cosh(r0);
    const sinhR0 = Math.sinh(r0);

    return arrive({
        duration: durationFor(S),
        at: (t) => {
            const s = clamp01(t) * S;
            const arg = RHO * s + r0;
            // How high the camera is, and how far along it has come.
            const w = (w0 * coshR0) / Math.cosh(arg);
            const u = (w0 * (coshR0 * Math.tanh(arg) - sinhR0)) / rho2;
            const p = u / u1;
            return camera(x0 + (x1 - x0) * p, y0 + (y1 - y0) * p, w);
        },
    });
}
