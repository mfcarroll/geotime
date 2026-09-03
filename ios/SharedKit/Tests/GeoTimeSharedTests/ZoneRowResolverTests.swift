import Foundation
import XCTest
@testable import GeoTimeShared

// Characterisation of ZoneRowResolver AS IT STANDS, written before the change
// that re-bases offsets on ship time while aboard.
//
// WHY THESE EXIST
//
// That change swaps one variable — `localOffset` — which every relative label
// in the widget is measured from, and which two other rules also key off (the
// agreeing-ship fold, and the stored-zone dedup). Nothing about getting it
// wrong looks wrong: a mis-based offset is a well-formed number beside a
// well-formed label. There is no crash and no broken pixel to notice, on a
// surface that is only ever glanced at. That is the whole argument for pinning
// the behaviour down first.
//
// HOW THEY ARE ORGANISED
//
// `Invariants` is the part that must NOT move. Everything here is ashore, and
// ashore is not what the change is about — so any diff in this file after the
// change is a regression, not progress. This is the net.
//
// `Properties` is the part that must hold in both worlds, before and after.
// These are where the real hazard lives: the risk identified in
// docs/next-version.md is that the anchor row loses the label naming what
// everything else is measured from, and a label is either present or it is not
// at every input — which is a property, not a case. A fixed set of examples
// would only catch it at the examples chosen.
//
// The third tier — the aboard matrix — is deliberately absent. It cannot be
// written yet: `resolve` has no aboard parameter, so there is no signature to
// write it against. See the end of this file for the cases it owes.

final class ZoneRowResolverInvariants: XCTestCase {

    // MARK: the base row

    func testBaseRowIsAlwaysPresentAndAnchorsTheList() throws {
        let rows = ZoneRowResolver.resolve(
            storedIds: [], local: Fixture.newYork, deviceTz: Fixture.newYork, now: Fixture.now)

        XCTAssertEqual(rows.count, 1)
        let base = rows[0]
        XCTAssertTrue(base.isLocal)
        XCTAssertFalse(base.isDevice)
        XCTAssertFalse(base.isShip)
        XCTAssertEqual(base.relativeText, "Local time")
        XCTAssertEqual(base.offsetSeconds, Fixture.newYork.secondsFromGMT(for: Fixture.now))
        assertLooksLikeAClock(base)
    }

    func testBaseRowPrefersThePlaceNameOverTheZoneName() throws {
        let rows = ZoneRowResolver.resolve(
            storedIds: [], local: Fixture.newYork, deviceTz: Fixture.newYork, now: Fixture.now,
            localPlaceName: "Brooklyn")

        XCTAssertEqual(rows[0].name, "Brooklyn")
    }

    // MARK: the device row

    func testDeviceRowIsHiddenWhenItAgreesWithTheBase() throws {
        // Same offset, different identifier — the row is suppressed on offset,
        // not on identity, which is the point of the rule.
        let rows = ZoneRowResolver.resolve(
            storedIds: [], local: Fixture.vancouver,
            deviceTz: TimeZone(identifier: "America/Los_Angeles")!, now: Fixture.now)

        XCTAssertEqual(rows.filter(\.isDevice).count, 0)
    }

    func testDeviceRowAppearsWhenItDisagreesAndIsMeasuredFromTheBase() throws {
        // Phone still on Vancouver time while the GPS says New York.
        let rows = ZoneRowResolver.resolve(
            storedIds: [], local: Fixture.newYork, deviceTz: Fixture.vancouver, now: Fixture.now)

        let device = try XCTUnwrap(rows.first(where: \.isDevice))
        XCTAssertEqual(device.relativeText, "\u{2212}3 hrs")
        XCTAssertTrue(device.id.hasPrefix("device:"))
    }

    // MARK: stored zones

    func testStoredZonesAreMeasuredFromTheBase() throws {
        let rows = ZoneRowResolver.resolve(
            storedIds: ["Europe/London", "Asia/Tokyo"],
            local: Fixture.newYork, deviceTz: Fixture.newYork, now: Fixture.now)

        XCTAssertEqual(try row(rows, named: "London").relativeText, "+5 hrs")
        XCTAssertEqual(try row(rows, named: "Tokyo").relativeText, "+13 hrs")
    }

    func testTheBaseZoneIsNeverRepeatedAsAStoredRow() throws {
        let rows = ZoneRowResolver.resolve(
            storedIds: ["America/New_York"],
            local: Fixture.newYork, deviceTz: Fixture.newYork, now: Fixture.now)

        XCTAssertEqual(rows.count, 1)
        XCTAssertTrue(rows[0].isLocal)
    }

