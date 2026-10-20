import XCTest
@testable import SecureTestCore

/// Row DC slice 3: the page glue for the graphing calculator. The calculator
/// itself needs a real DOM (MathLive), so here the harness checks the glue —
/// when the button appears, that the panel opens and closes, and that a
/// calculator which can't start (as in JavaScriptCore) says so instead of
/// breaking the page.
final class RendererCalculatorTests: XCTestCase {
    private func harness(calculator: String?) throws -> RendererHarness {
        let field = calculator.map { #","calculator":\#($0)"# } ?? ""
        return try RendererHarness(bundleJSON: """
        {"test_id":"t","title":"T"\(field),"items":[{"type":"short_text","id":"i","stem":"s"}]}
        """)
    }

    func testNoCalculatorFieldMeansNoButton() throws {
        let h = try harness(calculator: nil)
        XCTAssertEqual(try h.int("__count('.calc-toggle')"), 0)
        // (The page script evaluated at all in JavaScriptCore, so the
        // calculator's code — which can't run here — was never called.)
    }

    func testUnknownOrMalformedCalculatorIsNone() throws {
        for value in [#""graphing""#, "true", #"{"mode":"abacus"}"#, "null", "[]"] {
            let h = try harness(calculator: value)
            XCTAssertEqual(try h.int("__count('.calc-toggle')"), 0, value)
        }
    }

    func testEachModeShowsTheButton() throws {
        for mode in ["graphing", "scientific", "four_function"] {
            let h = try harness(calculator: #"{"mode":"\#(mode)"}"#)
            XCTAssertEqual(try h.int("__count('.calc-toggle')"), 1, mode)
            XCTAssertEqual(try h.string("__first('.calc-toggle').getAttribute('aria-expanded')"), "false")
        }
    }

    func testOpeningBuildsThePanelOnceAndClosingHidesIt() throws {
        let h = try harness(calculator: #"{"mode":"graphing"}"#)
        try h.eval("__first('.calc-toggle').onclick()")
        XCTAssertEqual(try h.int("__count('.calc-panel')"), 1)
        XCTAssertEqual(try h.string("__first('.calc-toggle').getAttribute('aria-expanded')"), "true")
        XCTAssertEqual(try h.string("__first('.calc-panel').getAttribute('role')"), "dialog")
        try h.eval("__first('.calc-close').onclick()")
        XCTAssertTrue(try h.bool("__first('.calc-panel').hidden"))
        XCTAssertEqual(try h.string("__first('.calc-toggle').getAttribute('aria-expanded')"), "false")
        try h.eval("__first('.calc-toggle').onclick()")
        XCTAssertEqual(try h.int("__count('.calc-panel')"), 1, "reopened, not rebuilt")
        XCTAssertFalse(try h.bool("__first('.calc-panel').hidden"))
    }

    func testEscapeClosesAndReturnsFocusToTheButton() throws {
        let h = try harness(calculator: #"{"mode":"graphing"}"#)
        try h.eval("__first('.calc-toggle').onclick()")
        try h.eval("__first('.calc-panel').onkeydown({ key: 'Escape', defaultPrevented: false })")
        XCTAssertTrue(try h.bool("__first('.calc-panel').hidden"))
        XCTAssertTrue(try h.bool("document.activeElement === __first('.calc-toggle')"))
    }

    func testACalculatorThatCannotStartSaysSoAndLeavesThePageWorking() throws {
        // JavaScriptCore has no customElements / navigator, so MathLive's top
        // level throws — the same path a broken load would take on a Mac.
        let h = try harness(calculator: #"{"mode":"graphing"}"#)
        try h.eval("__first('.calc-toggle').onclick()")
        XCTAssertEqual(
            try h.string("__first('.calc-failed').textContent"),
            "The calculator could not start. Ask your teacher."
        )
        // The question is still answerable.
        XCTAssertEqual(try h.int("__count('input')"), 1)
    }

    // D-7: the per-question mark, honoured in paged layout only.
    private func pagedWithMark(layout: String = "paged") throws -> RendererHarness {
        try RendererHarness(bundleJSON: """
        {"test_id":"t","title":"T","layout":"\(layout)","calculator":{"mode":"graphing","preset":"full"},
         "items":[{"type":"short_text","id":"a","stem":"No calculator here","no_calculator":true},
                  {"type":"short_text","id":"b","stem":"Calculator allowed"}]}
        """)
    }

    func testAMarkedQuestionsPageDisablesTheCalculator() throws {
        let h = try pagedWithMark()
        XCTAssertTrue(try h.bool("__first('.calc-toggle').disabled"))
        XCTAssertEqual(try h.string("__first('.calc-toggle').textContent"), "No calculator on this question")
        try h.eval("__first('.calc-toggle').onclick()")
        XCTAssertEqual(try h.int("__count('.calc-panel')"), 0, "a disabled button opens nothing")
    }

    func testTurningToAnUnmarkedPageOffersItAgainAndBackClosesIt() throws {
        let h = try pagedWithMark()
        try h.eval("__first('.pager-next').onclick()")
        XCTAssertFalse(try h.bool("__first('.calc-toggle').disabled"))
        XCTAssertEqual(try h.string("__first('.calc-toggle').textContent"), "Calculator")
        try h.eval("__first('.calc-toggle').onclick()")
        XCTAssertFalse(try h.bool("__first('.calc-panel').hidden"))
        try h.eval("__first('.pager-prev').onclick()")
        XCTAssertTrue(try h.bool("__first('.calc-panel').hidden"), "closed on the marked page")
        XCTAssertTrue(try h.bool("__first('.calc-toggle').disabled"))
    }

    func testScrollLayoutIgnoresTheMark() throws {
        let h = try pagedWithMark(layout: "scroll")
        XCTAssertFalse(try h.bool("__first('.calc-toggle').disabled"))
    }

    // D-8: a stimulus graph. JavaScriptCore can't draw it, which is exactly
    // the fallback a student would get: the teacher's description stays.
    func testAStimulusGraphFallsBackToItsDescription() throws {
        let h = try RendererHarness(bundleJSON: """
        {"test_id":"t","title":"T","items":[{"type":"short_text","id":"a","stem":"Where is the vertex?",
          "graph":{"rows":[{"latex":"y=x^{2}-4"}],"view":{"xmin":-10,"xmax":10,"ymin":-7.5,"ymax":7.5},
                   "alt":"A graph of y = x² − 4."}}]}
        """)
        XCTAssertEqual(try h.int("__count('.graph-stimulus')"), 1)
        XCTAssertEqual(try h.string("__first('.graph-stimulus-alt').textContent"), "A graph of y = x² − 4.")
        XCTAssertEqual(try h.int("__count('input')"), 1, "the question still has its answer box")
    }

    func testAMalformedGraphIsIgnored() throws {
        for graph in [#""a graph""#, "null", #"{"rows":[]}"#] {
            let h = try RendererHarness(bundleJSON: """
            {"test_id":"t","title":"T","items":[{"type":"short_text","id":"a","stem":"s","graph":\(graph)}]}
            """)
            XCTAssertEqual(try h.int("__count('.graph-stimulus')"), 0, graph)
        }
    }
}
