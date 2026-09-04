import XCTest
@testable import SecureTestCore

/// Client-fixes batch 1b (#3, 2026-09-03): "Clear answer" on multiple-choice
/// items (single and multi only — the other >=1-id types adopt the same
/// channel later). Exercises the renderer for real via JavaScriptCore (see
/// RendererHarness), against the fixture the design tool's own delivery
/// route produced — same fixture and item order as RendererBehaviourTests.
final class RendererClearAnswerTests: XCTestCase {
    private func harness() throws -> RendererHarness {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/delivery-bundle.json")
        return try RendererHarness(bundleJSON: try String(contentsOf: url, encoding: .utf8))
    }

    // Fixture order matches the seeded positions (RendererBehaviourTests.Index).
    private enum Index {
        static let mcSingle = 0, mcMulti = 1
    }

    func testSingleAndMultiChoiceEachRenderOneDisabledClearButton() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('.clear-answer', __item(\(Index.mcSingle)))"), 1)
        XCTAssertTrue(try h.bool("__first('.clear-answer', __item(\(Index.mcSingle))).disabled"))
        XCTAssertEqual(
            try h.string("__first('.clear-answer', __item(\(Index.mcSingle))).textContent"),
            "Clear answer"
        )

        XCTAssertEqual(try h.int("__count('.clear-answer', __item(\(Index.mcMulti)))"), 1)
        XCTAssertTrue(try h.bool("__first('.clear-answer', __item(\(Index.mcMulti))).disabled"))
    }

    /// A real click on a radio sets `checked` before firing `change`; the
    /// harness's direct `.onchange()` call does not, so the test sets it by
    /// hand first, same as the multi-select tests below do for checkboxes.
    func testCheckingAChoiceEnablesTheClearButtonOnSingleSelect() throws {
        let h = try harness()
        let item = "__item(\(Index.mcSingle))"
        try h.eval("""
        var input = __all('input', \(item))[0];
        input.checked = true; input.onchange();
        """)
        XCTAssertFalse(try h.bool("__first('.clear-answer', \(item)).disabled"))
    }

    func testCheckingAChoiceEnablesTheClearButtonOnMultiSelect() throws {
        let h = try harness()
        let item = "__item(\(Index.mcMulti))"
        try h.eval("""
        var boxes = __all('input', \(item));
        boxes[0].checked = true; boxes[0].onchange();
        """)
        XCTAssertFalse(try h.bool("__first('.clear-answer', \(item)).disabled"))
    }

    /// Click -> every input unchecked, exactly one withdrawal recorded, no
    /// response post from the click itself, and the button disables again.
    func testClickingClearOnSingleSelectUnchecksAndWithdraws() throws {
        let h = try harness()
        let item = "__item(\(Index.mcSingle))"
        try h.eval("""
        var chosen = __all('input', \(item))[1];
        chosen.checked = true; chosen.onchange();
        """)
        XCTAssertEqual(try h.postedMessages().count, 1, "the selection itself posts")
        XCTAssertFalse(try h.bool("__first('.clear-answer', \(item)).disabled"))

        try h.eval("__first('.clear-answer', \(item)).onclick()")

        XCTAssertEqual(try h.postedMessages().count, 1, "clearing posts nothing new")
        let withdrawals = try h.postedWithdrawals()
        XCTAssertEqual(withdrawals.count, 1)
        XCTAssertEqual(
            withdrawals[0]["item_id"] as? String,
            try h.string("BUNDLE.items[\(Index.mcSingle)].id")
        )
        XCTAssertFalse(try h.bool("__all('input', \(item))[1].checked"))
        XCTAssertTrue(try h.bool("__first('.clear-answer', \(item)).disabled"))
    }

    func testClickingClearOnMultiSelectUnchecksEveryBoxAndWithdrawsOnce() throws {
        let h = try harness()
        let item = "__item(\(Index.mcMulti))"
        try h.eval("""
        var boxes = __all('input', \(item));
        boxes[0].checked = true; boxes[0].onchange();
        boxes[2].checked = true; boxes[2].onchange();
        """)
        XCTAssertEqual(try h.postedMessages().count, 2)

        try h.eval("__first('.clear-answer', \(item)).onclick()")

        XCTAssertEqual(try h.postedMessages().count, 2, "clearing posts nothing new")
        XCTAssertEqual(try h.postedWithdrawals().count, 1)
        XCTAssertEqual(
            try h.postedWithdrawals()[0]["item_id"] as? String,
            try h.string("BUNDLE.items[\(Index.mcMulti)].id")
        )
        XCTAssertEqual(try h.int("__all('input', \(item)).filter(function (i) { return i.checked; }).length"), 0)
        XCTAssertTrue(try h.bool("__first('.clear-answer', \(item)).disabled"))
    }

    /// Unchecking the last checked box (by hand, not via the button) also
    /// withdraws — this is the existing "clearing every box" branch, which
    /// used to post nothing and now withdraws instead.
    func testUncheckingTheLastMultiBoxWithdraws() throws {
        let h = try harness()
        let item = "__item(\(Index.mcMulti))"
        try h.eval("""
        var boxes = __all('input', \(item));
        boxes[0].checked = true; boxes[0].onchange();
        boxes[0].checked = false; boxes[0].onchange();
        """)
        XCTAssertEqual(try h.postedMessages().count, 1, "only the initial check posts")
        let withdrawals = try h.postedWithdrawals()
        XCTAssertEqual(withdrawals.count, 1)
        XCTAssertEqual(
            withdrawals[0]["item_id"] as? String,
            try h.string("BUNDLE.items[\(Index.mcMulti)].id")
        )
        XCTAssertTrue(try h.bool("__first('.clear-answer', \(item)).disabled"))
    }
}
