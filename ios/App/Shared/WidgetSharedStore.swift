import Foundation

// Shared App Group store for the timezone list. The web app writes here via the
// WidgetBridge plugin; the widget extension reads here. Stored as a JSON string
// to match the cross-platform contract (Android stores JSONArray.toString()).
enum WidgetSharedStore {
    static let suiteName = "group.ca.matthewcarroll.geotime"
    static let key = "worldClocks"
    static let localTimezoneKey = "localTimezone"
    static let localPlaceKey = "localPlaceName"
    static let labelsKey = "worldClockLabels"
    static let shipsKey = "shipClocks"
    static let appKeyKey = "rcclAppKey"

    static func save(_ zones: [String]) {
        guard let defaults = UserDefaults(suiteName: suiteName) else { return }
        if let data = try? JSONEncoder().encode(zones),
           let json = String(data: data, encoding: .utf8) {
            defaults.set(json, forKey: key)
        }
    }

    // Names the user actually picked, parallel to `load()`. Searching "San
    // Francisco" stores America/Los_Angeles, and the widget should say San
    // Francisco rather than re-deriving Los Angeles from the id.
    static func saveLabels(_ labels: [String]) {
        guard let defaults = UserDefaults(suiteName: suiteName) else { return }
        if let data = try? JSONEncoder().encode(labels),
           let json = String(data: data, encoding: .utf8) {
            defaults.set(json, forKey: labelsKey)
        }
    }

    static func loadLabels() -> [String] {
        guard let defaults = UserDefaults(suiteName: suiteName),
              let json = defaults.string(forKey: labelsKey),
              let data = json.data(using: .utf8),
              let labels = try? JSONDecoder().decode([String].self, from: data) else {
            return []   // written by an older build; fall back to zone names
        }
        return labels
    }

    static func load() -> [String] {
        guard let defaults = UserDefaults(suiteName: suiteName),
              let json = defaults.string(forKey: key),
              let data = json.data(using: .utf8),
              let zones = try? JSONDecoder().decode([String].self, from: data) else {
            return []
        }
        return zones
    }

    // The app's GPS-derived local timezone, which may differ from the device's
    // OS timezone. The widget uses this as its base ("local" row + offsets).
    static func saveLocalTimezone(_ id: String?) {
        guard let defaults = UserDefaults(suiteName: suiteName) else { return }
        if let id = id, !id.isEmpty {
            defaults.set(id, forKey: localTimezoneKey)
        } else {
            defaults.removeObject(forKey: localTimezoneKey)
        }
    }

    // The nearest town to the app's last GPS fix, inside that fix's own zone —
    // "Nelson" rather than "Vancouver". Resolved by the app, because the city
    // index it comes from is far too large to parse in an extension.
    static func saveLocalPlaceName(_ name: String?) {
        guard let defaults = UserDefaults(suiteName: suiteName) else { return }
        if let name = name, !name.isEmpty {
            defaults.set(name, forKey: localPlaceKey)
        } else {
            defaults.removeObject(forKey: localPlaceKey)
        }
    }

    static func loadLocalPlaceName() -> String? {
        UserDefaults(suiteName: suiteName)?.string(forKey: localPlaceKey)
    }

    /// A ship as the widget needs it: a name and a fixed offset in minutes.
    ///
    /// Deliberately not an IANA identifier. A ship's clock is set by the crew,
    /// so there is no zone whose rules describe it — and a synthetic id would
    /// need hand-written parsing on every platform, which is exactly what the
    /// 1.3.0 restructure removed. A fixed-offset TimeZone has no DST rules,
    /// which is correct for a vessel.
    struct Ship: Codable {
        let key: String
        /// Full name, used wherever the layout has room for it.
        let name: String
        /// Abbreviated form, used only when the full name will not fit.
        ///
        /// OPTIONAL, and it must stay that way. JSONDecoder fails the whole
        /// array if one record lacks a non-optional field, so a store written by
        /// any earlier build would decode to nothing and every ship would
        /// silently vanish from the widget. Anything added here later needs the
        /// same treatment — the widget must read a store written by a version
        /// that predates it. (Android's optString already defaulted; this side
        /// did not, which is exactly the asymmetry that produced the bug.)
        let short: String?
        let offsetMinutes: Int
        /// Epoch ms of the last confirmed offset.
        let fetchedAt: Double
        /// Epoch ms after which the widget stops refreshing this ship; 0 or nil
        /// means no bound.
        ///
        /// The policy behind it lives in the web layer — auto-added ships are
        /// bounded by the voyage they were detected on, manually added ones are
        /// not — so native only has to obey a date rather than re-derive that
        /// rule in two more languages.
        let refreshUntil: Double?

        /// The name to prefer when the layout is tight.
        var shortOrFull: String { short ?? name }

        var timeZone: TimeZone? { TimeZone(secondsFromGMT: offsetMinutes * 60) }

        /// Whether the widget should re-ask for this ship's offset right now.
        func needsRefresh(at now: Date, staleAfter: TimeInterval) -> Bool {
            if let until = refreshUntil, until > 0,
               now.timeIntervalSince1970 * 1000 > until { return false }
            return now.timeIntervalSince1970 - (fetchedAt / 1000) > staleAfter
        }
    }

    static func saveShips(_ ships: [Ship]) {
        guard let defaults = UserDefaults(suiteName: suiteName) else { return }
        if let data = try? JSONEncoder().encode(ships),
           let json = String(data: data, encoding: .utf8) {
            defaults.set(json, forKey: shipsKey)
        }
    }

    static func loadShips() -> [Ship] {
        guard let defaults = UserDefaults(suiteName: suiteName),
              let json = defaults.string(forKey: shipsKey),
              let data = json.data(using: .utf8),
              let ships = try? JSONDecoder().decode([Ship].self, from: data) else {
            return []   // written by an older build, or no ships added
        }
        return ships
    }

    /// The Royal Caribbean app key, so the widget can refresh on its own.
    ///
    /// Written by ShipTimePlugin from the Capacitor config, which is where the
    /// key arrives (see capacitor.config.ts). The widget extension cannot read
    /// the app's config bundle, so it is mirrored here — the App Group is
    /// already the channel for everything else the widget needs.
    static func saveAppKey(_ key: String?) {
        guard let defaults = UserDefaults(suiteName: suiteName) else { return }
        if let key = key, !key.isEmpty { defaults.set(key, forKey: appKeyKey) }
        else { defaults.removeObject(forKey: appKeyKey) }
    }

    static func loadAppKey() -> String? {
        let key = UserDefaults(suiteName: suiteName)?.string(forKey: appKeyKey)
        return (key?.isEmpty ?? true) ? nil : key
    }

    static func loadLocalTimezone() -> TimeZone {
        if let id = UserDefaults(suiteName: suiteName)?.string(forKey: localTimezoneKey),
           let tz = TimeZone(identifier: id) {
            return tz
        }
        return .current
    }
}
