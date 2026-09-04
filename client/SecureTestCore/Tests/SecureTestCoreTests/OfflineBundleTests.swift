import XCTest
@testable import SecureTestCore

/// The offline-bundle rules the app target runs on: how `--bundle` is read,
/// when File → Open Test Bundle… is allowed, and what a pick turns into. The
/// open panel itself is hand-run (MANUAL-CHECKS, "File → Open Test Bundle").
final class OfflineBundleTests: XCTestCase {
    private func fixtureData() throws -> Data {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/delivery-bundle.json")
        return try Data(contentsOf: url)
    }

    // MARK: --bundle <path>

    func testArgumentPathReadsTheValueAfterTheFlag() {
        XCTAssertEqual(
            OfflineBundle.argumentPath(in: ["SecureTest", "--bundle", "/tmp/a b.json"]),
            "/tmp/a b.json"
        )
    }

    func testArgumentPathIsNilWithoutTheFlag() {
        XCTAssertNil(OfflineBundle.argumentPath(in: ["SecureTest"]))
        XCTAssertNil(OfflineBundle.argumentPath(in: ["SecureTest", "--token", "jwt"]))
    }

    func testArgumentPathIsNilWhenTheFlagDangles() {
        XCTAssertNil(OfflineBundle.argumentPath(in: ["SecureTest", "--bundle"]))
    }

    func testArgumentPathTakesTheFirstFlag() {
        XCTAssertEqual(
            OfflineBundle.argumentPath(in: ["x", "--bundle", "one.json", "--bundle", "two.json"]),
            "one.json"
        )
    }

    // MARK: when File → Open is allowed

    func testOpenIsAllowedOnTheEntryScreen() {
        XCTAssertTrue(OfflineBundle.canOpen(on: .entry))
    }

    func testOpenIsAllowedOverAnOfflineBundle() {
        XCTAssertTrue(OfflineBundle.canOpen(on: .offlineBundle))
    }

    /// The rule the slice exists to keep: a server-delivered attempt on screen
    /// — locked or not, handed in or not — can never be replaced by a file.
    func testOpenIsRefusedWhileAServerAttemptIsOnScreen() {
        XCTAssertFalse(OfflineBundle.canOpen(on: .serverAttempt))
    }

    func testThePanelOffersOnlyJSON() {
        XCTAssertEqual(OfflineBundle.fileExtension, "json")
    }

    // MARK: what a pick becomes

    func testLoadDecodesTheFixtureAndKeepsTheBytesVerbatim() throws {
        let data = try fixtureData()
        let loaded = try OfflineBundle.load(data)
        XCTAssertEqual(loaded.bundle, try DeliveryBundle.decode(from: data))
        XCTAssertEqual(loaded.bundle.items.count, 9)
        XCTAssertEqual(loaded.json, String(decoding: data, as: UTF8.self))
    }

    func testLoadRefusesJSONThatIsNotABundle() {
        let data = Data(#"{"hello": "world"}"#.utf8)
        XCTAssertThrowsError(try OfflineBundle.load(data)) { error in
            XCTAssertTrue(error is DecodingError, "expected DecodingError, got \(error)")
        }
    }

    func testLoadRefusesBytesThatAreNotText() {
        let data = Data([0xFF, 0xFE, 0x00, 0x80])
        XCTAssertThrowsError(try OfflineBundle.load(data)) { error in
            XCTAssertEqual(error as? OfflineBundle.LoadError, .notText)
        }
    }
}
