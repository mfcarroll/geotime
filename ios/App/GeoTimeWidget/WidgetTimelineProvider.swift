import WidgetKit
import Foundation

struct ClockEntry: TimelineEntry {
    let date: Date
    let rows: [WidgetRow]   // all rows; the view fits them to the widget height
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> ClockEntry {
        makeEntry(for: Date(), ids: WidgetSharedStore.load(), ships: WidgetSharedStore.loadShips())
    }

    // No network here: a snapshot is drawn for the widget gallery and has to be
    // instant.
    func getSnapshot(in context: Context, completion: @escaping (ClockEntry) -> Void) {
        completion(makeEntry(for: Date(), ids: WidgetSharedStore.load(),
                             ships: WidgetSharedStore.loadShips()))
    }

    // Per-minute entries ~90 minutes ahead, then reload. Gives exact control over
    // formatting (device 12/24h, no seconds) and recomputes sort/dedup/weekday as
    // time passes — Text(_, style:.time) is rejected because it ignores the row's
    // timezone environment.
    func getTimeline(in context: Context, completion: @escaping (Timeline<ClockEntry>) -> Void) {
        // Refresh stale ship offsets before building the timeline. The reload
        // was already happening about every 90 minutes for the clock itself, so
        // riding it costs no extra wake-ups — and it is the only way the widget
        // moves when the crew shifts the clock and nobody opens the app.
        //
        // Awaited rather than fired and forgotten: the entries built below embed
        // the offsets, so a late result would not reach the screen until the
        // next reload.
        Task {
            let ships = await ShipTimeFetcher.refreshStaleShips()
            buildTimeline(ships: ships, completion: completion)
        }
    }

    private func buildTimeline(ships: [WidgetSharedStore.Ship],
                               completion: @escaping (Timeline<ClockEntry>) -> Void) {
        let ids = WidgetSharedStore.load()
        let now = Date()
        var entries: [ClockEntry] = [makeEntry(for: now, ids: ids, ships: ships)]

        let cal = Calendar.current
        let firstBoundary = cal.nextDate(after: now,
                                         matching: DateComponents(second: 0),
                                         matchingPolicy: .nextTime) ?? now.addingTimeInterval(60)
        for i in 0..<90 {
            let date = firstBoundary.addingTimeInterval(Double(i) * 60)
            entries.append(makeEntry(for: date, ids: ids, ships: ships))
        }
        completion(Timeline(entries: entries, policy: .atEnd))
    }

    private func makeEntry(for date: Date, ids: [String],
                           ships: [WidgetSharedStore.Ship]) -> ClockEntry {
        // Base off the app's GPS-derived local timezone; the device's own OS zone
        // is read live and shown separately when it differs.
        let local = WidgetSharedStore.loadLocalTimezone()
        return ClockEntry(date: date,
                          rows: ZoneRowResolver.resolve(storedIds: ids, local: local, deviceTz: .current,
                                                        now: date,
                                                        localPlaceName: WidgetSharedStore.loadLocalPlaceName(),
                                                        labels: WidgetSharedStore.loadLabels(),
                                                        ships: ships))
    }
}
