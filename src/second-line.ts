// src/second-line.ts
//
// What the second line of a World Clock row says, once it is known how much
// room that line actually has.
//
// The row is two columns — name over zone on the left, clock over offset on the
// right — and this line's width is the one thing that shape gets wrong. The left
// column is sized against the CLOCK, which is text-xl mono and far wider than
// "Sun, +0 hrs" underneath it, so the zone name was ellipsised with forty-odd
// points of empty space to the right of the offset.
//
// It is set here instead, from what is actually beside the line: the offset when
// the name is one line, and nothing at all once a wrapped name has carried the
// offset up past it. See the note on the template in index.html.
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

export function widthOf(text: string, font: string): number {
    if (!canvas || !text) return 0;
    canvas.font = font;
    return canvas.measureText(text).width;
}

export function fontOf(el: Element | null): string {
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
 *      not information — "Timezone: Los Angeles", "Zone: …" and "TZ: …" name the
 *      same fact, and one of them fits where another does not. Asked of the zone
 *      rows only: a ship's line carries no label, so a ship that cannot fit
 *      "Royal Caribbean" must not be the reason every zone row loses a word it
 *      had room for.
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

    // `gap-3` between the row's two columns — read off the ROW, which is the flex
    // container that carries it, rather than hard-coded. The left column is not
    // a flex container and has no gap of its own to read.
    const gap = parseFloat(getComputedStyle(rows[0].el).columnGap || '') || 12;

    interface Measured {
        row: SecondLineRow;
        region: HTMLElement | null;
        /**
         * Full width of the row's content box — what this line gets when the
         * name wrapped past the offset and nothing is beside it.
         */
        rowWidth: number;
        /** True when the offset still sits on this line and must be paid for. */
        crowded: boolean;
        labelled: boolean;                     // a zone row, so it carries the label
        text: Record<ZoneLabelWord, string>;
        region_: Record<ZoneLabelWord, number>;
        date: { short: number; full: number };
    }

    const measured: Measured[] = rows.map((row) => {
        const regionEl = row.el.querySelector<HTMLElement>('.region');
        const dateEl = row.el.querySelector<HTMLElement>('.date-diff');
        const column = regionEl?.parentElement;

        // Does the offset still sit beside this line, or has the name wrapped
        // past it? Asked of the geometry rather than inferred from line heights,
        // which would go quietly wrong the first time a font size changed.
        // Compared in the row's own coordinates, since the two live in different
        // columns.
        const rowTop = row.el.getBoundingClientRect().top;
        const regionTop = regionEl ? regionEl.getBoundingClientRect().top - rowTop : 0;
        const dateBottom = dateEl ? dateEl.getBoundingClientRect().bottom - rowTop : 0;
        const crowded = regionTop < dateBottom - 0.5;

        // The content box the whole row has: the left column plus the right one
        // plus the gap between them. Padding is already excluded by clientWidth,
        // so the space reserved for the remove button is too.
        const rightWidth = (column?.nextElementSibling as HTMLElement | null)?.offsetWidth ?? 0;
        const rowWidth = (column?.clientWidth ?? 0) + (rightWidth ? rightWidth + gap : 0);

        const text = {
            Timezone: clockSubLabel(row.entry, 'Timezone'),
            Zone: clockSubLabel(row.entry, 'Zone'),
            TZ: clockSubLabel(row.entry, 'TZ'),
        };
        return {
            row,
            region: regionEl,
            rowWidth,
            crowded,
            labelled: text.Timezone !== text.Zone,
            text,
            region_: {
                Timezone: widthOf(text.Timezone, regionFont),
                Zone: widthOf(text.Zone, regionFont),
                TZ: widthOf(text.TZ, regionFont),
            },
            date: {
                short: widthOf(`${row.dayShort}, ${row.timeDiff}`, dateFont),
                full: widthOf(`${row.dayFull}, ${row.timeDiff}`, dateFont),
            },
        };
    });

    /** What this line has to itself, once the offset beside it is paid for. */
    const room = (m: Measured, fullDay: boolean) =>
        m.crowded ? m.rowWidth - gap - (fullDay ? m.date.full : m.date.short) : m.rowWidth;

    // A hair of slack: measureText and the layout engine round differently, and
    // being a third of a pixel over should not cost a word.
    const fits = (m: Measured, word: ZoneLabelWord, fullDay: boolean) =>
        m.rowWidth <= 0                        // not laid out yet; decide nothing on it
        || m.region_[word] <= room(m, fullDay) + 0.5;

    // Timezone, then Zone, then TZ. Each rung is the same fact in less room, and
    // the last is an abbreviation rather than a word — which is why it is last
    // and why the list only reaches it when a name really has nowhere to go.
    const order: ZoneLabelWord[] = ['Timezone', 'Zone', 'TZ'];
    const word = order.find((w) =>
        measured.every((m) => !m.labelled || fits(m, w, false))) ?? 'TZ';
    const fullDay = measured.every((m) => fits(m, word, true));

    for (const m of measured) {
        const date = m.row.el.querySelector('.date-diff');
        if (date) date.textContent = `${fullDay ? m.row.dayFull : m.row.dayShort}, ${m.row.timeDiff}`;
        if (!m.region) continue;
        m.region.textContent = m.text[word];
        // The width CSS could not work out: the left column is sized against the
        // clock, and this line is only ever bounded by the offset — or by
        // nothing, once the name has wrapped past it.
        m.region.style.width = m.rowWidth > 0 ? `${Math.floor(room(m, fullDay))}px` : '';
    }
}
