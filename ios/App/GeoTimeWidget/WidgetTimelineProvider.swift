import WidgetKit
import Foundation

struct ClockEntry: TimelineEntry {
    let date: Date
    let rows: [WidgetRow]   // all rows; the view fits them to the widget height
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> ClockEntry {
        makeEntry(for: Date(), ids: WidgetSharedStore.load())
    }

    func getSnapshot(in context: Context, completion: @escaping (ClockEntry) -> Void) {
        completion(makeEntry(for: Date(), ids: WidgetSharedStore.load()))
    }

    // Per-minute entries ~90 minutes ahead, then reload. Gives exact control over
    // formatting (device 12/24h, no seconds) and recomputes sort/dedup/weekday as
    // time passes — Text(_, style:.time) is rejected because it ignores the row's
    // timezone environment.
    func getTimeline(in context: Context, completion: @escaping (Timeline<ClockEntry>) -> Void) {
        let ids = WidgetSharedStore.load()
        let now = Date()
        var entries: [ClockEntry] = [makeEntry(for: now, ids: ids)]

        let cal = Calendar.current
        let firstBoundary = cal.nextDate(after: now,
                                         matching: DateComponents(second: 0),
                                         matchingPolicy: .nextTime) ?? now.addingTimeInterval(60)
        for i in 0..<90 {
            let date = firstBoundary.addingTimeInterval(Double(i) * 60)
            entries.append(makeEntry(for: date, ids: ids))
        }
        completion(Timeline(entries: entries, policy: .atEnd))
    }

    private func makeEntry(for date: Date, ids: [String]) -> ClockEntry {
        // Base off the app's GPS-derived local timezone; the device's own OS zone
        // is read live and shown separately when it differs.
        let local = WidgetSharedStore.loadLocalTimezone()
        return ClockEntry(date: date,
                          rows: ZoneRowResolver.resolve(storedIds: ids, local: local, deviceTz: .current, now: date))
    }
}
