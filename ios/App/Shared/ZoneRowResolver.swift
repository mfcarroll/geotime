import Foundation

extension WidgetRow {
    /// Identity for one saved row: its zone, and the name the user gave it.
    ///
    /// Mirrors `zoneKey()` in the app's stored-zones.ts and `placeKey()` in the
    /// Android provider, and has to keep mirroring them — the three are what
    /// decide whether Tampa and New York are one row or two, on three surfaces
    /// that must agree. Folded, because a name differing only in case or accent
    /// is the same place typed twice.
    static func placeKey(_ tzId: String, _ label: String?) -> String {
        guard let label, !label.trimmingCharacters(in: .whitespaces).isEmpty else { return tzId }
        let folded = label
            .trimmingCharacters(in: .whitespaces)
            .folding(options: [.diacriticInsensitive, .caseInsensitive],
                     locale: Locale(identifier: "en_US_POSIX"))
        return "\(tzId)|\(folded)"
    }
}

struct WidgetRow: Identifiable {
    let id: String
    /// What the row is called. A `var` because the last thing resolve() does is
    /// qualify the names that collide — see the disambiguation pass.
    var name: String
    /// A shorter form of `name`, when one exists (ships). The view uses it only
    /// when the full name would shrink the font every row shares — see
    /// GeoTimeWidget.metrics.
    let shortName: String?
    let isLocal: Bool          // GPS-derived geographic zone (pin)
    let isDevice: Bool         // the device's OS zone, when it differs from the anchor (phone)
    let isShip: Bool           // a cruise ship's clock, set by the crew (ship mark)
    /// Somebody the user follows (person mark). Defaulted, because every row
    /// that existed before 2.0 is not one and should not have to say so.
    var isPerson: Bool = false
    /// The row every other row's `relativeText` is measured from.
    ///
    /// Ashore this is the same row as `isLocal`, which is why one flag did for
    /// both until now. Aboard they come apart: the ship becomes what you are
    /// living by while the GPS zone stays where you physically are, and both
    /// facts still want saying — the ship anchors the arithmetic, the pin still
    /// marks the ground. Conflating them would have to drop one.
    let isAnchor: Bool
    let timeDigits: String     // "3:22" / "15:22"
    let timePeriod: String     // "PM" / "" (24h)
    let weekdayShort: String?  // "Tue" — nil unless the calendar day differs from local
    let weekdayFull: String?   // "Tuesday" — used when there's room (see metrics)
    let relativeText: String   // "Local time" / "+3 hrs" — for large rich rows
    let offsetSeconds: Int
    /// True when an earlier row already shows this clock.
    ///
    /// NOT a reason to hide it. A second zone on the same offset is still a
    /// place the user asked for, and on a widget with room it should be there.
    /// It is only the first thing to give up when room runs out — ahead of a
    /// zone that shows an hour nothing else does. Defaulted so the rows that
    /// can never be duplicates (ground, phone, ship) say nothing about it.
    /// "BC" / "Canada" / "" — held back until a name collides.
    ///
    /// A widget has no width to spend on saying where a place is when nothing
    /// is asking. It is spent when two rows draw the same name at DIFFERENT
    /// hours, which is the one case a reader cannot resolve for themselves.
    var region: String = ""

    /// Mirrors Row.sharesOffset in GeoTimeWidgetProvider.java.
    var sharesOffset: Bool = false
    /// True when the row's name is one the zone could not have produced — a place
    /// the user picked, not the zone's own city. Decides which of two rows on the
    /// same offset is the one worth keeping when only one fits.
    var namesAPlace: Bool = false
    /// A port on a saved ship's itinerary, marked with an anchor when there is
    /// room for one. Purely decorative: it is the first thing the width budget
    /// gives up, ahead of every other garnish. See metrics(for:usableW:rich:).
    var isPort: Bool = false
}

