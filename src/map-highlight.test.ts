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

const OFFSETS: Record<string, number> = {
    [NEW_YORK]: -4, [NASSAU]: -4, [LONDON]: 1,
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

    it('still answers a pointer while the map is quiet', () => {
        // A proportional dimming of the hover lift would have made it invisible
        // in exactly the state where everything else is faintest.
        const washed = style(NASSAU, {
            selectedTzid: NEW_YORK, selectedOffset: -4, hoveredTzid: NASSAU, chartShown: true,
        });
        assert.equal(washed.strokeColor, '#FFFFFF');
        assert.ok(washed.fillOpacity > FILLS.selectedBand.fillOpacity * CHART_FILL_SCALE,
            'lifted above its own washed band');
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
        assert.ok(hovered.strokeWeight > plain.strokeWeight, 'the outline does the work');
        assert.ok(hovered.fillOpacity - plain.fillOpacity <= 0.05, 'and the fill barely moves');
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
