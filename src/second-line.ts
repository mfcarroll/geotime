// src/second-line.ts
//
// What the second line of a World Clock row says, once it is known how much
// room that line actually has.
//
// The row is two independently measured lines rather than two stacked columns,
// so this line's width is its own: the zone name competes with "Sun, +0 hrs"
// beside it, not with the much wider clock above it. See the note on the
// template in index.html for why that changed.
//
// Two things are decided here, and both are decided for the WHOLE list rather
// than per row. A column where one row says "Timezone" and the next says "Zone"
// reads as a bug rather than as economy — the same reasoning the widget already
// applies to its offset, and the same reason it is the widget's rules this file
// keeps reaching for.

import { clockSubLabel, type ClockEntry, type ZoneLabelWord } from './clocks';

export interface SecondLineRow {
    el: HTMLElement;
    entry: ClockEntry;
    dayShort: string;   // "Sun"
    dayFull: string;    // "Sunday"
    timeDiff: string;   // "+3 hrs" / "Local time" / "Ship time"
}

/**
 * Text widths without touching layout.
 *
 * A canvas rather than a hidden probe element: this runs on every tick, and a
 * probe means a style-and-layout pass each time to read one number back. The
 * font string is lifted from the real element, so the two agree.
 */
const canvas = document.createElement('canvas').getContext('2d');

function widthOf(text: string, font: string): number {
    if (!canvas || !text) return 0;
    canvas.font = font;
    return canvas.measureText(text).width;
}

function fontOf(el: Element | null): string {
    if (!el) return '';
    const s = getComputedStyle(el);
    // Shorthand `font` comes back empty in some engines; build it either way.
    return s.font || `${s.fontWeight} ${s.fontSize} / ${s.lineHeight} ${s.fontFamily}`;
}

/**
 * Writes every row's second line, having chosen one wording for all of them.
 *
 * The order of the two decisions is the point, and it follows the rule the
 * widget settles every one of these with: content first, garnish second.
 *
 *   1. The LABEL yields first, because it is the only part of the line that is
 *      not information — "Timezone: Los Angeles" and "Zone: Los Angeles" name
 *      the same fact, and one of them fits where the other does not. Asked of
 *      the zone rows only: a ship's line carries no label, so a ship that
 *      cannot fit "Royal Caribbean" must not be the reason every zone row loses
 *      four characters it had room for.
 *
 *   2. The FULL DAY is then granted only into whatever slack is left. It is
 *      the nicer form and it is worth nothing next to a truncated place name,
 *      so it never gets to push the label down: the label is settled against a
 *      short day before this is asked at all. Unlike the label this is asked of
 *      every row, because "Sunday" on one row and "Sun" on the next is the
 *      ragged column the whole-list rule exists to prevent.
 */
export function fitSecondLines(rows: SecondLineRow[]): void {
    if (rows.length === 0) return;

    const firstRegion = rows[0].el.querySelector('.region');
    const firstDate = rows[0].el.querySelector('.date-diff');
    const regionFont = fontOf(firstRegion);
    const dateFont = fontOf(firstDate);

    // `gap-3` on the line's flex container. Read rather than hard-coded, so
    // changing the class does not silently change the arithmetic.
    const line = firstRegion?.parentElement;
    const gap = line ? parseFloat(getComputedStyle(line).columnGap || '12') || 12 : 12;

    interface Measured {
        row: SecondLineRow;
        available: number;
        labelled: boolean;                     // a zone row, so it carries the label
        region: Record<ZoneLabelWord, number>;
        date: { short: number; full: number };
    }

    const measured: Measured[] = rows.map((row) => {
        const regionEl = row.el.querySelector('.region');
        const available = (regionEl?.parentElement?.clientWidth ?? 0) - gap;
        const long = clockSubLabel(row.entry, 'Timezone');
        const short = clockSubLabel(row.entry, 'Zone');
        return {
            row,
            available,
            labelled: long !== short,
            region: { Timezone: widthOf(long, regionFont), Zone: widthOf(short, regionFont) },
            date: {
                short: widthOf(`${row.dayShort}, ${row.timeDiff}`, dateFont),
                full: widthOf(`${row.dayFull}, ${row.timeDiff}`, dateFont),
            },
        };
    });

    // A hair of slack: measureText and the layout engine round differently, and
    // being a third of a pixel over should not cost a word.
    const fits = (m: Measured, word: ZoneLabelWord, fullDay: boolean) =>
        m.available <= 0                       // not laid out yet; decide nothing on it
        || m.region[word] + (fullDay ? m.date.full : m.date.short) <= m.available + 0.5;

    const word: ZoneLabelWord =
        measured.every((m) => !m.labelled || fits(m, 'Timezone', false)) ? 'Timezone' : 'Zone';
    const fullDay = measured.every((m) => fits(m, word, true));

    for (const m of measured) {
        const region = m.row.el.querySelector('.region');
        const date = m.row.el.querySelector('.date-diff');
        if (region) region.textContent = clockSubLabel(m.row.entry, word);
        if (date) date.textContent = `${fullDay ? m.row.dayFull : m.row.dayShort}, ${m.row.timeDiff}`;
    }
}
