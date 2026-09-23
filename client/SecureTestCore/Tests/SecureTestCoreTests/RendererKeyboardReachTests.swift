import XCTest
@testable import SecureTestCore

/// Findings HS-1 / ME-1 (2026-09-23, a district Mac, real session, v1.3.4):
/// with macOS "Keyboard navigation" OFF — the fleet default — WebKit's Tab
/// reaches only text fields and elements with an explicit tabindex. The page
/// now gives every button, select and checkbox without one `tabindex="0"`
/// (`reachByKeyboard`), and single-choice radios become one Tab stop per
/// question with arrows between the choices (decision 13.1).
///
/// Runs the real renderer against the JavaScriptCore shim. What it cannot
/// prove: the MutationObserver half of the pass (JavaScriptCore has none — the
/// page guards on it, so nodes added after the build are a hand-run row), and
/// that WebKit actually moves focus on Tab / draws the ring (no window server,
/// ADR 0013).
final class RendererKeyboardReachTests: XCTestCase {
    // Fixture order matches the seeded positions (RendererBehaviourTests.Index).
    private enum Index {
        static let mcSingle = 0, mcMulti = 1, match = 4, order = 5, hotspot = 6, drawing = 7
    }

    private func harness(_ inject: String = "") throws -> RendererHarness {
        var json = try RendererHarness.fixtureJSON()
        if !inject.isEmpty {
            let range = try XCTUnwrap(json.range(of: "\"test_id\":"))
            json.replaceSubrange(range, with: inject + "\"test_id\":")
        }
        return try RendererHarness(bundleJSON: json)
    }

