import XCTest
@testable import SecureTestCore

/// James, 2026-08-28 (follow-up to finding 8.5): the offline page carries a
/// standing notice under the heading, because MC / short-text / essay answers
/// have no status label of their own and would otherwise show no offline
/// signal at all. The server page is untouched.
final class RendererOfflineNoticeTests: XCTestCase {
    private func harness(offline: Bool) throws -> RendererHarness {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/delivery-bundle.json")
        return try RendererHarness(
            bundleJSON: try String(contentsOf: url, encoding: .utf8),
            offline: offline
        )
    }

    func testTheOfflinePageOpensWithTheNotice() throws {
        let h = try harness(offline: true)
        XCTAssertEqual(try h.string("__root.children[0].className"), "offline-notice")
        XCTAssertEqual(
            try h.string("__root.children[0].textContent"),
            "Offline mode: answers are not saved to a server."
        )
        XCTAssertEqual(try h.int("__count('.offline-notice')"), 1)
    }

    func testTheServerPageHasNoNotice() throws {
        let h = try harness(offline: false)
        XCTAssertEqual(try h.int("__count('.offline-notice')"), 0)
        XCTAssertEqual(try h.string("__root.children[0].className"), "item")
    }
}