// Canonical row set — dedup by zone id (local/device win), sorted by offset then
// name. Kept in sync with the Android GeoTimeWidgetProvider.buildRows. Truncation
// to fit the widget height happens in the view (GeometryReader), not here.
//
// Zones are NOT deduped by UTC offset: America/Vancouver and America/Los_Angeles
// read the same today and differ in November, and if both were added the user
// asked for both. (The device row is still offset-gated — see below — because
// that row exists to answer "is my phone showing a different time".)
enum ZoneRowResolver {
    /// The anchor as a zone, purely so day-differences can be measured against
    /// it. A fixed offset is right here: it is only ever asked what calendar day
    /// it is on, and a vessel's clock has no DST rules to lose.
    private static func anchorZone(_ seconds: Int) -> TimeZone {
        // Not `.gmt`, which needs iOS 16 and this target goes back further.
        TimeZone(secondsFromGMT: seconds) ?? TimeZone(secondsFromGMT: 0)!
    }

    /// - Parameter aboardShipKey: the ship the wifi marker says we are aboard,
    ///   or nil ashore. A key rather than a flag because the list may hold
    ///   several ships and only one of them is underfoot. Naming a ship that is
    ///   not in `ships` — an offset that never resolved — falls back to the
    ///   geographic anchor rather than anchoring on nothing.
    static func resolve(storedIds: [String], local: TimeZone, deviceTz: TimeZone, now: Date,
                        localPlaceName: String? = nil, labels: [String] = [],
                        kinds: [String] = [],
                        regions: [String] = [],
                        ships: [WidgetSharedStore.Ship] = [],
                        people: [WidgetSharedStore.Person] = [],
                        aboardShipKey: String? = nil) -> [WidgetRow] {
        let geographicOffset = local.secondsFromGMT(for: now)
        let deviceOffset = deviceTz.secondsFromGMT(for: now)

        // THE ONE THING THIS FUNCTION DECIDES: what everything is measured from.
        //
        // Ashore, the clock you live by is the ground you stand on. Aboard, it is
        // the ship — set by the crew, announced over the tannoy, and the only
        // clock a gangway time is ever quoted in. Re-basing there is not an
        // exception to this app's principle that time is geographic; it is the
        // same principle applied where the two come apart.
        let aboardShip = aboardShipKey.flatMap { key in ships.first { $0.key == key } }
        let anchorOffset = aboardShip.map { $0.offsetMinutes * 60 } ?? geographicOffset
        let anchorTz = anchorZone(anchorOffset)

        // Ship and ground are separate rows even when their clocks agree: they
        // are two different facts and each is worth its own line. The single
        // exception is the one the old fold was really for — mid-ocean the
        // ground has no name, so its row would read "UTC−5" beside a ship
        // showing the same time. There, and only there, they merge.
        let groundIsNameless = localPlaceName == nil && TimezoneDisplay.isBareOffset(local.identifier)
        let mergeGroundIntoShip = aboardShip != nil
            && anchorOffset == geographicOffset
            && groundIsNameless

        // The phone earns a row only when it agrees with neither ship nor
        // ground; otherwise it is a mark on whichever row it matches. Ashore it
        // is never marked — there, agreeing is the ordinary state and the
        // absence of a phone is exactly what says so. That falls out of the two
        // guards below rather than needing a flag of its own: the ship row only
        // exists aboard, and the ground row is only marked when it is not the
        // anchor, which is only true aboard.
        var rows: [WidgetRow] = []
        var claimedOffsets: Set<Int> = []

        if let ship = aboardShip {
            let parts = TimezoneDisplay.timeParts(anchorTz, at: now)
            rows.append(WidgetRow(
                id: "ship:\(ship.key)",
                name: ship.name,
                shortName: ship.shortOrFull,
                isLocal: mergeGroundIntoShip,
                isDevice: deviceOffset == anchorOffset,
                isShip: true,
                isAnchor: true,
                timeDigits: parts.digits,
                timePeriod: parts.period,
                weekdayShort: nil,
                weekdayFull: nil,
                relativeText: "Ship time",
                offsetSeconds: anchorOffset
            ))
        }

        let groundName = localPlaceName ?? TimezoneDisplay.displayName(local.identifier)
        if !mergeGroundIntoShip {
            let isAnchor = aboardShip == nil
            let parts = TimezoneDisplay.timeParts(local, at: now)
            let differs = !isAnchor && TimezoneDisplay.dayDiffers(local, anchorTz, at: now)
            rows.append(WidgetRow(
                // Namespaced like the ship and the phone above, and for the
                // reason the stored rows are keyed by PLACE: this is what
                // ForEach identifies a row by, and the bare zone id collided
                // with a saved row for the same zone the moment one was allowed
                // to exist. Two rows, one id, and SwiftUI drew the first of
                // them twice — the ground card's own name appearing under both
                // clocks, which is a list quietly losing a row.
                id: "ground:\(local.identifier)",
                name: groundName,
                shortName: nil,
                isLocal: true,
                isDevice: deviceOffset == geographicOffset && !isAnchor,
                isShip: false,
                isAnchor: isAnchor,
                timeDigits: parts.digits,
                timePeriod: parts.period,
                weekdayShort: differs ? TimezoneDisplay.weekday(local, at: now, full: false) : nil,
                weekdayFull: differs ? TimezoneDisplay.weekday(local, at: now, full: true) : nil,
                relativeText: isAnchor
                    ? "Local time"
                    : TimezoneDisplay.relativeOffset(zoneSeconds: geographicOffset, deviceSeconds: anchorOffset),
                offsetSeconds: geographicOffset
            ))
            claimedOffsets.insert(geographicOffset)
        }

        if deviceOffset != anchorOffset && deviceOffset != geographicOffset {
            let parts = TimezoneDisplay.timeParts(deviceTz, at: now)
            let differs = TimezoneDisplay.dayDiffers(deviceTz, anchorTz, at: now)
            rows.append(WidgetRow(
                id: "device:\(deviceTz.identifier)",
                name: TimezoneDisplay.displayName(deviceTz.identifier),
                shortName: nil,
                isLocal: false,
                isDevice: true,
                isShip: false,
                isAnchor: false,
                timeDigits: parts.digits,
                timePeriod: parts.period,
                weekdayShort: differs ? TimezoneDisplay.weekday(deviceTz, at: now, full: false) : nil,
                weekdayFull: differs ? TimezoneDisplay.weekday(deviceTz, at: now, full: true) : nil,
                relativeText: TimezoneDisplay.relativeOffset(zoneSeconds: deviceOffset, deviceSeconds: anchorOffset),
                offsetSeconds: deviceOffset
            ))
            claimedOffsets.insert(deviceOffset)
        }

        // The saved cities. A city whose clock already appears above it is kept
        // and FLAGGED, not dropped: it is still a place the user asked for, and
        // hiding it while half the widget is empty is not a saving. It becomes
        // the first thing surrendered when the rows genuinely do not fit — see
        // fit(_:maxRows:).
        //
        // Dropping them here was also what made the two-line decision wrong: the
        // view asks "does everything fit at the taller height", and everything
        // had already been quietly reduced before it asked.
        //
        // Only the ground and a standalone phone claim an offset here, and the
        // ground goes first, so where you actually are always wins: in Vancouver
        // with San Francisco saved, Vancouver leads and San Francisco is the
        // flagged one.
        let deviceShown = deviceOffset != anchorOffset && deviceOffset != geographicOffset
        // Deduped by place, which the app already does on its own side — this is
        // the widget refusing to render a store that has been left in a state
        // the app would not have written, and it is what keeps the two platforms
        // agreeing: Android has always deduped here and this never did.
        var seenPlaces = Set<String>()
        // Seeded with the rows already drawn above, each under the name it
        // actually SHOWS. One rule of place identity, where two rules used to
        // stand in for it — "skip an unnamed row for the ground zone" and "a
        // named place is exempt" were both approximations of "is this the same
        // place the ground card is already showing", and both got it wrong at
        // one end.
        //
        // Standing in Nelson: the ground row IS Nelson, so a saved Nelson is
        // the same place and goes (it used to print twice, once as "Local time"
        // and once as "+0 hrs"), while a saved America/Vancouver is the ZONE —
        // a different thing, which now keeps its row and yields only when space
        // runs out. Mid-ocean with no town to name, the ground row is the zone
        // itself, and a saved copy of it is a duplicate again. The key says all
        // of that without being told any of it.
        //
        // Only rows that were drawn: a ground folded into a ship's row, or a
        // phone whose zone earned no row, block nothing.
        if !mergeGroundIntoShip {
            seenPlaces.insert(WidgetRow.placeKey(local.identifier, localPlaceName))
        }
        if deviceShown {
            seenPlaces.insert(WidgetRow.placeKey(deviceTz.identifier, nil))
        }

        // One name at one hour is one line, however many records are behind it.
        //
        // Saving the city Vancouver and the timezone America/Vancouver makes two
        // records that are genuinely different — the app lists them as
        // "Vancouver, BC" and "Vancouver (Timezone)" — and the widget has room
        // for neither suffix, so both came out as "Vancouver" against the same
        // clock. Two identical lines, which reads as a bug because there is
        // nothing there to tell apart.
        //
        // Keyed on the OFFSET, not the zone: what a reader can tell apart is
        // the name and the time, so two rows agreeing on both are one row to
        // look at whatever their ids say. Vancouver BC and Vancouver WA are two
        // zones and, while they keep the same hour, one line — the meaning is
        // the same. When they part, in November, the offsets differ, both rows
        // stand, and the pass below is what says which is which.
        //
        // "New York City" and "New York" are never touched by this. They draw
        // differently, so there is something to see.
        var drawn = Set<String>()
        let drawnKey = { (name: String, offset: Int) in "\(name)\u{1}\(offset)" }
        if !mergeGroundIntoShip { drawn.insert(drawnKey(groundName, geographicOffset)) }
        if deviceShown {
            drawn.insert(drawnKey(TimezoneDisplay.displayName(deviceTz.identifier), deviceOffset))
        }

        for (index, id) in storedIds.enumerated() {
            let chosen = index < labels.count && !labels[index].isEmpty ? labels[index] : nil
            guard let info = TimezoneDisplay.resolveZone(id) else { continue }
            let place = WidgetRow.placeKey(info.timeZone.identifier, chosen)
            if seenPlaces.contains(place) { continue }
            let off = info.timeZone.secondsFromGMT(for: now)
            if !drawn.insert(drawnKey(chosen ?? info.displayName, off)).inserted { continue }
            seenPlaces.insert(place)
            let dup = claimedOffsets.contains(off)
            claimedOffsets.insert(off)
            let parts = TimezoneDisplay.timeParts(info.timeZone, at: now)
            let differs = TimezoneDisplay.dayDiffers(info.timeZone, anchorTz, at: now)
            rows.append(WidgetRow(
                // The PLACE, not the zone: this is what ForEach identifies rows
                // by, and two places sharing a zone with one id between them is
                // a list that drops one of them without saying so.
                id: place,
                name: chosen ?? info.displayName,
                shortName: nil,
                isLocal: false,
                isDevice: false,
                isShip: false,
                isAnchor: false,
                timeDigits: parts.digits,
                timePeriod: parts.period,
                weekdayShort: differs ? TimezoneDisplay.weekday(info.timeZone, at: now, full: false) : nil,
                weekdayFull: differs ? TimezoneDisplay.weekday(info.timeZone, at: now, full: true) : nil,
                relativeText: TimezoneDisplay.relativeOffset(zoneSeconds: off, deviceSeconds: anchorOffset),
                offsetSeconds: off,
                region: index < regions.count ? regions[index] : "",
                sharesOffset: dup,
                // A row with a NAME of its own is a place; a row without one is the
                // zone it stands in. So the place wins the clock they share, and the
                // zone is the one that yields when the widget runs out of room.

                // It used to take more than a name: the label had to differ from what
                // the zone would have called itself, on the grounds that preferring
                // "Toronto" over "Toronto" changed the winner without changing
                // anything the user could see. True while a city and its zone were one
                // row between them. They are two records now — the app lists
                // "Toronto, ON" and "Toronto (Timezone)" separately — and with the old
                // rule which of them survived a trim came down to which had been added
                // first, the same text either way. The city is the more specific
                // answer and should win every time.
                namesAPlace: chosen != nil,
                isPort: index < kinds.count && kinds[index] == "port"
            ))
        }

        // Now that every stored row exists, decide which of each offset speaks
        // for it. Done here rather than inside the loop because the answer depends
        // on rows the loop had not reached yet: a place added second can still be
        // the better name for its offset. Specials (ground, phone, ship) already
        // own their offset and are never displaced.
        let isSpecial: (WidgetRow) -> Bool = { $0.isAnchor || $0.isLocal || $0.isShip || $0.isDevice }
        var speaksFor: [Int: Int] = [:]                       // offset -> index in rows
        for (i, r) in rows.enumerated() {
            if isSpecial(r) { speaksFor[r.offsetSeconds] = i; continue }
            guard let heldIndex = speaksFor[r.offsetSeconds] else { speaksFor[r.offsetSeconds] = i; continue }
            let held = rows[heldIndex]
            if !isSpecial(held) && r.namesAPlace && !held.namesAPlace { speaksFor[r.offsetSeconds] = i }
        }
        for i in rows.indices where !isSpecial(rows[i]) {
            rows[i].sharesOffset = speaksFor[rows[i].offsetSeconds] != i
        }

        // Ships are outside the no-repeated-clocks rule in BOTH directions: a
        // vessel is not a timezone. It is a thing with a name that you are on,
        // or about to be on, and a saved city that happens to keep the same hour
        // is not another copy of it — so neither hides the other. Docked in your
        // home port, the ship and the port both show, reading the same time and
        // meaning different things.
        for ship in ships {
            if ship.key == aboardShipKey { continue }
            let offset = ship.offsetMinutes * 60
            guard let tz = ship.timeZone else { continue }
            let parts = TimezoneDisplay.timeParts(tz, at: now)
            let differs = TimezoneDisplay.dayDiffers(tz, anchorTz, at: now)
            rows.append(WidgetRow(
                id: "ship:\(ship.key)",
                name: ship.name,
                shortName: ship.shortOrFull,
                isLocal: false,
                isDevice: false,
                isShip: true,
                isAnchor: false,
                timeDigits: parts.digits,
                timePeriod: parts.period,
                weekdayShort: differs ? TimezoneDisplay.weekday(tz, at: now, full: false) : nil,
                weekdayFull: differs ? TimezoneDisplay.weekday(tz, at: now, full: true) : nil,
                relativeText: TimezoneDisplay.relativeOffset(zoneSeconds: offset, deviceSeconds: anchorOffset),
                offsetSeconds: offset
            ))
        }

        // People, outside the no-repeated-clocks rule for the reason ships are,
        // and more so. "Dad" is not a timezone: he is somebody, and a saved city
        // keeping the same hour is not another copy of him. Following your
        // father in Nelson while Nelson is also on your list is two rows that
        // mean two things, and folding them would lose the one you cannot get
        // anywhere else.
        //
        // Withheld here rather than drawn wrong: a record the app would not have
        // written — no zone and no offset — has no clock to show, and there is
        // no room on a widget row to say why.
        //
        // The age is not on the row. A person who has not opened their app for
        // days still draws, and draws their last known time, which is the same
        // bargain this widget already makes with a ship's last confirmed offset.
        // The app's list is where "· 3 days ago" fits.
        for person in people {
            guard let tz = person.timeZone else { continue }
            let offset = tz.secondsFromGMT(for: now)
            let parts = TimezoneDisplay.timeParts(tz, at: now)
            let differs = TimezoneDisplay.dayDiffers(tz, anchorTz, at: now)
            rows.append(WidgetRow(
                // The share, never the name — two people can be called Mum, and
                // a ForEach with one id between them draws one of them twice.
                id: "person:\(person.key)",
                name: person.name,
                shortName: person.short,
                isLocal: false,
                isDevice: false,
                isShip: false,
                isPerson: true,
                isAnchor: false,
                timeDigits: parts.digits,
                timePeriod: parts.period,
                weekdayShort: differs ? TimezoneDisplay.weekday(tz, at: now, full: false) : nil,
                weekdayFull: differs ? TimezoneDisplay.weekday(tz, at: now, full: true) : nil,
                relativeText: TimezoneDisplay.relativeOffset(zoneSeconds: offset, deviceSeconds: anchorOffset),
                offsetSeconds: offset
            ))
        }

        // Two rows still sharing a name are two DIFFERENT hours by now — the
        // pass above folded away the ones that agreed. So the reader is looking
        // at two places called Vancouver reading two times, and nothing on the
        // row says which is which. That is what the region is for, and the only
        // thing it is for: "Vancouver, BC" against "Vancouver, WA", from
        // November, when British Columbia and Washington part on daylight time.
        //
        // Only the rows that collide, and only where the app recorded a region
        // to spend. A row with none keeps its bare name, which is still the
        // truth about it — the anchor has its own mark besides.
        let collisions = Dictionary(grouping: rows, by: \.name).filter { $0.value.count > 1 }
        if !collisions.isEmpty {
            for i in rows.indices where collisions[rows[i].name] != nil && !rows[i].region.isEmpty {
                rows[i].name = "\(rows[i].name), \(rows[i].region)"
            }
        }

        rows.sort {
            $0.offsetSeconds != $1.offsetSeconds
                ? $0.offsetSeconds < $1.offsetSeconds
                : $0.name.localizedCompare($1.name) == .orderedAscending
        }
        return rows
    }