    private func tabindexes(_ h: RendererHarness, _ sel: String, in node: String = "__root") throws -> [String?] {
        let json = try XCTUnwrap(h.string("""
        JSON.stringify(__all('\(sel)', \(node)).map(function (n) { return n.getAttribute('tabindex'); }))
        """))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [Any])
            .map { $0 as? String }
    }

    private func radioStops(_ h: RendererHarness) throws -> [String?] {
        try tabindexes(h, "input", in: "__item(\(Index.mcSingle))")
    }

    private func key(_ h: RendererHarness, radio: Int, _ key: String, modifier: String = "") throws {
        try h.eval("""
        window.__prevented = false;
        __all('input', __item(\(Index.mcSingle)))[\(radio)].onkeydown({
          key: '\(key)', \(modifier) preventDefault: function () { window.__prevented = true; }
        });
        """)
    }

    // MARK: - the page-wide pass

    func testEveryButtonSelectAndCheckboxIsReachableAfterTheBuild() throws {
        let h = try harness()
        for sel in ["button", "select"] {
            let stops = try tabindexes(h, sel)
            XCTAssertFalse(stops.isEmpty, "the fixture renders some \(sel)")
            XCTAssertTrue(stops.allSatisfy { $0 == "0" || $0 == "-1" }, "\(sel): \(stops)")
        }
        XCTAssertEqual(try tabindexes(h, "input", in: "__item(\(Index.mcMulti))"), ["0", "0", "0"],
                       "a checkbox stays one stop each")
        XCTAssertEqual(try tabindexes(h, "select", in: "__item(\(Index.match))"), ["0", "0", "0"])
        let moves = try tabindexes(h, ".order-move", in: "__item(\(Index.order))")
        XCTAssertFalse(moves.isEmpty)
        XCTAssertTrue(moves.allSatisfy { $0 == "0" }, "Move buttons: \(moves)")
        let regions = try tabindexes(h, ".hotspot-region", in: "__item(\(Index.hotspot))")
        XCTAssertFalse(regions.isEmpty)
        XCTAssertTrue(regions.allSatisfy { $0 == "0" }, "one stop per hotspot region (HS-1)")
        XCTAssertEqual(try h.string("__first('button', __first('.finish')).getAttribute('tabindex')"), "0")
    }

    func testPagedNavigationButtonsAreReachable() throws {
        let h = try harness("\"layout\": \"paged\", ")
        let stops = try tabindexes(h, "button")
        XCTAssertTrue(stops.allSatisfy { $0 == "0" || $0 == "-1" }, "\(stops)")
        let strip = try tabindexes(h, ".pager-strip")
        XCTAssertEqual(strip.count, 1)
        let stripButtons = try tabindexes(h, "button", in: "__first('.pager-strip')")
        XCTAssertFalse(stripButtons.isEmpty)
        XCTAssertTrue(stripButtons.allSatisfy { $0 == "0" }, "page strip: \(stripButtons)")
    }

    /// The roving groups set their own 0 / -1 stops; the pass must not turn
    /// their -1s into extra stops.
    func testTheDrawingToolbarKeepsExactlyOneStop() throws {
        let h = try harness()
        let stops = try tabindexes(h, "button", in: "__first('.drawing-tools', __item(\(Index.drawing)))")
        XCTAssertEqual(stops.filter { $0 == "0" }.count, 1, "\(stops)")
        XCTAssertEqual(stops.filter { $0 == "-1" }.count, stops.count - 1)
    }

    /// ME-1: Shift-Tab from a key skipped the toggle; the pad itself stays one stop.
    func testTheMathKeysToggleIsReachableAndThePadKeepsOneStop() throws {
        let h = try RendererHarness(bundleJSON: """
        { "test_id": "me1", "title": "Math keys",
          "items": [{ "type": "short_text", "id": "chem", "stem": "Write $x$ as a fraction." }] }
        """)
        XCTAssertEqual(try h.string("__first('.math-keys-toggle').getAttribute('tabindex')"), "0")
        let pad = try tabindexes(h, "button", in: "__first('.math-keys')")
        XCTAssertGreaterThan(pad.count, 1)
        XCTAssertEqual(pad.filter { $0 == "0" }.count, 1, "\(pad)")
    }

    // MARK: - single-choice radios (decision 13.1)

    func testAnUnansweredQuestionHasItsFirstChoiceAsTheOneStop() throws {
        XCTAssertEqual(try radioStops(try harness()), ["0", "-1", "-1"])
    }

    func testARestoredAnswerIsTheStop() throws {
        let probe = try harness()
        let id = try XCTUnwrap(probe.string("BUNDLE.items[\(Index.mcSingle)].id"))
        let h = try harness("""
        "saved_responses": {"\(id)": {"type":"multiple_choice_single","choice_id":"c2"}},
        """ + " ")
        XCTAssertTrue(try h.bool("__all('input', __item(\(Index.mcSingle)))[1].checked"))
        XCTAssertEqual(try radioStops(h), ["-1", "0", "-1"])
        XCTAssertEqual(try h.postedMessages().count, 0, "a restore posts nothing")
    }

    func testAnArrowMovesTheStopChecksTheNextChoiceAndPostsOnce() throws {
        let h = try harness()
        try key(h, radio: 0, "ArrowDown")
        XCTAssertTrue(try h.bool("window.__prevented === true"), "WebKit's own radio arrows must not also run")
        XCTAssertEqual(try radioStops(h), ["-1", "0", "-1"])
        XCTAssertTrue(try h.bool("document.activeElement === __all('input', __item(\(Index.mcSingle)))[1]"))
        XCTAssertEqual(try h.int("__all('input', __item(\(Index.mcSingle))).filter(function (i) { return i.checked; }).length"), 1)
        let posted = try h.postedMessages()
        XCTAssertEqual(posted.count, 1)
        let response = posted[0]["response"] as? [String: Any]
        XCTAssertEqual(response?["type"] as? String, "multiple_choice_single")
        XCTAssertEqual(response?["choice_id"] as? String, "c2")
        XCTAssertFalse(try h.bool("__first('.clear-answer', __item(\(Index.mcSingle))).disabled"))

        try key(h, radio: 1, "ArrowRight")
        XCTAssertEqual(try radioStops(h), ["-1", "-1", "0"])
        XCTAssertEqual(try h.postedMessages().count, 2)
    }

    func testArrowsWrapAtBothEnds() throws {
        let h = try harness()
        try key(h, radio: 0, "ArrowUp")
        XCTAssertEqual(try radioStops(h), ["-1", "-1", "0"], "Up from the first wraps to the last")
        XCTAssertEqual((try h.postedMessages().last?["response"] as? [String: Any])?["choice_id"] as? String, "c3")

        try key(h, radio: 2, "ArrowDown")
        XCTAssertEqual(try radioStops(h), ["0", "-1", "-1"], "Down from the last wraps to the first")
        XCTAssertTrue(try h.bool("__all('input', __item(\(Index.mcSingle)))[0].checked"))
        XCTAssertFalse(try h.bool("__all('input', __item(\(Index.mcSingle)))[2].checked"))
        XCTAssertEqual(try h.postedMessages().count, 2)
    }

    func testOtherKeysAndModifiedArrowsAreLeftAlone() throws {
        let h = try harness()
        try key(h, radio: 0, "Tab")
        try key(h, radio: 0, "ArrowDown", modifier: "metaKey: true,")
        XCTAssertFalse(try h.bool("window.__prevented === true"))
        XCTAssertEqual(try h.postedMessages().count, 0)
        XCTAssertEqual(try radioStops(h), ["0", "-1", "-1"])
    }

    func testClearAnswerPutsTheStopBackOnTheFirstChoice() throws {
        let h = try harness()
        try key(h, radio: 0, "ArrowDown")
        try key(h, radio: 1, "ArrowDown")
        XCTAssertEqual(try radioStops(h), ["-1", "-1", "0"])
        try h.eval("__first('.clear-answer', __item(\(Index.mcSingle))).onclick()")
        XCTAssertEqual(try radioStops(h), ["0", "-1", "-1"])
        XCTAssertEqual(try h.postedWithdrawals().count, 1)
    }

    /// A click (the existing onchange path) moves the stop too.
    func testAClickMovesTheStop() throws {
        let h = try harness()
        try h.eval("var r = __all('input', __item(\(Index.mcSingle)))[2]; r.checked = true; r.onchange();")
        XCTAssertEqual(try radioStops(h), ["-1", "-1", "0"])
    }

    // MARK: - focus rings

    func testTheStylesheetRingsEveryReachableControl() {
        let css = AssessmentPage.itemStyles
        XCTAssertTrue(css.contains("button:focus-visible, select:focus-visible,"), "select ring (ME-1 sitting)")
        XCTAssertTrue(css.contains("input[type=radio]:focus-visible, input[type=checkbox]:focus-visible"))
    }
}
