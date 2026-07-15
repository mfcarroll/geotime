import Foundation

struct ZoneInfo {
    let timeZone: TimeZone
    let displayName: String
}

// Ports the display/offset semantics of src/time.ts so the widget matches the app.
enum TimezoneDisplay {

    // Resolve an IANA id (or a synthesized Etc/GMT id) to a real TimeZone + label.
    // The web app can synthesize fractional ids like "Etc/GMT+5.5" (see
    // getValidTimezoneName in src/time.ts) which are NOT valid tzdb ids, so those
    // must be parsed manually into a fixed-offset zone.
    static func resolveZone(_ id: String) -> ZoneInfo? {
        if let etc = parseEtcGmt(id) {
            guard let tz = TimeZone(secondsFromGMT: etc.seconds) else { return nil }
            return ZoneInfo(timeZone: tz, displayName: etc.label)
        }
        guard let tz = TimeZone(identifier: id) else { return nil }
        return ZoneInfo(timeZone: tz, displayName: cityName(id))
    }

    static func displayName(_ id: String) -> String {
        resolveZone(id)?.displayName ?? cityName(id)
    }

    // Matches getDisplayTimezoneName: last "/" segment, underscores -> spaces.
    private static func cityName(_ id: String) -> String {
        guard let last = id.split(separator: "/").last else { return id }
        return last.replacingOccurrences(of: "_", with: " ")
    }

    // "Etc/GMT+5" / "Etc/GMT-3.5": POSIX signs are inverted vs UTC. Returns the
    // real offset (seconds) and the "UTC±N" label matching getDisplayTimezoneName.
    private static func parseEtcGmt(_ id: String) -> (seconds: Int, label: String)? {
        guard id.hasPrefix("Etc/GMT") else { return nil }
        let body = id.dropFirst("Etc/GMT".count) // "+5", "-3.5", "0", ""
        guard let sign = body.first, sign == "+" || sign == "-" else { return nil }
        guard let value = Double(body.dropFirst()) else { return nil }
        let inverted = (sign == "+") ? -value : value // Etc/GMT+5 => -5
        let seconds = Int((inverted * 3600).rounded())
        let numberLabel = inverted == inverted.rounded()
            ? String(Int(inverted))
            : String(inverted)
        let label = "UTC" + (inverted >= 0 ? "+" : "") + numberLabel
        return (seconds, label)
    }

    // Splits the time into the numeric part and the AM/PM part so the widget can
    // lay them out as two aligned columns. In 24h locales `period` is empty.
    static func timeParts(_ tz: TimeZone, at date: Date) -> (digits: String, period: String) {
        let loc = Locale.current
        let template = DateFormatter.dateFormat(fromTemplate: "jmm", options: 0, locale: loc) ?? "h:mm a"
        let is24h = !template.lowercased().contains("a")

        let timeFormatter = DateFormatter()
        timeFormatter.locale = loc
        timeFormatter.timeZone = tz
        timeFormatter.dateFormat = is24h ? "HH:mm" : "h:mm"
        let digits = timeFormatter.string(from: date)

        var period = ""
        if !is24h {
            let periodFormatter = DateFormatter()
            periodFormatter.locale = loc
            periodFormatter.timeZone = tz
            periodFormatter.dateFormat = "a"
            period = periodFormatter.string(from: date)
        }
        return (digits, period)
    }

    static func weekday(_ tz: TimeZone, at date: Date, full: Bool = false) -> String {
        let df = DateFormatter()
        df.locale = Locale.current
        df.timeZone = tz
        df.setLocalizedDateFormatFromTemplate(full ? "EEEE" : "EEE")
        return df.string(from: date)
    }

    static func dayDiffers(_ tz: TimeZone, _ device: TimeZone, at date: Date) -> Bool {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = tz
        let a = cal.dateComponents([.year, .month, .day], from: date)
        cal.timeZone = device
        let b = cal.dateComponents([.year, .month, .day], from: date)
        return a.year != b.year || a.month != b.month || a.day != b.day
    }

    // Port of getTimezoneOffset (src/time.ts): "+3 hrs", "−5½ hrs", "Local time".
    // Uses U+2212 minus to match the app.
    static func relativeOffset(zoneSeconds: Int, deviceSeconds: Int) -> String {
        let diffMin = (zoneSeconds - deviceSeconds) / 60
        if diffMin == 0 { return "Local time" }
        let sign = diffMin > 0 ? "+" : "\u{2212}"
        let absMin = abs(diffMin)
        let hours = absMin / 60
        let frac = absMin % 60
        var hourString = hours > 0 ? "\(hours)" : ""
        switch frac {
        case 30: hourString += "½"
        case 45: hourString += "¾"
        case 15: hourString += "¼"
        default: break
        }
        let plural = absMin > 60 ? "s" : ""
        return "\(sign)\(hourString) hr\(plural)"
    }
}