    // Trims to `maxRows`, always keeping the rows that are not negotiable — the
    // anchor, the ground, and the phone when it has a row of its own — and
    // returns how many were hidden (for the "+N more" footer).
    //
    // WHICH OTHERS SURVIVE: the ones nearest the anchor. Keeping the first N of
    // an offset-sorted list, as this used to, kept whichever cities happened to
    // lie furthest west — an accident of the sort order rather than a decision.
    // Nearness to the clock you are living by is at least a reason.
    //
    // The anchor keeps its slot with no ship-specific rule needed: aboard it IS
    // the ship row, and `aboardShipKey` only changes on a definite answer, so a
    // guest whose phone has lost the network keeps the ship exactly when it
    // matters most.
    static func fit(_ rows: [WidgetRow], maxRows: Int) -> (visible: [WidgetRow], overflow: Int) {
        if rows.count <= maxRows { return (rows, 0) }
        let isSpecial: (WidgetRow) -> Bool = { $0.isAnchor || $0.isLocal || $0.isShip || $0.isDevice }
        let specials = rows.filter(isSpecial)
        let anchorOffset = rows.first { $0.isAnchor }?.offsetSeconds ?? 0
        // A duplicate yields before any zone showing an hour of its own, however
        // far from the anchor that zone sits: a second copy of a time already on
        // screen is the one thing here that tells the user nothing new. Within
        // each group, nearest the anchor survives.
        let others = rows.filter { !isSpecial($0) }
            .sorted {
                $0.sharesOffset != $1.sharesOffset
                    ? !$0.sharesOffset
                    : abs($0.offsetSeconds - anchorOffset) < abs($1.offsetSeconds - anchorOffset)
            }

        var kept = specials
        kept += others.prefix(max(0, maxRows - specials.count))
        kept.sort {
            $0.offsetSeconds != $1.offsetSeconds
                ? $0.offsetSeconds < $1.offsetSeconds
                : $0.name.localizedCompare($1.name) == .orderedAscending
        }
        return (kept, rows.count - kept.count)
    }
}