    func testOnlyOneOfTwoZonesSharingAnOffsetIsShown() throws {
        // CHANGED, deliberately. Vancouver and Los Angeles read the same today,
        // and on a surface this small a second copy of a time buys nothing —
        // the app itself still lists both, which is where the complete answer
        // lives. In November they diverge and both appear, which is not a
        // glitch: that is the day the distinction starts meaning something.
        let rows = ZoneRowResolver.resolve(
            storedIds: ["America/Vancouver", "America/Los_Angeles"],
            local: Fixture.newYork, deviceTz: Fixture.newYork, now: Fixture.now)

        XCTAssertEqual(rows.filter { !$0.isLocal }.count, 1)
    }

    func testAChosenLabelWinsOverTheZoneName() throws {
        let rows = ZoneRowResolver.resolve(
            storedIds: ["Europe/London"], local: Fixture.newYork, deviceTz: Fixture.newYork,
            now: Fixture.now, labels: ["Home"])

        XCTAssertNotNil(rows.first { $0.name == "Home" })
    }

    // MARK: ships

    func testADisagreeingShipGetsItsOwnRowMeasuredFromTheBase() throws {
        let star = Fixture.ship("R/ST", "Star of the Seas", offsetHours: -5, short: "Star")
        let rows = ZoneRowResolver.resolve(
            storedIds: [], local: Fixture.newYork, deviceTz: Fixture.newYork, now: Fixture.now,
            ships: [star])

        let ship = try XCTUnwrap(rows.first(where: \.isShip))
        XCTAssertFalse(ship.isLocal, "a disagreeing ship is its own row, not the base")
        XCTAssertEqual(ship.name, "Star of the Seas")
        XCTAssertEqual(ship.shortName, "Star")
        XCTAssertEqual(ship.relativeText, "\u{2212}1 hr")
    }

    /// CHANGED, and this is the consequence worth having in front of you.
    ///
    /// A ship is not a timezone, so it is outside the no-repeated-clocks rule in
    /// both directions: a saved city never hides it, and it never hides a saved
    /// city. Docked in your own home port the two read the same hour and mean
    /// different things — one is where you live, the other is the thing you are
    /// about to board.
    ///
    /// Note what the OLD fold did with this exact case, which was worse than
    /// either dropping or showing it. The ship's name did not join your row, it
    /// REPLACED your place name — `agreeingShip?.name ?? localPlaceName` — so
    /// standing in Vancouver you saw "Star of the Seas" under a pin and no
    /// Vancouver at all, silently, since the matching clocks made the time right
    /// either way.
    func testYourPortYourShipAndACitySharingTheirClockAllResolveSensibly() throws {
        // In Vancouver, San Francisco saved, and a ship docked alongside.
        let ship = Fixture.ship("R/ST", "Star of the Seas", offsetHours: -7, short: "Star")
        let rows = ZoneRowResolver.resolve(
            storedIds: ["America/Los_Angeles"],
            local: Fixture.vancouver, deviceTz: Fixture.vancouver, now: Fixture.now,
            localPlaceName: "Vancouver", ships: [ship])

        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(try row(rows, named: "Vancouver").relativeText, "Local time")
        XCTAssertEqual(try row(rows, named: "Star of the Seas").relativeText, "+0 hrs")
        XCTAssertNil(rows.first { $0.name == "Los Angeles" },
                     "the city folds — where you actually are wins the slot")
    }

    func testAshoreAShipOnADifferentClockStillGetsItsRow() throws {
        let star = Fixture.ship("R/ST", "Star of the Seas", offsetHours: -5, short: "Star")
        let rows = ZoneRowResolver.resolve(
            storedIds: [], local: Fixture.newYork, deviceTz: Fixture.newYork, now: Fixture.now,
            localPlaceName: "Brooklyn", ships: [star])

        XCTAssertEqual(try row(rows, named: "Star of the Seas").relativeText, "\u{2212}1 hr")
    }

    // MARK: order

    func testRowsAreSortedByOffsetThenName() throws {
        let rows = ZoneRowResolver.resolve(
            storedIds: ["Asia/Tokyo", "Europe/London", "America/Vancouver"],
            local: Fixture.newYork, deviceTz: Fixture.newYork, now: Fixture.now)

        let offsets = rows.map(\.offsetSeconds)
        XCTAssertEqual(offsets, offsets.sorted())
    }

    // MARK: fit()

    func testFitKeepsEverySpecialRowAndReportsTheRest() throws {
        let star = Fixture.ship("R/ST", "Star of the Seas", offsetHours: -5)
        let rows = ZoneRowResolver.resolve(
            storedIds: ["Asia/Tokyo", "Europe/London", "Europe/Paris", "Asia/Kolkata"],
            local: Fixture.newYork, deviceTz: Fixture.vancouver, now: Fixture.now,
            ships: [star])

        let (visible, overflow) = ZoneRowResolver.fit(rows, maxRows: 3)
        XCTAssertEqual(visible.count + overflow, rows.count, "nothing is lost, only hidden")
        XCTAssertTrue(visible.contains(where: \.isLocal))
        XCTAssertTrue(visible.contains(where: \.isDevice))
        XCTAssertTrue(visible.contains(where: \.isShip))
    }

