import Foundation

// Shared App Group store for the timezone list. The web app writes here via the
// WidgetBridge plugin; the widget extension reads here. Stored as a JSON string
// to match the cross-platform contract (Android stores JSONArray.toString()).
enum WidgetSharedStore {
    static let suiteName = "group.ca.matthewcarroll.geotime"
    static let key = "worldClocks"
    static let localTimezoneKey = "localTimezone"

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

    static func loadLocalTimezone() -> TimeZone {
        if let id = UserDefaults(suiteName: suiteName)?.string(forKey: localTimezoneKey),
           let tz = TimeZone(identifier: id) {
            return tz
        }
        return .current
    }
}
