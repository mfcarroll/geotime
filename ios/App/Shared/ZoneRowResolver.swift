import Foundation

struct WidgetRow: Identifiable {
    let id: String
    let name: String
    /// A shorter form of `name`, when one exists (ships). The view uses it only
    /// when the full name would shrink the font every row shares — see
    /// GeoTimeWidget.metrics.
    let shortName: String?
    let isLocal: Bool          // GPS-derived base zone (pin)
    let isDevice: Bool         // the device's OS zone, when it differs from local (phone)
    let isShip: Bool           // a cruise ship's clock, set by the crew (ship mark)
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
    static func resolve(storedIds: [String], local: TimeZone, deviceTz: TimeZone, now: Date,
                        localPlaceName: String? = nil, labels: [String] = [],
                        ships: [WidgetSharedStore.Ship] = []) -> [WidgetRow] {
        let localOffset = local.secondsFromGMT(for: now)
        var seenIds: Set<String> = [local.identifier] // local pre-claims its slot
        var rows: [WidgetRow] = []

        // ONE RULE for every special row: the base always shows, and device and
        // ship each appear only when they add information — that is, when their
        // offset differs from the base. Three bespoke branches would drift apart
        // between here and the Android provider; one test does not.
        //
        // The deliberate asymmetry is which way "agreeing" resolves. An agreeing
        // device is hidden, because knowing your phone concurs is not worth a
        // row. An agreeing ship is *folded into the base row*, because it brings
        // something a device never can: a name. Mid-ocean the base row would
        // otherwise read "UTC−5" — nearestPlace is capped at 150 km and
        // correctly finds nothing out there — so lending it "Star" is the
        // difference between naming where you are and naming a number.
        let agreeingShip = ships.first { $0.offsetMinutes * 60 == localOffset }
        let localParts = TimezoneDisplay.timeParts(local, at: now)
        rows.append(WidgetRow(
            id: local.identifier,
            // The ship if it agrees, else the town the app last placed you in,
            // else the zone's own name.
            name: agreeingShip?.name
                ?? localPlaceName
                ?? TimezoneDisplay.displayName(local.identifier),
            shortName: agreeingShip?.shortOrFull,
            isLocal: true,
            isDevice: false,
            isShip: agreeingShip != nil,
            timeDigits: localParts.digits,
            timePeriod: localParts.period,
            weekdayShort: nil,
            weekdayFull: nil,
            relativeText: "Local time",
            offsetSeconds: localOffset
        ))

        // The device's OS timezone, when it differs from the GPS-derived local zone
        // (e.g. phone still on Vancouver time while you're in London).
        let deviceOffset = deviceTz.secondsFromGMT(for: now)
        if deviceOffset != localOffset {
            seenIds.insert(deviceTz.identifier)
            let parts = TimezoneDisplay.timeParts(deviceTz, at: now)
            let differs = TimezoneDisplay.dayDiffers(deviceTz, local, at: now)
            rows.append(WidgetRow(
                id: "device:\(deviceTz.identifier)",
                name: TimezoneDisplay.displayName(deviceTz.identifier),
                shortName: nil,
                isLocal: false,
                isDevice: true,
                isShip: false,
                timeDigits: parts.digits,
                timePeriod: parts.period,
                weekdayShort: differs ? TimezoneDisplay.weekday(deviceTz, at: now, full: false) : nil,
                weekdayFull: differs ? TimezoneDisplay.weekday(deviceTz, at: now, full: true) : nil,
                relativeText: TimezoneDisplay.relativeOffset(zoneSeconds: deviceOffset, deviceSeconds: localOffset),
                offsetSeconds: deviceOffset
            ))
        }

        for (index, id) in storedIds.enumerated() {
            if id == local.identifier { continue }
            guard let info = TimezoneDisplay.resolveZone(id) else { continue }
            // The name the user chose, where there is one.
            let chosen = index < labels.count && !labels[index].isEmpty ? labels[index] : nil
            let off = info.timeZone.secondsFromGMT(for: now)
            if seenIds.contains(info.timeZone.identifier) { continue }
            seenIds.insert(info.timeZone.identifier)
            let parts = TimezoneDisplay.timeParts(info.timeZone, at: now)
            let differs = TimezoneDisplay.dayDiffers(info.timeZone, local, at: now)
            rows.append(WidgetRow(
                id: id,
                name: chosen ?? info.displayName,
                shortName: nil,
                isLocal: false,
                isDevice: false,
                isShip: false,
                timeDigits: parts.digits,
                timePeriod: parts.period,
                weekdayShort: differs ? TimezoneDisplay.weekday(info.timeZone, at: now, full: false) : nil,
                weekdayFull: differs ? TimezoneDisplay.weekday(info.timeZone, at: now, full: true) : nil,
                relativeText: TimezoneDisplay.relativeOffset(zoneSeconds: off, deviceSeconds: localOffset),
                offsetSeconds: off
            ))
        }

        // Ships that do NOT match the base offset get their own row. The one
        // that does was folded in above, so it is skipped here — a detected ship
        // appears once, never twice.
        for ship in ships {
            let offset = ship.offsetMinutes * 60
            if offset == localOffset { continue }
            guard let tz = ship.timeZone else { continue }
            let parts = TimezoneDisplay.timeParts(tz, at: now)
            let differs = TimezoneDisplay.dayDiffers(tz, local, at: now)
            rows.append(WidgetRow(
                id: "ship:\(ship.key)",
                name: ship.name,
                shortName: ship.shortOrFull,
                isLocal: false,
                isDevice: false,
                isShip: true,
                timeDigits: parts.digits,
                timePeriod: parts.period,
                weekdayShort: differs ? TimezoneDisplay.weekday(tz, at: now, full: false) : nil,
                weekdayFull: differs ? TimezoneDisplay.weekday(tz, at: now, full: true) : nil,
                relativeText: TimezoneDisplay.relativeOffset(zoneSeconds: offset, deviceSeconds: localOffset),
                offsetSeconds: offset
            ))
        }

        // Offsets can now tie, so break ties by name for a stable order.
        rows.sort {
            $0.offsetSeconds != $1.offsetSeconds
                ? $0.offsetSeconds < $1.offsetSeconds
                : $0.name.localizedCompare($1.name) == .orderedAscending
        }
        return rows
    }

    // Trims to `maxRows`, always keeping the special rows (local, device, ship);
    // returns how many were hidden (for the "+N more" footer).
    //
    // A ship counts as special because aboard it is the most important row on
    // the screen. It only stops being special when a definite `shore` marker
    // arrives — which needs connectivity, and therefore means the guest really
    // is ashore. Standing in a port with a dead phone yields no marker at all,
    // so the ship keeps its guaranteed slot exactly when it matters most.
    static func fit(_ rows: [WidgetRow], maxRows: Int) -> (visible: [WidgetRow], overflow: Int) {
        if rows.count <= maxRows { return (rows, 0) }
        let specials = rows.filter { $0.isLocal || $0.isDevice || $0.isShip }
        let others = rows.filter { !$0.isLocal && !$0.isDevice && !$0.isShip }
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
