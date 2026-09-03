import Foundation
import XCTest
@testable import GeoTimeShared

// The aboard matrix — a SPEC, not a characterisation.
//
// Every expected value here was written from the design in
// docs/next-version.md before the resolver was made to satisfy it, which is the
// only way these are worth anything: a test written from whatever the code
// happened to produce would agree with a bug as readily as with a decision.
//
// THE DESIGN, IN ONE LINE
//
// Offsets are measured from the clock you are living by. Ashore that is the
// ground you stand on; aboard it is the ship. Absolute times never move.
//
// WHAT THIS FORCED OUT OF THE DESIGN
//
// Writing these is what showed `isLocal` had been doing two jobs. Ashore the
// GPS zone is both where you are and what everything is measured from, so one
// flag covered both and nobody noticed. Aboard they separate — the ship anchors
// the arithmetic while the GPS zone still marks the ground — and both facts
// still want saying on screen. Hence `isAnchor` alongside `isLocal`, and hence
// the GPS row keeping its pin while gaining an offset, exactly as the mockup
// had it:
//
//     Nelson    2:10 PM   −2 hrs
//     Star  🛳  4:10 PM   Ship time
//     Havana ↗  5:10 PM   +1 hr

final class AboardMatrixTests: XCTestCase {

    private let star = Fixture.ship("R/ST", "Star of the Seas", offsetHours: -5, short: "Star")

    // MARK: 1 — aboard, the ship's clock differs from the ground

    func testTheShipAnchorsAndSaysSo() throws {
        let rows = ZoneRowResolver.resolve(
            storedIds: [], local: Fixture.newYork, deviceTz: Fixture.newYork, now: Fixture.now,
            ships: [star], aboardShipKey: "R/ST")

        let anchor = try XCTUnwrap(rows.first(where: { $0.isAnchor }))
        XCTAssertTrue(anchor.isShip)
        XCTAssertFalse(anchor.isLocal, "the ship is not the ground")
        XCTAssertEqual(anchor.name, "Star of the Seas")
        XCTAssertEqual(anchor.relativeText, "Ship time")
    }

    func testTheGroundKeepsItsPinAndIsMeasuredFromTheShip() throws {
        let rows = ZoneRowResolver.resolve(
            storedIds: [], local: Fixture.newYork, deviceTz: Fixture.newYork, now: Fixture.now,
            ships: [star], aboardShipKey: "R/ST")

        let ground = try XCTUnwrap(rows.first(where: { $0.isLocal }))
        XCTAssertFalse(ground.isAnchor)
        XCTAssertEqual(ground.relativeText, "+1 hr", "New York is an hour ahead of the ship")
    }

    func testSavedCitiesAreMeasuredFromTheShipNotTheGround() throws {
        let rows = ZoneRowResolver.resolve(
            storedIds: ["Europe/London"], local: Fixture.newYork, deviceTz: Fixture.newYork,
            now: Fixture.now, ships: [star], aboardShipKey: "R/ST")

        // Ashore this reads "+5 hrs" against New York. Aboard it is six from the
        // ship, and if this still said five the whole list would be lying.
        XCTAssertEqual(try row(rows, named: "London").relativeText, "+6 hrs")
    }

    // MARK: 2 — aboard, the ship's clock matches the ground

    func testShipAndGroundStayApartEvenWhenTheirClocksAgree() throws {
        // In port on the port's time. Two rows saying the same hour, because
        // they are answering two different questions — "what is the ship
        // keeping" and "where am I standing" — and the second is exactly the
        // thing a guest checks before stepping off.
        let inStep = Fixture.ship("R/ST", "Star of the Seas", offsetHours: -4, short: "Star")
        let rows = ZoneRowResolver.resolve(
            storedIds: [], local: Fixture.newYork, deviceTz: Fixture.newYork, now: Fixture.now,
            localPlaceName: "Cozumel", ships: [inStep], aboardShipKey: "R/ST")

        XCTAssertEqual(rows.count, 2)
        let ship = try XCTUnwrap(rows.first(where: { $0.isShip }))
        let ground = try XCTUnwrap(rows.first(where: { $0.isLocal }))
        XCTAssertTrue(ship.isAnchor)
        XCTAssertEqual(ship.relativeText, "Ship time")
        XCTAssertEqual(ground.name, "Cozumel")
        XCTAssertEqual(ground.relativeText, "+0 hrs", "level with the ship, and says so")
        XCTAssertFalse(ground.isShip)
    }

    /// The one surviving merge, and the only case the old fold was ever really
    /// for. Mid-ocean there is no town within 150 km, so the ground has no name
    /// and its row would read "UTC−5" beside a ship showing the same time —
    /// a number keeping a name company for no reason. There, they merge, and
    /// the row carries both marks.
    func testTheGroundMergesIntoTheShipOnlyWhenItHasNoNameOfItsOwn() throws {
        let atSea = TimeZone(identifier: "Etc/GMT+5")!
        let inStep = Fixture.ship("R/ST", "Star of the Seas", offsetHours: -5, short: "Star")
        let rows = ZoneRowResolver.resolve(
            storedIds: [], local: atSea, deviceTz: atSea, now: Fixture.now,
            localPlaceName: nil, ships: [inStep], aboardShipKey: "R/ST")

        XCTAssertEqual(rows.count, 1)
        XCTAssertTrue(rows[0].isShip)
        XCTAssertTrue(rows[0].isLocal, "it carries the pin too")
        XCTAssertTrue(rows[0].isAnchor)
        XCTAssertEqual(rows[0].name, "Star of the Seas")
        XCTAssertEqual(rows[0].relativeText, "Ship time")
    }

