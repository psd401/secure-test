import XCTest
@testable import SecureTestCore

/// Time limit slice 2 (D-3): the countdown strip in the page.
///
/// The strip is markup and behaviour, so it is exercised through the JSC
/// harness rather than grepped for: that a bundle WITHOUT a deadline builds no
/// strip at all is as much of the contract as the strip itself.
final class RendererTimeLimitTests: XCTestCase {
    private static let items = #"[{"type":"essay","id":"e1","stem":"Write."}]"#

    private func harness(deadline: Bool) throws -> RendererHarness {
        let limit = deadline
            ? #","time_limit_ends_at":"2026-09-11T18:45:00.000Z","server_now":"2026-09-11T18:00:00.000Z""#
            : ""
        return try RendererHarness(
            bundleJSON: #"{"test_id":"t","title":"T","items":\#(Self.items)\#(limit)}"#
        )
    }

    func testNoStripAtAllWithoutADeadline() throws {
        let page = try harness(deadline: false)
        XCTAssertEqual(try page.int("__count('.time-limit')"), 0)
        XCTAssertTrue(try page.bool("typeof window.__timeLimit.update === 'function'"))
    }

    func testBuildsTheStripAboveEverythingElseWhenTheBundleCarriesADeadline() throws {
        let page = try harness(deadline: true)
        XCTAssertEqual(try page.int("__count('.time-limit')"), 1)
        // First child of the item root, so it survives every page turn — the
        // pages are appended after it.
        XCTAssertEqual(try page.string("__root.children[0].className"), "time-limit")
        XCTAssertEqual(try page.string("__first('.time-limit-label').textContent"), "Time left")
        XCTAssertEqual(
            try page.string("__first('.time-limit-hide').getAttribute('aria-label')"),
            "Hide the timer"
        )
        XCTAssertEqual(try page.string("__first('.time-limit').getAttribute('role')"), "status")
    }

    func testTheHostPushesTheRemainingTextAndTheDangerState() throws {
        let page = try harness(deadline: true)
        try page.eval("window.__timeLimit.update('42:17', false);")
        XCTAssertEqual(try page.string("__first('.time-limit-value').textContent"), "42:17")
        XCTAssertEqual(try page.string("__first('.time-limit').className"), "time-limit")

        try page.eval("window.__timeLimit.update('0:47', true);")
        XCTAssertEqual(try page.string("__first('.time-limit-value').textContent"), "0:47")
        XCTAssertEqual(try page.string("__first('.time-limit').className"), "time-limit danger")

        try page.eval("window.__timeLimit.update('1:02', false);")
        XCTAssertEqual(
            try page.string("__first('.time-limit').className"),
            "time-limit",
            "the danger colour comes back off above a minute"
        )
    }

    func testTheCloseButtonHidesTheStripForTheRestOfTheAttemptAndTellsTheHost() throws {
        let page = try harness(deadline: true)
        try page.eval("window.__timeLimit.update('4:00', false);")
        XCTAssertFalse(try page.bool("__first('.time-limit').hidden"))

        try page.eval("__first('.time-limit-hide').onclick();")
        XCTAssertTrue(try page.bool("__first('.time-limit').hidden"))
        XCTAssertEqual(
            try page.postedTimerDismissals().count,
            1,
            "the host is told so it can stop pushing text at a hidden strip"
        )

        // A later push — the host counts on regardless — must not bring it back.
        try page.eval("window.__timeLimit.update('0:30', true);")
        XCTAssertTrue(try page.bool("__first('.time-limit').hidden"))
        XCTAssertEqual(try page.string("__first('.time-limit-value').textContent"), "4:00")
    }

    /// No time limit (2026-09-24): `remove` takes the strip off the page, and
    /// a later push (the teacher set a deadline again) builds a fresh one in
    /// the same place — first child of the item root.
    func testRemoveTakesTheStripOffAndALaterPushRebuildsIt() throws {
        let page = try harness(deadline: true)
        try page.eval("window.__timeLimit.update('12:00', false);")
        XCTAssertEqual(try page.int("__count('.time-limit')"), 1)

        try page.eval("window.__timeLimit.remove();")
        XCTAssertEqual(try page.int("__count('.time-limit')"), 0)
        try page.eval("window.__timeLimit.remove();")  // idempotent
        XCTAssertEqual(try page.int("__count('.time-limit')"), 0)

        try page.eval("window.__timeLimit.update('30:00', false);")
        XCTAssertEqual(try page.int("__count('.time-limit')"), 1)
        XCTAssertEqual(try page.string("__root.children[0].className"), "time-limit")
        XCTAssertEqual(try page.string("__first('.time-limit-value').textContent"), "30:00")
    }

    /// The student's "hide the timer" choice carries over a removal: a
    /// deadline set again afterwards brings no strip back.
    func testAHiddenStripStaysHiddenAcrossARemoval() throws {
        let page = try harness(deadline: true)
        try page.eval("window.__timeLimit.update('4:00', false);")
        try page.eval("__first('.time-limit-hide').onclick();")
        try page.eval("window.__timeLimit.remove();")
        XCTAssertEqual(try page.int("__count('.time-limit')"), 0)

        try page.eval("window.__timeLimit.update('30:00', false);")
        XCTAssertEqual(try page.int("__count('.time-limit')"), 0)
    }

    // MARK: - the stylesheet

    /// T-1 (2026-09-14): `display: flex` on `.time-limit` beat the UA
    /// `[hidden]` rule, so the close button's `hidden` set froze the strip on
    /// screen instead of removing it.
    func testTheStylesheetHidesTheStripOnceHidden() throws {
        let css = AssessmentPage.html(title: "T", bundleJSON: "{}")
        XCTAssertTrue(css.contains(".time-limit[hidden] { display: none; }"))
    }
}
