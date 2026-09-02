import Foundation
import XCTest
@testable import GeoTimeShared

// Fixtures shared by the suites.
//
// Everything is pinned: a fixed instant, named zones, explicit offsets. The one
// thing that cannot be pinned is Locale.current — TimezoneDisplay.timeParts and
// .weekday both read it — so those fields are asserted by SHAPE rather than by
// value. See `assertLooksLikeAClock`. Every field this suite asserts literally
// (relativeText, name, ordering, the role flags) is locale-independent.
enum Fixture {
    /// 2026-09-02T20:00:00Z. Mid-afternoon in the Americas, evening in Europe,
    /// and the next day in Tokyo — so the day-differs paths are live.
    static let now = Date(timeIntervalSince1970: 1_788_465_600)

    static let newYork = TimeZone(identifier: "America/New_York")!    // UTC-4 in September
    static let vancouver = TimeZone(identifier: "America/Vancouver")! // UTC-7
    static let london = TimeZone(identifier: "Europe/London")!        // UTC+1
    static let tokyo = TimeZone(identifier: "Asia/Tokyo")!            // UTC+9

    /// A ship whose clock is `offsetHours` from UTC.
    static func ship(_ key: String, _ name: String, offsetHours: Double,
                     short: String? = nil) -> WidgetSharedStore.Ship {
        WidgetSharedStore.Ship(
            key: key, name: name, short: short,
            offsetMinutes: Int(offsetHours * 60),
            fetchedAt: now.timeIntervalSince1970 * 1000,
            refreshUntil: nil
        )
    }
}

extension XCTestCase {
    /// The clock fields come from a locale-sensitive DateFormatter, so they are
    /// checked for shape, not for text. A test that asserted "3:22" would pass
    /// in Cupertino and fail anywhere that prefers a 24-hour clock.
    func assertLooksLikeAClock(_ row: WidgetRow, _ message: String = "",
                               file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertNotNil(row.timeDigits.range(of: #"^\d{1,2}:\d{2}$"#, options: .regularExpression),
                        "\(message) timeDigits was \(row.timeDigits)", file: file, line: line)
    }

    func row(_ rows: [WidgetRow], named name: String,
             file: StaticString = #filePath, line: UInt = #line) throws -> WidgetRow {
        guard let found = rows.first(where: { $0.name == name }) else {
            XCTFail("no row named \(name); got \(rows.map(\.name))", file: file, line: line)
            throw XCTSkip("missing row")
        }
        return found
    }
}