    // MARK: 3 — a saved zone that happens to share the ship's clock

    func testASavedZoneOnTheShipsOwnClockIsDropped() throws {
        // Bogota keeps UTC−5 year round, which is this ship's clock. The widget
        // will not print the same hour twice; the app still lists Bogota.
        let rows = ZoneRowResolver.resolve(
            storedIds: ["America/Bogota"], local: Fixture.newYork, deviceTz: Fixture.newYork,
            now: Fixture.now, ships: [star], aboardShipKey: "R/ST")

        XCTAssertNil(rows.first { $0.name == "Bogota" })
    }

    // MARK: the phone — a row only when it agrees with neither

    func testThePhoneMarksTheShipRatherThanTakingOneOfItsOwn() throws {
        // Phone still on the ship's clock: nothing to report, so no row — but
        // the ship row wears the mark, which is what says the phone is right.
        let rows = ZoneRowResolver.resolve(
            storedIds: [], local: Fixture.newYork, deviceTz: TimeZone(secondsFromGMT: -5 * 3600)!,
            now: Fixture.now, localPlaceName: "Cozumel", ships: [star], aboardShipKey: "R/ST")

        XCTAssertNil(rows.first { $0.isDevice && !$0.isShip }, "no standalone phone row")
        XCTAssertTrue(try XCTUnwrap(rows.first(where: { $0.isShip })).isDevice)
    }

    func testThePhoneMarksTheGroundWhenItIsKeepingPortTime() throws {
        let rows = ZoneRowResolver.resolve(
            storedIds: [], local: Fixture.newYork, deviceTz: Fixture.newYork, now: Fixture.now,
            localPlaceName: "Cozumel", ships: [star], aboardShipKey: "R/ST")

        XCTAssertNil(rows.first { $0.isDevice && !$0.isLocal })
        XCTAssertTrue(try XCTUnwrap(rows.first(where: { $0.isLocal })).isDevice)
    }

    func testThePhoneGetsItsOwnRowWhenItAgreesWithNeither() throws {
        let rows = ZoneRowResolver.resolve(
            storedIds: [], local: Fixture.newYork, deviceTz: Fixture.vancouver, now: Fixture.now,
            localPlaceName: "Cozumel", ships: [star], aboardShipKey: "R/ST")

        let phone = try XCTUnwrap(rows.first(where: { $0.isDevice }))
        XCTAssertFalse(phone.isShip)
        XCTAssertFalse(phone.isLocal)
        XCTAssertEqual(phone.relativeText, "\u{2212}2 hrs", "measured from the ship")
    }

    func testAshoreAnAgreeingPhoneIsNotMarkedAtAll() throws {
        // The absence of a phone is the signal that nothing is wrong, and ashore
        // agreeing is the ordinary state. Marking every widget forever would say
        // nothing and cost a glyph.
        let rows = ZoneRowResolver.resolve(
            storedIds: [], local: Fixture.newYork, deviceTz: Fixture.newYork, now: Fixture.now,
            localPlaceName: "Brooklyn")

        XCTAssertEqual(rows.count, 1)
        XCTAssertFalse(rows[0].isDevice)
    }

    // MARK: what survives when space runs out

    func testTrimmingKeepsTheZonesNearestTheAnchor() throws {
        // The anchor is deliberately EAST of the saved cities, so that nearest
        // and first-in-offset-order are different answers. With the ship on
        // −5 they coincide and the test cannot tell the two rules apart — which
        // is how the first version of it passed against both.
        let farEast = Fixture.ship("R/ST", "Star of the Seas", offsetHours: 9, short: "Star")
        let rows = ZoneRowResolver.resolve(
            storedIds: ["Europe/London", "America/Vancouver"],
            local: Fixture.newYork, deviceTz: Fixture.newYork, now: Fixture.now,
            localPlaceName: "Cozumel", ships: [farEast], aboardShipKey: "R/ST")

        // Offsets: Vancouver −7, ground −4, London +1, ship +9.
        // First in order is Vancouver; nearest the anchor is London.
        let (visible, overflow) = ZoneRowResolver.fit(rows, maxRows: 3)
        XCTAssertEqual(overflow, 1)
        XCTAssertNotNil(visible.first { $0.name == "London" }, "nearest the anchor survives")
        XCTAssertNil(visible.first { $0.name == "Vancouver" }, "not merely the westernmost")
    }

    // MARK: 5 — more than one ship on the list

