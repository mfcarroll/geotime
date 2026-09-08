import Foundation
import XCTest
@testable import GeoTimeShared

// Somebody else's clock, on the widget.
//
// The rules a person row obeys are almost all rules something else already
// obeyed — a name against a clock, measured from the anchor, sorted by offset.
// What is new is the two places a person is deliberately NOT like a saved city:
// they are exempt from the fold that collapses two rows showing one hour, and
// their identity is a share id rather than anything you can read off the row.
//
// Both of those are invisible when they break. A person folded into a city
// looks like a widget with one fewer row on it, and two people sharing an id
// looks like one of them drawn twice — which is exactly the failure the ground
// row hit in 1.7.0, found only because somebody stared at a screenshot.
final class PersonRowTests: XCTestCase {

    private func rows(_ people: [WidgetSharedStore.Person],
                      storedIds: [String] = [],
                      labels: [String] = [],
                      ships: [WidgetSharedStore.Ship] = [],
                      aboard: String? = nil) -> [WidgetRow] {
        ZoneRowResolver.resolve(storedIds: storedIds, local: Fixture.vancouver,
                                deviceTz: Fixture.vancouver, now: Fixture.now,
                                localPlaceName: "Nelson", labels: labels,
                                ships: ships, people: people, aboardShipKey: aboard)
    }

    // MARK: a person is a row

    func testAPersonAshoreDrawsTheirOwnZonesClock() throws {
        let row = try XCTUnwrap(rows([Fixture.personAshore("s1", "Dad", Fixture.tokyo)])
            .first { $0.name == "Dad" })

        XCTAssertTrue(row.isPerson)
        XCTAssertFalse(row.isShip, "a person ashore is not a vessel")
        XCTAssertEqual(row.offsetSeconds, Fixture.tokyo.secondsFromGMT(for: Fixture.now))
        assertLooksLikeAClock(row)
    }

    func testAPersonAboardDrawsTheClockTheCrewSet() throws {
        let row = try XCTUnwrap(rows([Fixture.personAboard("s1", "Sarah", offsetHours: -4,
                                                           short: "Wonder")])
            .first { $0.name == "Sarah" })

        XCTAssertTrue(row.isPerson)
        XCTAssertEqual(row.offsetSeconds, -4 * 3600)
        XCTAssertEqual(row.shortName, "Wonder", "for a row too tight for the full name")
    }

    func testTheirTimeIsMeasuredFromTheAnchorLikeEverythingElse() throws {
        // Vancouver is UTC-7 in September; Tokyo is UTC+9. Sixteen hours.
        let row = try XCTUnwrap(rows([Fixture.personAshore("s1", "Dad", Fixture.tokyo)])
            .first { $0.isPerson })

        XCTAssertEqual(row.relativeText,
                       TimezoneDisplay.relativeOffset(zoneSeconds: row.offsetSeconds,
                                                      deviceSeconds: -7 * 3600))
    }

    func testAboardAShipEverybodyIsMeasuredFromHerClock() throws {
        // The one thing resolve() decides. A follower aboard should read as an
        // offset from the ship you are living on, not from the ground below it.
        let ship = Fixture.ship("R/WN", "Wonder of the Seas", offsetHours: -4)
        let row = try XCTUnwrap(rows([Fixture.personAshore("s1", "Dad", Fixture.tokyo)],
                                     ships: [ship], aboard: "R/WN")
            .first { $0.isPerson })

        XCTAssertEqual(row.relativeText,
                       TimezoneDisplay.relativeOffset(zoneSeconds: row.offsetSeconds,
                                                      deviceSeconds: -4 * 3600))
    }

    // MARK: what a person is NOT

    func testAPersonIsNotFoldedIntoACityShowingTheSameHour() throws {
        // "Dad" and "Tokyo" at one time are two facts, and the one you cannot
        // get anywhere else is Dad. The fold that collapses two identically
        // drawn zones must never reach across to him.
        let drawn = rows([Fixture.personAshore("s1", "Dad", Fixture.tokyo)],
                         storedIds: ["Asia/Tokyo"], labels: [""])

        XCTAssertEqual(drawn.filter { $0.offsetSeconds == Fixture.tokyo.secondsFromGMT(for: Fixture.now) }.count, 2)
        XCTAssertTrue(drawn.contains { $0.isPerson && $0.name == "Dad" })
        XCTAssertTrue(drawn.contains { !$0.isPerson && $0.name == "Tokyo" })
    }

    func testAPersonNamedAfterTheirTownStillGetsTheirOwnRow() throws {
        // The harder half of the same rule: the fold keys on name AND hour, and
        // somebody who follows a friend they have named "Tokyo" would trip it.
        let drawn = rows([Fixture.personAshore("s1", "Tokyo", Fixture.tokyo)],
                         storedIds: ["Asia/Tokyo"], labels: [""])

        XCTAssertEqual(drawn.filter { $0.name.hasPrefix("Tokyo") }.count, 2)
    }

    func testTwoPeopleWithOneNameAreTwoRows() throws {
        // Identity is the share, never the name. Two ids that collide is the
        // 1.7.0 ground-row bug again: SwiftUI draws one of them twice.
        let drawn = rows([Fixture.personAshore("s1", "Mum", Fixture.tokyo),
                          Fixture.personAshore("s2", "Mum", Fixture.london)])

        XCTAssertEqual(drawn.filter { $0.isPerson }.count, 2)
        XCTAssertEqual(Set(drawn.map(\.id)).count, drawn.count, "every row id is distinct")
    }

    func testAPersonIsNeverTheAnchorOrTheGround() throws {
        // You are following them BECAUSE they are somewhere else.
        for row in rows([Fixture.personAshore("s1", "Dad", Fixture.vancouver)])
            .filter({ $0.isPerson }) {
            XCTAssertFalse(row.isAnchor)
            XCTAssertFalse(row.isLocal)
        }
    }

    // MARK: what never reaches a row

    func testARecordWithNoClockIsWithheldRatherThanDrawnAtUTC() throws {
        // The app already withholds anybody who has never pushed. This is the
        // widget refusing to render a store the app would not have written —
        // and a missing row is honest where midnight in Greenwich is a lie
        // about somebody's evening.
        let nothing = WidgetSharedStore.Person(key: "s1", name: "Tom", tz: nil,
                                               offsetMinutes: nil, short: nil)
        XCTAssertTrue(rows([nothing]).allSatisfy { !$0.isPerson })
    }

    func testAZoneIdNobodyCanResolveIsWithheldToo() throws {
        let bogus = WidgetSharedStore.Person(key: "s1", name: "Tom", tz: "America/Atlantis",
                                             offsetMinutes: nil, short: nil)
        XCTAssertTrue(rows([bogus]).allSatisfy { !$0.isPerson })
    }

    // MARK: reading a store an older build wrote

    func testAStoreWithNoPeopleInItDecodesToNoPeople() throws {
        // Every field after key and name is optional for this reason: one
        // missing field fails the WHOLE array, and every person would vanish at
        // once rather than one degrading.
        let json = #"[{"key":"s1","name":"Dad","tz":"Asia/Tokyo"}]"#
        let decoded = try JSONDecoder().decode([WidgetSharedStore.Person].self,
                                               from: Data(json.utf8))

        XCTAssertEqual(decoded.count, 1)
        XCTAssertEqual(decoded[0].shortOrFull, "Dad", "no short name falls back to the full one")
        XCTAssertNotNil(decoded[0].timeZone)
    }
}
