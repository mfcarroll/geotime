import Foundation
import Capacitor
import WidgetKit

// Receives the timezone list + the app's GPS-derived local timezone from the web
// layer and mirrors them into the App Group store, then refreshes the widget.
// Also exposes the device's OS timezone (bug: WKWebView caches its JS timezone
// and doesn't see OS timezone changes until the process restarts).
@objc(WidgetBridgePlugin)
public class WidgetBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WidgetBridgePlugin"
    public let jsName = "WidgetBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setTimezones", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDeviceTimezone", returnType: CAPPluginReturnPromise)
    ]

    override public func load() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(systemTimezoneChanged),
            name: .NSSystemTimeZoneDidChange,
            object: nil)
    }

    @objc func setTimezones(_ call: CAPPluginCall) {
        guard let zones = call.getArray("timezones", String.self) else {
            call.reject("timezones must be a string array")
            return
        }
        WidgetSharedStore.save(zones)
        WidgetSharedStore.saveLabels(call.getArray("labels", String.self) ?? [])
        WidgetSharedStore.saveLocalTimezone(call.getString("localTimezone"))
        WidgetSharedStore.saveLocalPlaceName(call.getString("localPlaceName"))
        WidgetSharedStore.saveShips(Self.decodeShips(call.getArray("ships")))
        if #available(iOS 14.0, *) {
            WidgetCenter.shared.reloadAllTimelines()
        }
        call.resolve()
    }

    /// Ships arrive as plain JS objects, so they are read field by field rather
    /// than decoded. An entry missing its offset is dropped: the web layer
    /// already withholds unresolved ships, and a ship with no offset has no
    /// time to show — a missing row is honest, a zero offset would be a
    /// confident wrong clock.
    private static func decodeShips(_ raw: [JSValue]?) -> [WidgetSharedStore.Ship] {
        guard let raw = raw else { return [] }
        return raw.compactMap { entry in
            guard let dict = entry as? JSObject,
                  let key = dict["key"] as? String,
                  let name = dict["name"] as? String,
                  let offset = dict["offsetMinutes"] as? Int else { return nil }
            let fetchedAt = (dict["fetchedAt"] as? Double)
                ?? (dict["fetchedAt"] as? Int).map(Double.init)
                ?? 0
            // Falls back to the full name so a store written by an older build
            // still renders, just without the ability to abbreviate.
            let short = (dict["short"] as? String) ?? name
            let refreshUntil = (dict["refreshUntil"] as? Double)
                ?? (dict["refreshUntil"] as? Int).map(Double.init)
            return WidgetSharedStore.Ship(
                key: key, name: name, short: short,
                offsetMinutes: offset, fetchedAt: fetchedAt,
                refreshUntil: refreshUntil)
        }
    }

    @objc func getDeviceTimezone(_ call: CAPPluginCall) {
        NSTimeZone.resetSystemTimeZone()
        call.resolve(["id": TimeZone.current.identifier])
    }

    @objc private func systemTimezoneChanged() {
        NSTimeZone.resetSystemTimeZone()
        notifyListeners("deviceTimezoneChanged", data: ["id": TimeZone.current.identifier])
        if #available(iOS 14.0, *) {
            WidgetCenter.shared.reloadAllTimelines()
        }
    }
}
