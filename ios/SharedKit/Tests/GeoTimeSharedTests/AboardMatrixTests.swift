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

    func testAnAgreeingShipMergesAndTheMergedRowIsLabelledForTheShip() throws {
        let inStep = Fixture.ship("R/ST", "Star of the Seas", offsetHours: -4, short: "Star")
        let rows = ZoneRowResolver.resolve(
            storedIds: [], local: Fixture.newYork, deviceTz: Fixture.newYork, now: Fixture.now,
            ships: [inStep], aboardShipKey: "R/ST")

        XCTAssertEqual(rows.count, 1, "one row, not two — the fold still applies")
        let merged = rows[0]
        XCTAssertTrue(merged.isLocal)
        XCTAssertTrue(merged.isShip)
        XCTAssertTrue(merged.isAnchor)
        XCTAssertEqual(merged.name, "Star of the Seas")
        // This is THE assertion that differs from the ashore invariant of the
        // same shape. Ashore the merged row says "Local time"; aboard it must
        // say "Ship time", because that is what the offsets below it are
        // measured from and nothing else on screen says so.
        XCTAssertEqual(merged.relativeText, "Ship time")
    }

    // MARK: 3 — a saved zone that happens to share the ship's clock

    func testAZoneSharingTheShipsOffsetReadsAsZeroRatherThanVanishing() throws {
        // Bogota keeps UTC−5 year round, which is the ship's clock here. Saved
        // zones are deduped by identifier and never by offset — if the user
        // added it, the user asked for it — so it stays, reading level.
        let rows = ZoneRowResolver.resolve(
            storedIds: ["America/Bogota"], local: Fixture.newYork, deviceTz: Fixture.newYork,
            now: Fixture.now, ships: [star], aboardShipKey: "R/ST")

        XCTAssertEqual(try row(rows, named: "Bogota").relativeText, "+0 hrs")
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

// MARK: - Open questions this matrix exposed
//
// Both are live design decisions, not defects. They are written as tests so the
// current answer is visible and a change of mind shows up as a failing test
// rather than as a silent drift.

final class AboardOpenQuestions: XCTestCase {

    private let star = Fixture.ship("R/ST", "Star of the Seas", offsetHours: -5, short: "Star")

    /// QUESTION 1 — should the device row still appear when it agrees with the
    /// ground but not with the ship?
    ///
    /// Ashore, the device row is hidden when it matches the anchor, because
    /// knowing your phone concurs is not worth a row. Aboard, "matches the
    /// anchor" means matches the SHIP — so a phone still on the port's time now
    /// earns a row, and that row carries the same number as the pin row beside
    /// it. Two rows, one figure, different marks.
    ///
    /// CURRENT ANSWER: shown. It keeps the resolver's "ONE RULE for every
    /// special row" intact — everything is gated against the anchor, with no
    /// second rule to drift from Android.
    ///
    /// THE CASE AGAINST: it is visibly redundant on the smallest surface the app
    /// has. Gating the device row against the ground instead would hide it, at
    /// the cost of that row meaning something different from every other.
    func testDeviceRowAppearsEvenWhenItMatchesTheGround() throws {
        let rows = ZoneRowResolver.resolve(
            storedIds: [], local: Fixture.newYork, deviceTz: Fixture.newYork, now: Fixture.now,
            ships: [star], aboardShipKey: "R/ST")

        let device = try XCTUnwrap(rows.first(where: { $0.isDevice }), "currently shown")
        let ground = try XCTUnwrap(rows.first(where: { $0.isLocal }))
        XCTAssertEqual(device.relativeText, ground.relativeText,
                       "and it says exactly what the pin row says — this is the redundancy")
    }

    /// QUESTION 2 — should the ground row say more than a bare offset?
    ///
    /// Ashore it reads "Local time". Aboard it reads "+1 hr" and the only thing
    /// still marking it as where you are is the pin. On a row that has just
    /// stopped being the anchor, a bare number may be too quiet.
    ///
    /// CURRENT ANSWER: bare offset, pin carries the meaning — which is what the
    /// mockup showed (`Havana ↗ 5:10 PM +1 hr`).
    ///
    /// THE CASE AGAINST: the pin is the smallest thing on the row, and the one
    /// most likely to be dropped first when the widget runs out of width.
    func testTheGroundRowSaysOnlyItsOffset() throws {
        let rows = ZoneRowResolver.resolve(
            storedIds: [], local: Fixture.newYork, deviceTz: Fixture.newYork, now: Fixture.now,
            ships: [star], aboardShipKey: "R/ST")

        XCTAssertEqual(try XCTUnwrap(rows.first(where: { $0.isLocal })).relativeText, "+1 hr")
    }
}
