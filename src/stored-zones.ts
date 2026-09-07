// src/stored-zones.ts
//
// The saved clock list, and the repair it needs when read back.
//
// A LIST OF PLACES, NOT A SET OF ZONES. Tampa is a city in the New York
// timezone; it is not a name for the New York timezone. For a long time the app
// could not tell those apart — one label per zone, so adding Tampa renamed
// America/New_York everywhere it appeared, and adding New York afterwards
// silently overwrote Tampa. Tapping a port on the map did the same thing to
// whatever zone it stood in.
//
// So identity here is the PLACE. Two entries may share a zone and each keeps
// its own name, its own anchor and its own coordinates. The stored format did
// not have to change to allow it — it was already a list of records, and only
// the load path was collapsing it.
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
    /**
     * "BC", and "Canada", for a place that came from the city index.
     *
     * Stored rather than looked up because the index is a 1.8 MB asset fetched
     * on first search, and a row has to be able to say what it is at launch —
     * on the widget too, which has no index to consult at all.
     *
     * Kept apart for the same reason cities.ts keeps them apart: the row says
     * "Vancouver, BC" and only needs to be told from the timezone, while the
     * dropdown says "Vancouver, BC, Canada" and is telling five Vancouvers
     * apart. Additive like the rest — a row without them is simply a row whose
     * region nobody recorded.
     */
    region?: string;
    country?: string;
    /**
     * Where the place actually is, for a port.
     *
     * A zone id names a region; a port is a point inside one, and the map has
     * to be able to draw it without an itinerary loaded to look it up in.
     * Saved with the row so a port the user kept is on the map at launch,
     * before any ship has been selected — or ever again, if the cruise it came
     * from has sailed and been replaced.
     *
     * Additive like `kind`: an older build ignores it, and a row without it is
     * a zone rather than a place.
     */
    at?: { lat: number; lon: number };
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
        // Deduped by PLACE rather than by zone, so Tampa and New York can both
        // be kept while adding Tampa twice cannot.
        // Rebuilt field by field rather than spread, so a corrupt store cannot
        // smuggle anything through — which means every field has to be carried
        // deliberately. `kind` was added later and forgetting it here cost an
        // anchor that appeared when the port was added and vanished on restart.
        const zone: StoredZone = { tz: id };
        const at = source.at;
        if (at && Number.isFinite(Number(at.lat)) && Number.isFinite(Number(at.lon))) {
            zone.at = { lat: Number(at.lat), lon: Number(at.lon) };
        }
        // A row names a place if and only if it knows where that place is, and
        // the row it cannot name is the zone it stands in.
        //
        // Builds before 1.7.0 had nowhere to record a berth, so they saved the
        // NAME alone: a row that said "Coco Cay" and behaved like the whole of
        // America/Nassau, because a place with no point can only be answered
        // with a region. Dropping the name here is what makes the two agree —
        // the row reads "Nassau", selects Nassau, and is Nassau. Every path
        // that writes a label writes a position with it, so nothing current can
        // arrive in this state and no repair has to exist for one that did.
        if (typeof source.label === 'string' && source.label.trim() && zone.at) {
            zone.label = source.label;
        }
        // An anchor belongs to a port, and a port is a place. A zone cannot
        // carry one, or a demoted row would keep an anchor and claim to be
        // somewhere a ship calls.
        if (zone.label && source.kind === 'port') zone.kind = 'port';
        // And nor can a zone stand in a region: America/Vancouver is not in
        // British Columbia, it CONTAINS British Columbia.
        if (zone.label) {
            if (typeof source.region === 'string' && source.region.trim()) {
                zone.region = source.region;
            }
            if (typeof source.country === 'string' && source.country.trim()) {
                zone.country = source.country;
            }
        }
        if (out.some((z) => zoneKey(z) === zoneKey(zone))) continue;
        out.push(zone);
    }
    return out;
}


/**
 * Stable identity for one saved place.
 *
 * The zone alone where the row IS the zone, and zone plus name where it is a
 * place inside one — so "America/New_York" and "America/New_York|tampa" are two
 * rows and adding Tampa twice is one. Folded, because a name differing only in
 * case or accent is the same place typed twice.
 *
 * This is also the row's `data-clock-key`, which is how updateAllClocks finds
 * the element to write a time into. Two rows sharing a key means one of them
 * silently never gets its time written, so uniqueness here is not cosmetic.
 *
 * Coordinates are deliberately NOT in it. Two ports of one name in one zone is
 * not a case anybody has, and keying on a float would make a row's identity
 * change if upstream ever nudged a berth by a metre.
 */
export function zoneKey(zone: StoredZone): string {
    const label = zone.label?.trim();
    return label ? `${zone.tz}|${foldName(label)}` : zone.tz;
}

/**
 * What a row calls this place.
 *
 * The name with just enough after it to say which thing it is: "Vancouver, BC"
 * is not the timezone of the same name, and that was the whole difficulty —
 * the two were indistinguishable on a row, so the search box used to drop one
 * of them rather than show both. The country is left for the dropdown, which
 * has five Vancouvers to separate and the width to do it in.
 *
 * The country stands in where there is no region, which is how the 49 places
 * whose country IS their region read: "Oranjestad, Aruba".
 *
 * Null where the row IS a zone, rather than a name for one. A zone is not in a
 * region, and what it should be CALLED is a question for whoever knows how to
 * pretty-print an IANA id — which this module deliberately does not, being the
 * one thing the saved list is read through and free of everything else. Getting
 * that wrong is how a row briefly announced itself as "America/Vancouver".
 */
export function placeLabel(zone: StoredZone): string | null {
    const name = zone.label?.trim();
    if (!name) return null;
    const where = zone.region?.trim() || zone.country?.trim();
    return where ? `${name}, ${where}` : name;
}

/**
 * Lowercased and stripped of accents.
 *
 * A copy of utils.fold rather than an import: this module is the one thing the
 * saved list is read through, and it stays free of everything else for the same
 * reason it is testable — see the note at the top of migrateStoredTimezones.
 */
function foldName(text: string): string {
    return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
