import Foundation

// Shared App Group store for the timezone list. The web app writes here via the
// WidgetBridge plugin; the widget extension reads here. Stored as a JSON string
// to match the cross-platform contract (Android stores JSONArray.toString()).
struct LocalZone: Equatable {
    let zone: TimeZone
    let placeName: String?
    /// True when the stored GPS zone was discarded as overtaken by travel.
    let supersededByDevice: Bool
}

/// What the widget should treat as "local", and what to call it.
///
/// The stored zone is GPS-derived and only refreshed while the app runs, so on
/// its own the widget stays on your old timezone for a whole trip until you
/// happen to open the app. Phones update their *own* timezone on landing, so a
/// device zone that has changed since the app last wrote is firm evidence the
/// stored one has been overtaken — trust the OS, and drop the place name with
/// it, since it names a town you have left.
///
/// Pure so the rule can be tested directly, and so it can be read beside the
/// Android twin in GeoTimeWidgetProvider.chooseLocal.
func chooseLocal(storedZone: String?, writtenUnder: String?, placeName: String?,
                 deviceTz: TimeZone) -> LocalZone {
    guard let storedZone, let stored = TimeZone(identifier: storedZone) else {
        return LocalZone(zone: deviceTz, placeName: nil, supersededByDevice: false)
    }
    if let writtenUnder, writtenUnder != deviceTz.identifier {
        return LocalZone(zone: deviceTz, placeName: nil, supersededByDevice: true)
    }
    return LocalZone(zone: stored, placeName: placeName, supersededByDevice: false)
}

enum WidgetSharedStore {
    static let suiteName = "group.ca.matthewcarroll.geotime"
    static let key = "worldClocks"
    static let localTimezoneKey = "localTimezone"
    static let localPlaceKey = "localPlaceName"
    static let deviceTzAtWriteKey = "deviceTimezoneAtWrite"

    static func save(_ zones: [String]) {
        guard let defaults = UserDefaults(suiteName: suiteName) else { return }
        if let data = try? JSONEncoder().encode(zones),
           let json = String(data: data, encoding: .utf8) {
            defaults.set(json, forKey: key)
        }
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

    static func loadLocalTimezone() -> TimeZone {
        if let id = UserDefaults(suiteName: suiteName)?.string(forKey: localTimezoneKey),
           let tz = TimeZone(identifier: id) {
            return tz
        }
        return .current
    }

    // The OS timezone as it was when the app last wrote. Recorded natively
    // rather than passed in from the web layer, because WKWebView caches its JS
    // timezone and can report a stale one after the OS changes.
    static func saveDeviceTimezoneAtWrite(_ id: String) {
        UserDefaults(suiteName: suiteName)?.set(id, forKey: deviceTzAtWriteKey)
    }

    static func loadDeviceTimezoneAtWrite() -> String? {
        UserDefaults(suiteName: suiteName)?.string(forKey: deviceTzAtWriteKey)
    }

    /// Reads the stored values and applies `chooseLocal`.
    static func resolveLocal(now deviceTz: TimeZone = .current) -> LocalZone {
        chooseLocal(storedZone: UserDefaults(suiteName: suiteName)?.string(forKey: localTimezoneKey),
                    writtenUnder: loadDeviceTimezoneAtWrite(),
                    placeName: loadLocalPlaceName(),
                    deviceTz: deviceTz)
    }
}
