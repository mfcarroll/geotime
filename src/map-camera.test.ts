import test from 'node:test';
import assert from 'node:assert/strict';

import {
    boxCamera,
    flight,
    latAtY,
    worldY,
    wrapLng,
    type Camera,
} from './map-camera';

/** A phone held upright, which is where most of this is looked at. */
const PHONE = { width: 390, height: 320 };

const COCO_CAY = { lat: 25.82, lng: -77.94 };
const TAMPA = { lat: 27.95, lng: -82.46 };
const VANCOUVER = { lat: 49.28, lng: -123.12 };
const REYKJAVIK = { lat: 64.15, lng: -21.94 };
const TOKYO = { lat: 35.68, lng: 139.7 };

/** The samples a flight is actually made of, endpoints included. */
function samples(path: { at(t: number): Camera }, n = 41): Camera[] {
    return Array.from({ length: n }, (_, i) => path.at(i / (n - 1)));
}

test('mercator', async (t) => {
    await t.test('latitude survives the round trip', () => {
        for (const lat of [-84, -45, -1, 0, 1, 45, 51.5, 84]) {
            assert.ok(Math.abs(latAtY(worldY(lat)) - lat) < 1e-9, `${lat}`);
        }
    });

    await t.test('the poles are clamped rather than sent to infinity', () => {
        assert.ok(Number.isFinite(worldY(90)));
        assert.ok(Number.isFinite(worldY(-90)));
    });

    await t.test('longitude folds back into the range the API wants', () => {
        assert.equal(wrapLng(190), -170);
        assert.equal(wrapLng(-190), 170);
        assert.equal(wrapLng(-123.12), -123.12);
        assert.equal(wrapLng(540), -180);
    });
});

test('framing a box', async (t) => {
    const box = { south: 25.0, west: -80.5, north: 26.9, east: -77.2 };

    await t.test('the box fits inside the padding', () => {
        const cam = boxCamera(box, PHONE, 48);
        assert.ok(cam);
        const scale = 2 ** cam.zoom;
        const wide = ((box.east - box.west) / 360) * 256 * scale;
        const tall = (worldY(box.south) - worldY(box.north)) * scale;
        assert.ok(wide <= PHONE.width - 96 + 1e-6, `width ${wide}`);
        assert.ok(tall <= PHONE.height - 96 + 1e-6, `height ${tall}`);
    });

    await t.test('and fits snugly: one axis touches the padding', () => {
        const cam = boxCamera(box, PHONE, 48);
        assert.ok(cam);
        const scale = 2 ** cam.zoom;
        const wide = ((box.east - box.west) / 360) * 256 * scale;
        const tall = (worldY(box.south) - worldY(box.north)) * scale;
        const slack = Math.min(PHONE.width - 96 - wide, PHONE.height - 96 - tall);
        assert.ok(Math.abs(slack) < 1e-6, `slack ${slack}`);
    });

    await t.test('the centre is the box centre on SCREEN, not between its corners', () => {
        // Mercator stretches towards the poles, so the northern half of a box
        // from 0 to 60 north takes up more of the screen than the southern half
        // — which puts the middle of the picture north of the middle latitude.
        const cam = boxCamera({ south: 0, west: -10, north: 60, east: 10 }, PHONE, 0);
        assert.ok(cam);
        assert.ok(cam.lat > 30, `${cam.lat} should be north of the halfway latitude`);
        assert.ok(Math.abs(cam.lat - 35.264) < 0.01, `${cam.lat}`);
        assert.ok(Math.abs(cam.lng) < 1e-9);
    });

    await t.test('a box across the antimeridian is the short way round', () => {
        // How LatLngBounds reports Alaska: east of 172, west of -130.
        const cam = boxCamera({ south: 51, west: 172, north: 71, east: -130 }, PHONE, 0);
        assert.ok(cam);
        // Fifty-eight degrees wide, centred down the Aleutians — not the three
        // hundred and two degrees the other way round, centred on the Atlantic.
        assert.ok(Math.abs(cam.lng - -159) < 1e-9, `centred at ${cam.lng}`);
        const degreesWide = (PHONE.width / 2 ** cam.zoom / 256) * 360;
        assert.ok(Math.abs(degreesWide - 58) < 1e-6, `${degreesWide} degrees across`);
    });

    await t.test('a box with no size at all has no camera to give', () => {
        const cam = boxCamera({ south: 10, west: 10, north: 10, east: 10 }, PHONE, 0, Infinity);
        assert.equal(cam, null);
    });

    await t.test('nonsense in, nothing out', () => {
        assert.equal(boxCamera({ south: NaN, west: 0, north: 1, east: 1 }, PHONE, 0), null);
    });
});

