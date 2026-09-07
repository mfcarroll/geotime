import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { CHART_FILL_SCALE, FILLS, HOVER_FILL_LIFT, OUTLINE, resolveZoneStyle,
         type ZoneStyleInput } from './map-highlight';

// The precedence here is fiddly and a regression in it is invisible until
// somebody hovers the right combination — which is the reason this module has
// no DOM in it.

const NEW_YORK = 'America/New_York';
const NASSAU = 'America/Nassau';      // same offset as New York
const LONDON = 'Europe/London';
const ATLANTIC = 'Etc/GMT+4';         // the sea Nassau sits in, same offset

const OFFSETS: Record<string, number> = {
    [NEW_YORK]: -4, [NASSAU]: -4, [LONDON]: 1, [ATLANTIC]: -4,
};

const style = (tzid: string, over: Partial<ZoneStyleInput> = {}) => resolveZoneStyle({
    tzid,
    offset: OFFSETS[tzid],
    selectedTzid: null,
    selectedOffset: null,
    gpsTzid: null,
    hoveredTzid: null,
    anchorShipOffset: null,
    offsetOf: (id) => OFFSETS[id],
    ...over,
});

describe('the chart wash', () => {
    it('quiets every band while a cruise is drawn over it', () => {
        const plain = style(NASSAU, { selectedTzid: NEW_YORK, selectedOffset: -4 });
        const washed = style(NASSAU, { selectedTzid: NEW_YORK, selectedOffset: -4, chartShown: true });

        assert.equal(plain.fillOpacity, FILLS.selectedBand.fillOpacity);
        assert.equal(washed.fillOpacity, FILLS.selectedBand.fillOpacity * CHART_FILL_SCALE);
        assert.equal(washed.fillColor, plain.fillColor, 'the same band, only quieter');
    });

    it('quiets the picked zone itself, which is the loudest thing on the map', () => {
        const washed = style(NEW_YORK, { selectedTzid: NEW_YORK, selectedOffset: -4, chartShown: true });
        assert.equal(washed.fillOpacity, FILLS.selectedSegment.fillOpacity * CHART_FILL_SCALE);
    });

    it('leaves a zone that was already transparent alone', () => {
        const washed = style(LONDON, { selectedTzid: NEW_YORK, selectedOffset: -4, chartShown: true });
        assert.equal(washed.fillOpacity, 0);
    });

    it('does not repaint the sea a ship is sailing on', () => {
        // Zoomed in on a chart, one nautical band is most of the screen, and
        // painting it flashes the whole view for a pointer that never left the
        // water. The outline still says which band it is.
        const plain = style(ATLANTIC, { selectedOffset: -4, chartShown: true });
        const hovered = style(ATLANTIC, {
            selectedOffset: -4, hoveredTzid: ATLANTIC, chartShown: true,
        });
        assert.equal(hovered.fillOpacity, plain.fillOpacity, 'no fill change at all');
        assert.equal(hovered.strokeColor, OUTLINE.hover.strokeColor, 'and the outline carries it');
    });

    it('does not repaint water OUTSIDE the selected band either', () => {
        // The case the first attempt missed, and the one actually being seen.
        // Two fills answer a hover, not one: the lift on the hovered zone, and
        // the BAND painted across everything sharing its offset — which
        // includes the hovered zone. Pointing at the Gulf of Mexico while a
        // Caribbean cruise was up took the sea from nothing to white, a bigger
        // jump than the lift that had just been removed to prevent it.
        const GULF = 'Etc/GMT+6';
        const offsets = { ...OFFSETS, [GULF]: -6 };
        const gulf = (hoveredTzid: string | null) => resolveZoneStyle({
            tzid: GULF, offset: -6, selectedTzid: null, selectedOffset: -4,
            gpsTzid: null, hoveredTzid, anchorShipOffset: null,
            offsetOf: (id) => offsets[id as keyof typeof offsets], chartShown: true,
        });
        assert.equal(gulf(null).fillOpacity, 0);
        assert.equal(gulf(GULF).fillOpacity, 0, 'and still nothing when pointed at');
        assert.equal(gulf(GULF).strokeColor, OUTLINE.hover.strokeColor);
    });

    it('gives land outside the band half a band, not none', () => {
        const GULF = 'Etc/GMT+6';
        const MEXICO = 'America/Mexico_City';
        const offsets = { ...OFFSETS, [GULF]: -6, [MEXICO]: -6 };
        const mexico = (hoveredTzid: string | null) => resolveZoneStyle({
            tzid: MEXICO, offset: -6, selectedTzid: null, selectedOffset: -4,
            gpsTzid: null, hoveredTzid, anchorShipOffset: null,
            offsetOf: (id) => offsets[id as keyof typeof offsets], chartShown: true,
        });
        assert.equal(mexico(null).fillOpacity, 0);
        assert.equal(mexico(GULF).fillOpacity, FILLS.hoverBand.fillOpacity / 2 * CHART_FILL_SCALE);
    });

    it('gives land half a lift under a chart, and all of it without one', () => {
        // A country at chart zoom is a shape you can see change without the
        // change taking over.
        const lift = (over: Partial<ZoneStyleInput>) =>
            style(NASSAU, { selectedOffset: -4, hoveredTzid: NASSAU, ...over }).fillOpacity
            - style(NASSAU, { selectedOffset: -4, ...over }).fillOpacity;

        assert.ok(Math.abs(lift({ chartShown: true }) - HOVER_FILL_LIFT / 2) < 1e-9);
        assert.ok(Math.abs(lift({}) - HOVER_FILL_LIFT) < 1e-9);
    });

    it('lifts an ocean band normally when no chart is drawn', () => {
        const lift = style(ATLANTIC, { selectedOffset: -4, hoveredTzid: ATLANTIC }).fillOpacity
            - style(ATLANTIC, { selectedOffset: -4 }).fillOpacity;
        assert.ok(Math.abs(lift - HOVER_FILL_LIFT) < 1e-9);
    });

    it('still answers a pointer while the map is quiet', () => {
        // A proportional dimming of the hover lift would have made it invisible
        // in exactly the state where everything else is faintest.
        const washed = style(NASSAU, {
            selectedTzid: NEW_YORK, selectedOffset: -4, hoveredTzid: NASSAU, chartShown: true,
        });
        assert.equal(washed.strokeColor, OUTLINE.hover.strokeColor);
        assert.ok(washed.fillOpacity > FILLS.selectedBand.fillOpacity * CHART_FILL_SCALE,
            'lifted above its own washed band');
        assert.ok(washed.zIndex > FILLS.selectedBand.zIndex, 'and above its neighbours');
    });

    it('changes nothing when no chart is drawn', () => {
        const a = style(NASSAU, { selectedTzid: NEW_YORK, selectedOffset: -4 });
        const b = style(NASSAU, { selectedTzid: NEW_YORK, selectedOffset: -4, chartShown: false });
        assert.deepEqual(a, b);
    });
});

