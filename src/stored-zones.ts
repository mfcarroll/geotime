// src/stored-zones.ts
//
// The saved clock list, and the repair it needs when read back.
//
// Its own module because it is pure and worth testing, and state.ts is not
// importable outside a browser — it reaches dom.ts for `document` and, further
// down, shiptrack.ts for import.meta.env. Same reason ship-position.ts and
// zone-order.ts live apart from their callers.

export interface StoredZone {
    tz: string;
    label?: string;
    /**
     * What kind of place the user picked, when it is worth showing on the row.
     *
     * Optional and additive on purpose: a build that predates it ignores the
     * field, and a build that has it treats absence as "an ordinary zone". That
     * matters because this list is the one piece of the app people would lose if
     * a release had to be rolled back.
     */
    kind?: 'port';
}

/**
 * Repairs a stored zone list written by older builds.
 *
 * Pre-rebuild the app synthesised `Etc/GMT±N.N` ids for map features that had no
 * name and a fractional offset. Those are not valid tzdb ids — `Intl` throws on
 * them — so they were carried by hand-written parsers on three platforms. They
 * are rounded to the nearest valid whole-hour zone here and the parsers dropped.
 */
export function migrateStoredTimezones(raw: unknown): StoredZone[] {
    if (!Array.isArray(raw)) return [];
    const out: StoredZone[] = [];
    for (const entry of raw) {
        // Older builds stored bare id strings; newer ones store {tz, label}.
        const source = typeof entry === 'string' ? { tz: entry } : entry;
        if (!source || typeof source.tz !== 'string' || !source.tz.trim()) continue;

        let id = source.tz;
        const fractional = id.match(/^Etc\/GMT([+-])(\d+)\.\d+$/);
        if (fractional) id = `Etc/GMT${fractional[1]}${fractional[2]}`;
        try {
            new Intl.DateTimeFormat('en-US', { timeZone: id });
        } catch {
            continue; // unrecoverable; drop rather than poison the widget
        }
        if (out.some((z) => z.tz === id)) continue;
        // Rebuilt field by field rather than spread, so a corrupt store cannot
        // smuggle anything through — which means every field has to be carried
        // deliberately. `kind` was added later and forgetting it here cost an
        // anchor that appeared when the port was added and vanished on restart.
        const zone: StoredZone = { tz: id };
        if (typeof source.label === 'string' && source.label.trim()) zone.label = source.label;
        if (source.kind === 'port') zone.kind = 'port';
        out.push(zone);
    }
    return out;
}

