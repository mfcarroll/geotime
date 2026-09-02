import Foundation

/// Fetches a ship's current UTC offset. Compiled into the app *and* the widget.
///
/// A deliberate second implementation of what `src/rccl.ts` does, and the reason
/// is unavoidable: a widget cannot call into the WebView, so the widget cannot
/// reuse the TypeScript client. Without this the widget only ever changes when
/// somebody opens the app, which on a cruise means the home screen quietly
/// drifts an hour out for a day at a time.
///
/// Kept as small as it can be — one GET, one field read — precisely because it
/// is a duplicate. Everything else about ship time (which ships exist, which one
/// you are aboard, how a row is named, what bounds the refresh) stays in the web
/// layer and reaches here through the App Group.
enum ShipTimeFetcher {

    /// How stale an offset must be before the widget re-asks.
    ///
    /// Crews shift the clock overnight, once or twice a sailing, so four hours is
    /// already far finer than the data changes. The widget wakes about every 90
    /// minutes anyway (see WidgetTimelineProvider), so this mostly decides how
    /// often that wake-up makes a request rather than how often it happens.
    static let staleAfter: TimeInterval = 4 * 60 * 60

    /// Refreshes any stored ship whose offset has gone stale, and writes the
    /// results back to the App Group. Returns the ships as they now stand.
    ///
    /// Never throws and never clears a stored offset: if the request fails, the
    /// cached value is what the widget keeps showing. That is the whole point of
    /// storing it — a phone in a port with no signal still knows when to be back
    /// aboard.
    static func refreshStaleShips(now: Date = Date()) async -> [WidgetSharedStore.Ship] {
        let ships = WidgetSharedStore.loadShips()
        guard let appKey = WidgetSharedStore.loadAppKey() else { return ships }

        let due = ships.filter { $0.needsRefresh(at: now, staleAfter: staleAfter) }
        guard !due.isEmpty else { return ships }

        var updated = ships
        for ship in due {
            guard let offset = await fetchOffsetMinutes(shipKey: ship.key, appKey: appKey) else {
                continue    // unreachable; keep what we had
            }
            guard let at = updated.firstIndex(where: { $0.key == ship.key }) else { continue }
            updated[at] = WidgetSharedStore.Ship(
                key: ship.key,
                name: ship.name,
                short: ship.short,
                offsetMinutes: offset,
                fetchedAt: now.timeIntervalSince1970 * 1000,
                refreshUntil: ship.refreshUntil
            )
        }

        if updated != ships { WidgetSharedStore.saveShips(updated) }
        return updated
    }

    /// One `/time` request. Nil on any failure, including a malformed response.
    ///
    /// `shipKey` is "brand/code" — the same identity the web layer stores — so
    /// the brand goes into the path rather than relying on the `all` segment,
    /// which works today but is not ours to depend on.
    private static func fetchOffsetMinutes(shipKey: String, appKey: String) async -> Int? {
        let parts = shipKey.split(separator: "/")
        guard parts.count == 2 else { return nil }
        let (brand, code) = (String(parts[0]), String(parts[1]))

        guard let url = URL(string:
            "https://api.rccl.com/en/\(brand)/mobile/v3/ships/\(code)/time") else { return nil }

        var request = URLRequest(url: url, timeoutInterval: 12)
        request.setValue(appKey, forHTTPHeaderField: "appkey")
        request.setValue("application/json", forHTTPHeaderField: "accept")
        request.setValue("ios", forHTTPHeaderField: "platform")

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            guard let payload = json?["payload"] as? [String: Any],
                  let hours = payload["utcTimezoneOffset"] as? Double else { return nil }
            return Int((hours * 60).rounded())
        } catch {
            return nil
        }
    }
}

// Equatable so a refresh that changed nothing does not rewrite the store, which
// would reload every timeline for no reason.
extension WidgetSharedStore.Ship: Equatable {
    static func == (a: WidgetSharedStore.Ship, b: WidgetSharedStore.Ship) -> Bool {
        a.key == b.key && a.name == b.name && a.short == b.short
            && a.offsetMinutes == b.offsetMinutes && a.fetchedAt == b.fetchedAt
            && a.refreshUntil == b.refreshUntil
    }
}