    func testFitIsANoOpWhenEverythingAlreadyFits() throws {
        let rows = ZoneRowResolver.resolve(
            storedIds: ["Europe/London"],
            local: Fixture.newYork, deviceTz: Fixture.newYork, now: Fixture.now)

        let (visible, overflow) = ZoneRowResolver.fit(rows, maxRows: 8)
        XCTAssertEqual(overflow, 0)
        XCTAssertEqual(visible.count, rows.count)
    }
}

// Things that must be true of ANY row set, before the change and after it.
//
// Run over a spread of inputs rather than one, because the value of a property
// is that it does not depend on the example — which is exactly what a table of
// golden outputs cannot give you.
final class ZoneRowResolverProperties: XCTestCase {

    private struct Case {
        let name: String
        let stored: [String]
        let local: TimeZone
        let device: TimeZone
        let ships: [WidgetSharedStore.Ship]
        var aboard: String? = nil
    }

    private var cases: [Case] {
        let star = Fixture.ship("R/ST", "Star of the Seas", offsetHours: -5, short: "Star")
        let agreeing = Fixture.ship("R/AG", "Agreeing of the Seas", offsetHours: -4)
        return [
            Case(name: "bare", stored: [], local: Fixture.newYork, device: Fixture.newYork, ships: []),
            Case(name: "zones only", stored: ["Europe/London", "Asia/Tokyo"],
                 local: Fixture.newYork, device: Fixture.newYork, ships: []),
            Case(name: "device differs", stored: ["Europe/London"],
                 local: Fixture.newYork, device: Fixture.vancouver, ships: []),
            Case(name: "ship differs", stored: ["Europe/London"],
                 local: Fixture.newYork, device: Fixture.newYork, ships: [star]),
            Case(name: "ship agrees", stored: ["Europe/London"],
                 local: Fixture.newYork, device: Fixture.newYork, ships: [agreeing]),
            Case(name: "everything at once", stored: ["Europe/London", "Asia/Tokyo", "Europe/Paris"],
                 local: Fixture.newYork, device: Fixture.vancouver, ships: [star, agreeing]),
            Case(name: "base is a ship's zone", stored: [],
                 local: TimeZone(secondsFromGMT: -5 * 3600)!, device: Fixture.vancouver, ships: [star]),

            // Aboard. These are why the properties are stated against `isAnchor`
            // rather than `isLocal`: the two are the same row ashore and are not
            // aboard, and a property that only held in one world would be worth
            // nothing on the day the other one arrived.
            Case(name: "aboard, ship differs", stored: ["Europe/London", "Asia/Tokyo"],
                 local: Fixture.newYork, device: Fixture.newYork, ships: [star], aboard: "R/ST"),
            Case(name: "aboard, ship agrees", stored: ["Europe/London"],
                 local: Fixture.newYork, device: Fixture.newYork, ships: [agreeing], aboard: "R/AG"),
            Case(name: "aboard, device adrift too", stored: ["Europe/London"],
                 local: Fixture.newYork, device: Fixture.vancouver, ships: [star], aboard: "R/ST"),
            Case(name: "aboard, two ships", stored: [],
                 local: Fixture.newYork, device: Fixture.newYork, ships: [star, agreeing], aboard: "R/ST"),
            Case(name: "aboard, ship not present", stored: ["Europe/London"],
                 local: Fixture.newYork, device: Fixture.newYork, ships: [star], aboard: "R/GHOST"),
        ]
    }

    private func each(_ body: (String, [WidgetRow]) throws -> Void) rethrows {
        for c in cases {
            let rows = ZoneRowResolver.resolve(
                storedIds: c.stored, local: c.local, deviceTz: c.device, now: Fixture.now,
                localPlaceName: nil, labels: [], ships: c.ships, aboardShipKey: c.aboard)
            try body(c.name, rows)
        }
    }

    func testExactlyOneRowIsTheAnchor() throws {
        try each { name, rows in
            XCTAssertEqual(rows.filter(\.isAnchor).count, 1, "\(name): the list needs exactly one anchor")
        }
    }

    /// And exactly one row is the ground, always — aboard or not, you are
    /// somewhere. Aboard, this is a different row from the anchor.
    func testExactlyOneRowIsTheGround() throws {
        try each { name, rows in
            XCTAssertEqual(rows.filter(\.isLocal).count, 1, "\(name): the list needs exactly one pin")
        }
    }