    func testOnlyTheShipUnderfootAnchors() throws {
        let other = Fixture.ship("R/OT", "Other of the Seas", offsetHours: -6)
        let rows = ZoneRowResolver.resolve(
            storedIds: [], local: Fixture.newYork, deviceTz: Fixture.newYork, now: Fixture.now,
            ships: [star, other], aboardShipKey: "R/ST")

        XCTAssertEqual(rows.filter(\.isAnchor).count, 1)
        XCTAssertEqual(try row(rows, named: "Star of the Seas").relativeText, "Ship time")
        XCTAssertEqual(try row(rows, named: "Other of the Seas").relativeText, "\u{2212}1 hr",
                       "the other ship is just another clock, measured from this one")
    }

    // MARK: 6 — aboard, but the ship's offset has never resolved

    func testAnUnresolvedShipFallsBackToTheGroundRatherThanAnchoringOnNothing() throws {
        // A ship whose offset never resolved is filtered out before it reaches
        // the widget, so the key can name a ship that is simply not here. The
        // list must still be measured from something.
        let rows = ZoneRowResolver.resolve(
            storedIds: ["Europe/London"], local: Fixture.newYork, deviceTz: Fixture.newYork,
            now: Fixture.now, ships: [star], aboardShipKey: "R/GHOST")

        let anchor = try XCTUnwrap(rows.first(where: { $0.isAnchor }))
        XCTAssertTrue(anchor.isLocal)
        XCTAssertEqual(anchor.relativeText, "Local time")
        XCTAssertEqual(try row(rows, named: "London").relativeText, "+5 hrs",
                       "identical to ashore — falling back means falling all the way back")
    }

    // MARK: 4 — ashore is untouched

    func testAshoreIsUnchangedByTheParameterExisting() throws {
        let ashore = ZoneRowResolver.resolve(
            storedIds: ["Europe/London", "Asia/Tokyo"], local: Fixture.newYork,
            deviceTz: Fixture.vancouver, now: Fixture.now, ships: [star])
        let explicitlyAshore = ZoneRowResolver.resolve(
            storedIds: ["Europe/London", "Asia/Tokyo"], local: Fixture.newYork,
            deviceTz: Fixture.vancouver, now: Fixture.now, ships: [star], aboardShipKey: nil)

        XCTAssertEqual(ashore.map(\.relativeText), explicitlyAshore.map(\.relativeText))
        XCTAssertEqual(ashore.map(\.name), explicitlyAshore.map(\.name))
        XCTAssertTrue(try XCTUnwrap(ashore.first(where: { $0.isAnchor })).isLocal)
    }

    // MARK: the calendar day follows the anchor too

    func testTheDayDifferenceIsMeasuredFromTheShip() throws {
        // Tokyo is already on the next day from either clock here; the point is
        // that the comparison is made against the anchor, so a ship that has
        // shifted its clock across midnight changes which rows carry a weekday.
        let rows = ZoneRowResolver.resolve(
            storedIds: ["Asia/Tokyo"], local: Fixture.newYork, deviceTz: Fixture.newYork,
            now: Fixture.now, ships: [star], aboardShipKey: "R/ST")

        XCTAssertNotNil(try row(rows, named: "Tokyo").weekdayShort)
    }
}

// MARK: - Settled, and worth keeping visible
//
// Both of these were open questions while the resolver still gated everything
// on the anchor alone. The ten-rule model answered them, and the answers are
// asserted here so a change of mind fails a test rather than drifting.
//
//   Q: should the phone still take a row when it matches the ground but not the
//      ship?  A: no — rule 6. It marks the row it agrees with instead, which is
//      covered by the three phone tests above.
//   Q: should the ground row say more than a bare offset once it stops being
//      the anchor?  A: no — rule 10. Asserted below.

final class SettledByTheTenRules: XCTestCase {

    private let star = Fixture.ship("R/ST", "Star of the Seas", offsetHours: -5, short: "Star")

    /// Aboard, the ground is an ordinary distance from the clock you are keeping
    /// and says so in the same words every other row uses. The pin is what marks
    /// it as the place you are standing.
    func testTheGroundRowSaysOnlyItsOffset() throws {
        let rows = ZoneRowResolver.resolve(
            storedIds: [], local: Fixture.newYork, deviceTz: Fixture.vancouver, now: Fixture.now,
            localPlaceName: "Cozumel", ships: [star], aboardShipKey: "R/ST")

        let ground = try XCTUnwrap(rows.first(where: { $0.isLocal }))
        XCTAssertEqual(ground.relativeText, "+1 hr")
        XCTAssertFalse(ground.isAnchor)
    }

    /// And the phone, when it disagrees with both, is measured from the anchor
    /// like everything else rather than from the ground it happens to be near.
    func testAStandalonePhoneRowIsMeasuredFromTheAnchor() throws {
        let rows = ZoneRowResolver.resolve(
            storedIds: [], local: Fixture.newYork, deviceTz: Fixture.vancouver, now: Fixture.now,
            localPlaceName: "Cozumel", ships: [star], aboardShipKey: "R/ST")

        let phone = try XCTUnwrap(rows.first(where: { $0.isDevice }))
        XCTAssertFalse(phone.isLocal)
        XCTAssertEqual(phone.relativeText, "\u{2212}2 hrs")
    }
}