test('flying', async (t) => {
    await t.test('leaves from where it is and lands exactly where it was sent', () => {
        const from = { ...VANCOUVER, zoom: 4 };
        const to = { ...REYKJAVIK, zoom: 7 };
        const path = flight(from, to, PHONE.width);

        const start = path.at(0);
        assert.ok(Math.abs(start.lat - from.lat) < 1e-6);
        assert.ok(Math.abs(start.lng - from.lng) < 1e-6);
        assert.ok(Math.abs(start.zoom - from.zoom) < 1e-6);

        assert.deepEqual(path.at(1), to);
    });

    await t.test('a long crossing climbs, so the ground never blurs past', () => {
        const path = flight({ ...VANCOUVER, zoom: 6 }, { ...REYKJAVIK, zoom: 6 }, PHONE.width);
        const highest = Math.min(...samples(path).map((c) => c.zoom));
        assert.ok(highest < 4, `only reached zoom ${highest}; expected a real climb`);
    });

    await t.test('a hop across a bay barely climbs at all', () => {
        const path = flight({ ...COCO_CAY, zoom: 6 }, { ...TAMPA, zoom: 6 }, PHONE.width);
        const highest = Math.min(...samples(path).map((c) => c.zoom));
        assert.ok(highest > 5, `climbed to zoom ${highest}; expected to stay low`);
    });

    await t.test('the climb comes back down: no sample outruns the descent', () => {
        const path = flight({ ...VANCOUVER, zoom: 6 }, { ...REYKJAVIK, zoom: 6 }, PHONE.width);
        const zooms = samples(path).map((c) => c.zoom);
        const bottom = zooms.indexOf(Math.min(...zooms));
        assert.ok(bottom > 0 && bottom < zooms.length - 1, 'the arc peaks in the middle');
        // Down then up, once each.
        for (let i = 1; i <= bottom; i++) assert.ok(zooms[i] <= zooms[i - 1] + 1e-9);
        for (let i = bottom + 1; i < zooms.length; i++) assert.ok(zooms[i] >= zooms[i - 1] - 1e-9);
    });

    await t.test('crossing the dateline goes the short way, not over Europe', () => {
        const path = flight({ ...TOKYO, zoom: 5 }, { ...VANCOUVER, zoom: 5 }, PHONE.width);
        for (const c of samples(path)) {
            // The long way round passes Greenwich. The short way never comes
            // within ninety degrees of it.
            assert.ok(Math.abs(c.lng) > 90, `passed through ${c.lng}`);
        }
    });

    await t.test('every sample is a real place', () => {
        const path = flight({ ...TOKYO, zoom: 3 }, { ...REYKJAVIK, zoom: 11 }, PHONE.width);
        for (const c of samples(path, 201)) {
            assert.ok(Number.isFinite(c.lat) && Math.abs(c.lat) <= 90, `lat ${c.lat}`);
            assert.ok(Number.isFinite(c.lng) && Math.abs(c.lng) <= 180, `lng ${c.lng}`);
            assert.ok(Number.isFinite(c.zoom) && c.zoom > 0, `zoom ${c.zoom}`);
        }
    });

    await t.test('standing still and only changing height still works', () => {
        const path = flight({ ...TAMPA, zoom: 3 }, { ...TAMPA, zoom: 9 }, PHONE.width);
        const seen = samples(path);
        for (const c of seen) {
            assert.ok(Math.abs(c.lat - TAMPA.lat) < 1e-6);
            assert.ok(Math.abs(c.lng - TAMPA.lng) < 1e-6);
            assert.ok(Number.isFinite(c.zoom));
        }
        // Monotonic: a climb with nowhere to go does not arc.
        const zooms = seen.map((c) => c.zoom);
        for (let i = 1; i < zooms.length; i++) assert.ok(zooms[i] >= zooms[i - 1] - 1e-9);
    });

    await t.test('going nowhere at all is over immediately', () => {
        const path = flight({ ...TAMPA, zoom: 6 }, { ...TAMPA, zoom: 6 }, PHONE.width);
        assert.ok(path.duration <= 260);
        assert.deepEqual(path.at(1), { ...TAMPA, zoom: 6 });
    });

    await t.test('a map with no width yet is a jump, not a flight', () => {
        const path = flight({ ...TAMPA, zoom: 6 }, { ...VANCOUVER, zoom: 6 }, 0);
        assert.equal(path.duration, 0);
        assert.deepEqual(path.at(0), { ...VANCOUVER, zoom: 6 });
    });

    await t.test('further takes longer, within bounds', () => {
        const near = flight({ ...COCO_CAY, zoom: 6 }, { ...TAMPA, zoom: 6 }, PHONE.width);
        const far = flight({ ...VANCOUVER, zoom: 6 }, { ...TOKYO, zoom: 6 }, PHONE.width);
        assert.ok(near.duration < far.duration);
        for (const d of [near.duration, far.duration]) {
            assert.ok(d >= 260 && d <= 1100, `${d}ms`);
        }
    });

    await t.test('time outside the journey is pinned to its ends', () => {
        const path = flight({ ...COCO_CAY, zoom: 6 }, { ...TAMPA, zoom: 8 }, PHONE.width);
        assert.deepEqual(path.at(-1), path.at(0));
        assert.deepEqual(path.at(2), path.at(1));
    });
});