    /// The hazard from docs/next-version.md, as a property.
    ///
    /// Every relative label is measured from the anchor, so the anchor must say
    /// what it is. Today that is always the constant "Local time"; after the
    /// change it becomes "Ship time" while aboard. Either way it must never be
    /// blank, at any input — which is the part a table of examples cannot
    /// promise, because it only ever speaks for the examples in it.
    func testTheAnchorAlwaysNamesItself() throws {
        try each { name, rows in
            let anchor = rows.first { $0.isAnchor }
            XCTAssertNotNil(anchor, "\(name)")
            XCTAssertFalse(anchor?.relativeText.isEmpty ?? true,
                           "\(name): the anchor must state what everything else is relative to")
        }
    }

    func testEveryRowStatesItsRelationToTheAnchor() throws {
        try each { name, rows in
            for r in rows {
                XCTAssertFalse(r.relativeText.isEmpty, "\(name): \(r.name) said nothing")
            }
        }
    }

    func testTheAnchorsOwnOffsetIsTheBaseline() throws {
        try each { name, rows in
            let anchor = try XCTUnwrap(rows.first { $0.isAnchor }, "\(name)")
            for r in rows where !r.isAnchor {
                let expected = TimezoneDisplay.relativeOffset(
                    zoneSeconds: r.offsetSeconds, deviceSeconds: anchor.offsetSeconds)
                XCTAssertEqual(r.relativeText, expected,
                               "\(name): \(r.name) is not measured from the anchor")
            }
        }
    }

    func testNoRowAppearsTwice() throws {
        try each { name, rows in
            XCTAssertEqual(Set(rows.map(\.id)).count, rows.count, "\(name): duplicate row id")
        }
    }

    /// A detected ship appears once, never twice — the fold must not also leave
    /// the ship in the trailing loop.
    func testAShipIsNeverListedTwice() throws {
        try each { name, rows in
            let shipNames = rows.filter(\.isShip).map(\.name)
            XCTAssertEqual(Set(shipNames).count, shipNames.count, "\(name): ship listed twice")
        }
    }

    func testRowsComeOutSorted() throws {
        try each { name, rows in
            XCTAssertEqual(rows.map(\.offsetSeconds), rows.map(\.offsetSeconds).sorted(), "\(name)")
        }
    }

    func testEveryRowCarriesAReadableClock() throws {
        try each { name, rows in
            for r in rows { assertLooksLikeAClock(r, "\(name): \(r.name)") }
        }
    }

    /// fit() may hide ordinary zones. It may never hide a special row, and it
    /// must always account for what it hid.
    func testFitNeverDropsASpecialRow() throws {
        try each { name, rows in
            for maxRows in 1...max(1, rows.count) {
                let (visible, overflow) = ZoneRowResolver.fit(rows, maxRows: maxRows)
                XCTAssertEqual(visible.count + overflow, rows.count, "\(name)@\(maxRows)")
                let specialsIn = rows.filter { $0.isLocal || $0.isDevice || $0.isShip }.count
                let specialsOut = visible.filter { $0.isLocal || $0.isDevice || $0.isShip }.count
                XCTAssertEqual(specialsIn, specialsOut, "\(name)@\(maxRows): a special row was hidden")
                XCTAssertEqual(visible.map(\.offsetSeconds), visible.map(\.offsetSeconds).sorted(),
                               "\(name)@\(maxRows): fit returned an unsorted list")
            }
        }
    }
}

// MARK: - What this suite still owes
//
// The aboard matrix cannot be written against today's signature: `resolve` takes
// no aboard flag, so there is nothing to assert on. When it gains one, these are
// the cases, and they are a SPEC — the expected values come from the design in
// docs/next-version.md, not from whatever the code first produces:
//
//   1. aboard, ship differs from GPS zone
//        the ship row is the anchor and reads "Ship time"
//        the GPS row becomes an ordinary row measured from the ship
//        the device row is measured from the ship
//   2. aboard, ship agrees with GPS zone
//        one merged row, and it is labelled "Ship time", NOT "Local time"
//        (today's fold keeps "Local time" — see the invariant above, which is
//        the one assertion in Invariants expected to change)
//   3. aboard, a stored zone matches the ship's offset
//        the dedup now keys off the ship, so a different zone drops out than
//        would have dropped out ashore
//   4. ashore, every case above
//        byte-identical to the invariants in this file
//   5. two ships aboard
//        only the detected one anchors; the other is an ordinary ship row
//   6. aboard, ship offset unresolved
//        must fall back to the GPS zone rather than anchoring on nothing
//
// The property suite above needs no change for any of it, which is the point:
// after the swap, `testTheAnchorsOwnOffsetIsTheBaseline` proves the whole list
// re-based together, and `testTheAnchorAlwaysNamesItself` proves the label that
// makes the re-basing legible did not go missing.