describe('hover, carried by the outline', () => {
    it('answers a pointer without repainting the zone', () => {
        // The trade this whole set of numbers rests on: while hover was a jump
        // in fill, every level had to sit far enough below the next for the jump
        // to be seen — so the standing state was as heavy as the hovered one
        // needed it to be, and the map underneath paid for it.
        const plain = style(NASSAU, { selectedOffset: -4 });
        const hovered = style(NASSAU, { selectedOffset: -4, hoveredTzid: NASSAU });

        assert.equal(hovered.strokeColor, OUTLINE.hover.strokeColor);
        assert.notEqual(hovered.strokeColor, plain.strokeColor, 'the outline does the work');
        // In brightness, not in thickness: a heavier line draws the eye to the
        // boundary rather than to the region, and shifts it while it is at it.
        assert.equal(hovered.strokeWeight, plain.strokeWeight);
        assert.ok(hovered.fillOpacity - plain.fillOpacity <= 0.07, 'and the fill barely moves');
    });

    it('keeps a little fill lift for a zone whose outline you cannot see', () => {
        // Behind a card, or running off the edge of the map.
        const plain = style(NASSAU, { selectedOffset: -4 });
        const hovered = style(NASSAU, { selectedOffset: -4, hoveredTzid: NASSAU });
        assert.equal(hovered.fillOpacity, plain.fillOpacity + HOVER_FILL_LIFT);
    });

    it('lifts the hovered zone above its own band', () => {
        // Or an adjacent zone in the same band paints over the outline.
        const plain = style(NASSAU, { selectedOffset: -4 });
        const hovered = style(NASSAU, { selectedOffset: -4, hoveredTzid: NASSAU });
        assert.ok(hovered.zIndex > plain.zIndex);
    });
});

describe('the fills a reader can see through', () => {
    it('keeps the picked zone readable underneath', () => {
        // At 0.8 the coastline, the place names and the sea all went: the zone
        // you picked was the one part of the map you could no longer read.
        assert.ok(FILLS.selectedSegment.fillOpacity <= 0.35);
        assert.ok(FILLS.gpsSegment.fillOpacity <= 0.4);
    });

    it('leaves a band a ship is standing in visible under a chart', () => {
        // A selected ship lights no segment — nothing on land is the ship — so
        // her band is the only gold on the map, and at 0.08 it was not there.
        assert.ok(FILLS.selectedBand.fillOpacity * CHART_FILL_SCALE >= 0.12);
    });

    it('keeps a band lighter than the segment inside it', () => {
        assert.ok(FILLS.selectedBand.fillOpacity < FILLS.selectedSegment.fillOpacity);
        assert.ok(FILLS.gpsBand.fillOpacity < FILLS.gpsSegment.fillOpacity);
    });
});
