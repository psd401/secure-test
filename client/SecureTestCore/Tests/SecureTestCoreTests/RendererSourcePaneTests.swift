import XCTest
@testable import SecureTestCore

/// Multi-source stimulus slice 4 (docs/multi-source-stimulus-design.md): a
/// set's labelled sources, the tab strip's keyboard model, and the
/// `side_by_side` page with its narrow fallback. Runs the real renderer in
/// JavaScriptCore against the fixture the delivery route produced, which
/// carries one own_page set over items 1–2 and one side_by_side set with two
/// sources over item 3 (the essay).
final class RendererSourcePaneTests: XCTestCase {
    private func fixtureJSON() throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/delivery-bundle.json")
        return try String(contentsOf: url, encoding: .utf8)
    }

    private func harness(paged: Bool = false, wide: Bool? = nil) throws -> RendererHarness {
        var json = try fixtureJSON()
        if paged {
            let range = try XCTUnwrap(json.range(of: "\"test_id\":"))
            json.replaceSubrange(range, with: "\"layout\": \"paged\", \"test_id\":")
        }
        let prelude = wide.map { "window.__forceWide = \($0);" }
        return try RendererHarness(bundleJSON: json, prelude: prelude)
    }

    /// A bundle whose only set is the given one, over the fixture's first item.
    private func harness(itemSets: String) throws -> RendererHarness {
        var json = try fixtureJSON()
        let range = try XCTUnwrap(json.range(of: "\"item_sets\": ["))
        var depth = 1
        var end = range.upperBound
        while depth > 0, end < json.endIndex {
            if json[end] == "[" { depth += 1 }
            if json[end] == "]" { depth -= 1 }
            end = json.index(after: end)
        }
        json.replaceSubrange(range.lowerBound..<end, with: "\"item_sets\": \(itemSets)")
        return try RendererHarness(bundleJSON: json)
    }

    /// The fixture's ids churn on every regeneration, so tests read them back
    /// off the bundle rather than naming them (RendererPrefillTests' rule).
    private func firstItemId() throws -> String {
        let h = try harness()
        return try XCTUnwrap(h.string("BUNDLE.items[0].id"))
    }

    // MARK: - The pane

    func testTwoSourcesRenderATabStripWithTheFirstOpen() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('.source-pane')"), 1)
        let strip = "__first('.source-tabs')"
        XCTAssertEqual(try h.string("\(strip).getAttribute('role')"), "tablist")
        XCTAssertEqual(try h.string("\(strip).getAttribute('aria-label')"), "Sources")
        XCTAssertEqual(try h.int("__count('.source-tab')"), 2)
        XCTAssertEqual(
            try h.string("__all('.source-tab').map(function (t) { return t.textContent; }).join(',')"),
            "Source A,Source B"
        )
        XCTAssertEqual(
            try h.string("__all('.source-tab').map(function (t) { return t.getAttribute('aria-selected'); }).join(',')"),
            "true,false"
        )
        // One Tab stop for the strip (the math keypad's roving model).
        XCTAssertEqual(
            try h.string("__all('.source-tab').map(function (t) { return t.getAttribute('tabindex'); }).join(',')"),
            "0,-1"
        )
        XCTAssertEqual(try h.string("__all('.source-tab')[0].className"), "source-tab source-tab-open")
        XCTAssertEqual(try h.string("__all('.source-tab')[0].getAttribute('role')"), "tab")
    }

    func testExactlyOnePanelIsVisibleAndEachTabPointsAtItsOwn() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('.source-panel')"), 2)
        XCTAssertEqual(
            try h.string("__all('.source-panel').map(function (p) { return p.getAttribute('hidden') === null ? 'v' : 'h'; }).join('')"),
            "vh"
        )
        XCTAssertEqual(try h.string("__all('.source-panel')[0].getAttribute('role')"), "tabpanel")
        // Scrollable, so a keyboard student can reach it.
        XCTAssertEqual(try h.string("__all('.source-panel')[0].getAttribute('tabindex')"), "0")
        XCTAssertEqual(
            try h.string("__all('.source-tab')[1].getAttribute('aria-controls')"),
            try h.string("__all('.source-panel')[1].getAttribute('id')")
        )
        XCTAssertEqual(
            try h.string("__all('.source-panel')[1].getAttribute('aria-labelledby')"),
            try h.string("__all('.source-tab')[1].getAttribute('id')")
        )
    }

    func testClickingATabOpensItsPanelAndClosesTheOther() throws {
        let h = try harness()
        try h.eval("__all('.source-tab')[1].onclick()")
        XCTAssertEqual(
            try h.string("__all('.source-panel').map(function (p) { return p.getAttribute('hidden') === null ? 'v' : 'h'; }).join('')"),
            "hv"
        )
        XCTAssertEqual(
            try h.string("__all('.source-tab').map(function (t) { return t.getAttribute('aria-selected'); }).join(',')"),
            "false,true"
        )
    }

    func testArrowKeysMoveTheSelectionAndFocusAndWrap() throws {
        let h = try harness()
        let key = { (name: String) in
            "__first('.source-tabs').onkeydown({ key: '\(name)', preventDefault: function () {} })"
        }
        try h.eval(key("ArrowRight"))
        XCTAssertEqual(try h.string("__all('.source-tab')[1].getAttribute('aria-selected')"), "true")
        XCTAssertEqual(try h.string("document.activeElement.textContent"), "Source B")
        // Wraps at the end.
        try h.eval(key("ArrowRight"))
        XCTAssertEqual(try h.string("__all('.source-tab')[0].getAttribute('aria-selected')"), "true")
        XCTAssertEqual(try h.string("document.activeElement.textContent"), "Source A")
        // And backwards from the start.
        try h.eval(key("ArrowLeft"))
        XCTAssertEqual(try h.string("document.activeElement.textContent"), "Source B")
        try h.eval(key("Home"))
        XCTAssertEqual(try h.string("document.activeElement.textContent"), "Source A")
        try h.eval(key("End"))
        XCTAssertEqual(try h.string("document.activeElement.textContent"), "Source B")
        XCTAssertEqual(
            try h.string("__all('.source-panel').map(function (p) { return p.getAttribute('hidden') === null ? 'v' : 'h'; }).join('')"),
            "hv"
        )
        // A key the strip does not handle changes nothing.
        try h.eval("__first('.source-tabs').onkeydown({ key: 'a', preventDefault: function () {} })")
        XCTAssertEqual(try h.string("document.activeElement.textContent"), "Source B")
    }

    func testTheSourceBodyKeepsAuthoredLineBreaksAndRendersImages() throws {
        let h = try harness()
        let first = "__all('.source-body')[0]"
        XCTAssertTrue(
            try h.bool("\(first).textContent.indexOf('\\n') !== -1"),
            "the authored line break survives as text, which pre-line renders"
        )
        XCTAssertEqual(try h.int("__count('img', \(first))"), 0)
        let second = "__all('.source-body')[1]"
        XCTAssertEqual(try h.int("__count('img', \(second))"), 1)
        XCTAssertTrue(try h.string("__first('img', \(second)).src")?.hasPrefix("data:image/") ?? false)
    }

    func testOneSourceRendersALabelledPanelAndNoTabStrip() throws {
        let h = try harness(itemSets: """
        [{"id":"one","stimulus":"Read it.","layout":"inline","sources":[{"label":"Source A","text":"Only one."}],"item_ids":["\(try firstItemId())"]}]
        """)
        XCTAssertEqual(try h.int("__count('.source-pane')"), 1)
        XCTAssertEqual(try h.int("__count('.source-tabs')"), 0)
        XCTAssertEqual(try h.int("__count('.source-tab')"), 0)
        XCTAssertEqual(try h.int("__count('.source-panel')"), 1)
        XCTAssertNil(try h.string("__first('.source-panel').getAttribute('hidden')"))
        XCTAssertEqual(try h.string("__first('.source-label').tagName"), "h3")
        XCTAssertEqual(try h.string("__first('.source-label').textContent"), "Source A")
        XCTAssertEqual(try h.string("__first('.source-body').textContent"), "Only one.")
    }

    func testASetWithNoSourcesBuildsNoPane() throws {
        let h = try harness(itemSets: """
        [{"id":"none","stimulus":"Read it.","layout":"inline","sources":[],"item_ids":["\(try firstItemId())"]}]
        """)
        XCTAssertEqual(try h.int("__count('.stimulus')"), 1)
        XCTAssertEqual(try h.int("__count('.source-pane')"), 0)
    }

    // MARK: - side_by_side

    func testWideBuildsOnePageWithTheSourcesBesideTheQuestion() throws {
        let h = try harness(paged: true, wide: true)
        XCTAssertEqual(try h.int("__count('.page')"), 11)
        let page = "__all('.page')[4]"
        XCTAssertEqual(try h.string("\(page).getAttribute('data-kind')"), "questions")
        XCTAssertEqual(try h.string("__first('.page-label', \(page)).textContent"), "Question 4 of 9")
        XCTAssertEqual(try h.int("__count('.side-by-side', \(page))"), 1)
        // The stimulus and its sources left, the member question right.
        XCTAssertEqual(try h.int("__count('.stimulus', __first('.side-source', \(page)))"), 1)
        XCTAssertEqual(try h.int("__count('.source-pane', __first('.side-source', \(page)))"), 1)
        XCTAssertEqual(try h.int("__count('.item', __first('.side-questions', \(page)))"), 1)
        XCTAssertEqual(try h.int("__count('textarea', __first('.side-questions', \(page)))"), 1)
        // No passage page and no disclosure for this set.
        XCTAssertEqual(try h.int("__count('.passage-ref', \(page))"), 0)
        XCTAssertEqual(
            try h.string("__all('.page').map(function (p) { return p.getAttribute('data-kind'); }).join(',')"),
            "question,passage,question,question,questions,question,question,question,question,question,review"
        )
    }

    func testNarrowFallsBackToAPassagePageAndAShowTheSourcesDisclosure() throws {
        let h = try harness(paged: true, wide: false)
        // One page more than wide: the sourced set gains a passage page.
        XCTAssertEqual(try h.int("__count('.page')"), 12)
        XCTAssertEqual(try h.int("__count('.side-by-side')"), 0)
        XCTAssertEqual(
            try h.string("__all('.page').map(function (p) { return p.getAttribute('data-kind'); }).join(',')"),
            "question,passage,question,question,passage,question,question,question,question,question,question,review"
        )
        let passage = "__all('.page')[4]"
        XCTAssertEqual(try h.string("__first('.page-label', \(passage)).textContent"), "Passage for question 4")
        XCTAssertEqual(try h.int("__count('.source-pane', \(passage))"), 1)
        // The question page beneath it carries the disclosure, named for what
        // the set holds.
        let question = "__all('.page')[5]"
        XCTAssertEqual(try h.int("__count('.passage-ref', \(question))"), 1)
        XCTAssertEqual(try h.string("__first('summary', \(question)).textContent"), "Show the sources")
        // The own_page set without sources keeps its own wording.
        XCTAssertEqual(try h.string("__first('summary', __all('.page')[2]).textContent"), "Show the passage")
    }

    func testTheOpenSourceSurvivesAPageTurnWithinTheSet() throws {
        let h = try harness(paged: true, wide: false)
        // Open Source B on the passage page, then move to the question page,
        // where the same pane travels with the block.
        try h.eval("__all('button', __first('.pager-strip'))[4].onclick()")
        try h.eval("__all('.source-tab')[1].onclick()")
        try h.eval("__first('.pager-next').onclick()")
        XCTAssertEqual(try h.string("__first('.pager-current').textContent"), "Question 4 of 9")
        XCTAssertEqual(
            try h.string("__all('.source-tab').map(function (t) { return t.getAttribute('aria-selected'); }).join(',')"),
            "false,true",
            "the pane is one element and keeps the source the student was reading"
        )
    }

    /// The pane is ordinary page content, so contrast, Atkinson and zoom
    /// (batch 4) reach it through the tokens rather than a rule of its own.
    func testTheStylesheetUsesTokensAndKeepsTheColumnsCollapsible() throws {
        let css = AssessmentPage.html(title: "T", bundleJSON: "{}")
        XCTAssertTrue(css.contains(".source-body { margin: 0; line-height: 1.5; white-space: pre-line; }"))
        XCTAssertTrue(css.contains("var(--accent-ink)"))
        XCTAssertTrue(css.contains("max-height: 60vh; overflow: auto;"))
        XCTAssertTrue(css.contains("@media (max-width: 1099px)"))
    }
}
