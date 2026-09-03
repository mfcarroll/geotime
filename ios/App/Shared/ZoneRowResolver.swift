import Foundation

struct WidgetRow: Identifiable {
    let id: String
    let name: String
    /// A shorter form of `name`, when one exists (ships). The view uses it only
    /// when the full name would shrink the font every row shares — see
    /// GeoTimeWidget.metrics.
    let shortName: String?
    let isLocal: Bool          // GPS-derived geographic zone (pin)
    let isDevice: Bool         // the device's OS zone, when it differs from the anchor (phone)
    let isShip: Bool           // a cruise ship's clock, set by the crew (ship mark)
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
        TimeZone(secondsFromGMT: seconds) ?? .gmt
    }

    /// - Parameter aboardShipKey: the ship the wifi marker says we are aboard,
    ///   or nil ashore. A key rather than a flag because the list may hold
    ///   several ships and only one of them is underfoot. Naming a ship that is
    ///   not in `ships` — an offset that never resolved — falls back to the
    ///   geographic anchor rather than anchoring on nothing.
    static func resolve(storedIds: [String], local: TimeZone, deviceTz: TimeZone, now: Date,
                        localPlaceName: String? = nil, labels: [String] = [],
                        ships: [WidgetSharedStore.Ship] = [],
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

        if !mergeGroundIntoShip {
            let isAnchor = aboardShip == nil
            let parts = TimezoneDisplay.timeParts(local, at: now)
            let differs = !isAnchor && TimezoneDisplay.dayDiffers(local, anchorTz, at: now)
            rows.append(WidgetRow(
                id: local.identifier,
                name: localPlaceName ?? TimezoneDisplay.displayName(local.identifier),
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

        // The saved cities. One is dropped when its clock already appears above
        // it — on a surface this small a second copy of a time buys nothing, and
        // the app itself still lists both. Two zones that agree today and part in
        // November part here too, which is the point.
        //
        // Only the ground and a standalone phone claim an offset here, and the
        // ground goes first, so where you actually are always wins: in Vancouver
        // with San Francisco saved, Vancouver keeps the slot.
        for (index, id) in storedIds.enumerated() {
            if id == local.identifier { continue }
            guard let info = TimezoneDisplay.resolveZone(id) else { continue }
            let off = info.timeZone.secondsFromGMT(for: now)
            if claimedOffsets.contains(off) { continue }
            claimedOffsets.insert(off)
            let chosen = index < labels.count && !labels[index].isEmpty ? labels[index] : nil
            let parts = TimezoneDisplay.timeParts(info.timeZone, at: now)
            let differs = TimezoneDisplay.dayDiffers(info.timeZone, anchorTz, at: now)
            rows.append(WidgetRow(
                id: id,
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
                offsetSeconds: off
            ))
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
        let others = rows.filter { !isSpecial($0) }
            .sorted { abs($0.offsetSeconds - anchorOffset) < abs($1.offsetSeconds - anchorOffset) }

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
