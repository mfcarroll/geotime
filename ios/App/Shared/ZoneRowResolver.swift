import Foundation

struct WidgetRow: Identifiable {
    let id: String
    let name: String
    let isLocal: Bool          // GPS-derived base zone (green pin)
    let isDevice: Bool         // the device's OS zone, when it differs from local (phone)
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
                        localPlaceName: String? = nil) -> [WidgetRow] {
        let localOffset = local.secondsFromGMT(for: now)
        var seenIds: Set<String> = [local.identifier] // local pre-claims its slot
        var rows: [WidgetRow] = []

        let localParts = TimezoneDisplay.timeParts(local, at: now)
        rows.append(WidgetRow(
            id: local.identifier,
            // The town the app last placed you in, else the zone's own name.
            name: localPlaceName ?? TimezoneDisplay.displayName(local.identifier),
            isLocal: true,
            isDevice: false,
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
                isLocal: false,
                isDevice: true,
                timeDigits: parts.digits,
                timePeriod: parts.period,
                weekdayShort: differs ? TimezoneDisplay.weekday(deviceTz, at: now, full: false) : nil,
                weekdayFull: differs ? TimezoneDisplay.weekday(deviceTz, at: now, full: true) : nil,
                relativeText: TimezoneDisplay.relativeOffset(zoneSeconds: deviceOffset, deviceSeconds: localOffset),
                offsetSeconds: deviceOffset
            ))
        }

        for id in storedIds {
            if id == local.identifier { continue }
            guard let info = TimezoneDisplay.resolveZone(id) else { continue }
            let off = info.timeZone.secondsFromGMT(for: now)
            if seenIds.contains(info.timeZone.identifier) { continue }
            seenIds.insert(info.timeZone.identifier)
            let parts = TimezoneDisplay.timeParts(info.timeZone, at: now)
            let differs = TimezoneDisplay.dayDiffers(info.timeZone, local, at: now)
            rows.append(WidgetRow(
                id: id,
                name: info.displayName,
                isLocal: false,
                isDevice: false,
                timeDigits: parts.digits,
                timePeriod: parts.period,
                weekdayShort: differs ? TimezoneDisplay.weekday(info.timeZone, at: now, full: false) : nil,
                weekdayFull: differs ? TimezoneDisplay.weekday(info.timeZone, at: now, full: true) : nil,
                relativeText: TimezoneDisplay.relativeOffset(zoneSeconds: off, deviceSeconds: localOffset),
                offsetSeconds: off
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

    // Trims to `maxRows`, always keeping the special rows (local + device); returns
    // how many were hidden (for the "+N more" footer).
    static func fit(_ rows: [WidgetRow], maxRows: Int) -> (visible: [WidgetRow], overflow: Int) {
        if rows.count <= maxRows { return (rows, 0) }
        let specials = rows.filter { $0.isLocal || $0.isDevice }
        let others = rows.filter { !$0.isLocal && !$0.isDevice }
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
