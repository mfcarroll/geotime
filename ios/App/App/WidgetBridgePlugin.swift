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
        WidgetSharedStore.saveLocalTimezone(call.getString("localTimezone"))
        if #available(iOS 14.0, *) {
            WidgetCenter.shared.reloadAllTimelines()
        }
        call.resolve()
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
