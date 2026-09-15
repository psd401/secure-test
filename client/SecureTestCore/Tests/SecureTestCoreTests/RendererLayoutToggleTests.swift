import XCTest
@testable import SecureTestCore

/// Finding C-1 (`docs/multi-source-stimulus-design.md`): the student's own
/// "Sources: beside / above the question" control on a `side_by_side` page.
///
/// The class on the split is the whole mechanism — nothing is rebuilt — so what
/// is worth proving here is that the group is only on a two-column page, that
/// the pressed state and the class move together, and that two sets on the same
/// test keep separate choices.
final class RendererLayoutToggleTests: XCTestCase {
    /// The fixture's ids churn on every regeneration, so they are read back off
    /// the bundle rather than named (RendererPrefillTests' rule).
    private func itemIDs() throws -> [String] {
        let h = try RendererHarness(bundleJSON: try RendererHarness.fixtureJSON())
        let joined = try XCTUnwrap(h.string("BUNDLE.items.map(function (i) { return i.id; }).join(',')"))
        return joined.components(separatedBy: ",")
    }

    /// A paged bundle whose sets are the ones given, with the width forced.
    private func harness(itemSets: String, wide: Bool) throws -> RendererHarness {
        var json = try RendererHarness.fixtureJSON(replacingItemSets: itemSets)
        let range = try XCTUnwrap(json.range(of: "\"test_id\":"))
        json.replaceSubrange(range, with: "\"layout\": \"paged\", \"test_id\":")
        return try RendererHarness(bundleJSON: json, prelude: "window.__forceWide = \(wide);")
    }

    private func oneSet() throws -> String {
        let ids = try itemIDs()
        return """
        [{"id":"s1","stimulus":"Read them.","layout":"side_by_side",\
        "sources":[{"label":"Source A","text":"First."}],"item_ids":["\(ids[0])"]}]
        """
    }

    private func twoSets() throws -> String {
        let ids = try itemIDs()
        return """
        [{"id":"s1","stimulus":"Read them.","layout":"side_by_side",\
        "sources":[{"label":"Source A","text":"First."}],"item_ids":["\(ids[0])"]},\
        {"id":"s2","stimulus":"Read these too.","layout":"side_by_side",\
        "sources":[{"label":"Source A","text":"Second."}],"item_ids":["\(ids[1])"]}]
        """
    }

    func testAWideBuildShowsTheGroupWithBesidePressed() throws {
        let h = try harness(itemSets: try oneSet(), wide: true)
        XCTAssertEqual(try h.int("__count('.side-by-side')"), 1)
        XCTAssertEqual(try h.int("__count('.layout-toggle')"), 1)
        let group = "__first('.layout-toggle')"
        XCTAssertEqual(try h.string("\(group).getAttribute('role')"), "group")
        XCTAssertEqual(try h.string("\(group).getAttribute('aria-label')"), "Where the sources appear")
        XCTAssertEqual(try h.string("__first('.layout-toggle-label').textContent"), "Sources:")
        let buttons = "__all('button', \(group))"
        XCTAssertEqual(try h.int("\(buttons).length"), 2)
        XCTAssertEqual(
            try h.string("\(buttons).map(function (b) { return b.textContent; }).join(',')"),
            "Beside the question,Above the question"
        )
        XCTAssertEqual(
            try h.string("\(buttons).map(function (b) { return b.type; }).join(',')"),
            "button,button",
            "a form submit would reload the page and take every unsaved answer with it"
        )
        XCTAssertEqual(
            try h.string("\(buttons).map(function (b) { return b.getAttribute('aria-pressed'); }).join(',')"),
            "true,false"
        )
        // The group sits above the split it governs, on the same page.
        XCTAssertTrue(try h.bool("""
        (function () {
          var page = __all('.page').filter(function (p) { return __count('.side-by-side', p) === 1; })[0];
          var kids = page.children;
          return kids.indexOf(__first('.layout-toggle', page)) < kids.indexOf(__first('.side-by-side', page));
        })()
        """))
    }

    func testAboveStacksTheSplitAndBesideRestoresIt() throws {
        let h = try harness(itemSets: try oneSet(), wide: true)
        let buttons = "__all('button', __first('.layout-toggle'))"
        XCTAssertEqual(try h.string("__first('.side-by-side').className"), "side-by-side")

        try h.eval("\(buttons)[1].onclick()")
        XCTAssertEqual(try h.string("__first('.side-by-side').className"), "side-by-side stacked")
        XCTAssertEqual(
            try h.string("\(buttons).map(function (b) { return b.getAttribute('aria-pressed'); }).join(',')"),
            "false,true"
        )

        try h.eval("\(buttons)[0].onclick()")
        XCTAssertEqual(try h.string("__first('.side-by-side').className"), "side-by-side")
        XCTAssertEqual(
            try h.string("\(buttons).map(function (b) { return b.getAttribute('aria-pressed'); }).join(',')"),
            "true,false"
        )
        // Pressing the already-pressed choice is a no-op, not a flip.
        try h.eval("\(buttons)[0].onclick()")
        XCTAssertEqual(try h.string("__first('.side-by-side').className"), "side-by-side")
    }

    func testTwoSetsKeepSeparateChoices() throws {
        let h = try harness(itemSets: try twoSets(), wide: true)
        XCTAssertEqual(try h.int("__count('.layout-toggle')"), 2)
        try h.eval("__all('button', __all('.layout-toggle')[0])[1].onclick()")
        XCTAssertEqual(
            try h.string("__all('.side-by-side').map(function (s) { return s.className; }).join('|')"),
            "side-by-side stacked|side-by-side",
            "one set's choice must not move the other set's sources"
        )
        XCTAssertEqual(
            try h.string("__all('.layout-toggle').map(function (g) { return __all('button', g)[1].getAttribute('aria-pressed'); }).join(',')"),
            "true,false"
        )
    }

    func testANarrowBuildHasNoToggle() throws {
        let h = try harness(itemSets: try oneSet(), wide: false)
        XCTAssertEqual(try h.int("__count('.side-by-side')"), 0)
        XCTAssertEqual(
            try h.int("__count('.layout-toggle')"), 0,
            "the own_page fallback is already the stacked presentation — there is nothing to move"
        )
    }

    // MARK: - C-8: the same group on an own_page set

    /// One own_page set over the first two items, so the build is
    /// passage · Q1 · Q2 · Q3 … Q9 · review and the set owns TWO question
    /// pages — the case a single shared paint function could not serve.
    private func ownPageSet() throws -> String {
        let ids = try itemIDs()
        return """
        [{"id":"s1","stimulus":"Read them.","layout":"own_page",\
        "sources":[{"label":"Source A","text":"First."}],"item_ids":["\(ids[0])","\(ids[1])"]}]
        """
    }

    func testAWideOwnPageSetPutsTheGroupOnEveryQuestionPageAndNotThePassagePage() throws {
        let h = try harness(itemSets: try ownPageSet(), wide: true)
        XCTAssertEqual(
            try h.string("__all('.page').map(function (p) { return p.getAttribute('data-kind'); }).join(',')"),
            "passage,question,question,question,question,question,question,question,question,question,review"
        )
        XCTAssertEqual(
            try h.int("__count('.layout-toggle', __all('.page')[0])"), 0,
            "the passage page IS the sources — there is nothing to move there"
        )
        XCTAssertEqual(try h.int("__count('.layout-toggle', __all('.page')[1])"), 1)
        XCTAssertEqual(try h.int("__count('.layout-toggle', __all('.page')[2])"), 1)
        XCTAssertEqual(
            try h.int("__count('.layout-toggle', __all('.page')[3])"), 0,
            "Q3 is not a member of the set"
        )
        XCTAssertEqual(try h.int("__count('.layout-toggle')"), 2)
        // Above is the default here: today's presentation, unchanged.
        let buttons = "__all('button', __first('.layout-toggle', __all('.page')[1]))"
        XCTAssertEqual(
            try h.string("\(buttons).map(function (b) { return b.getAttribute('aria-pressed'); }).join(',')"),
            "false,true"
        )
        XCTAssertEqual(try h.string("__first('.side-by-side', __all('.page')[1]).className"), "side-by-side stacked")
        XCTAssertNil(try h.string("__first('.passage-ref', __all('.page')[1]).getAttribute('hidden')"))
        XCTAssertEqual(
            try h.string("__first('.layout-toggle', __all('.page')[1]).getAttribute('aria-label')"),
            "Where the sources appear"
        )
        // The group sits above the disclosure and the split it governs.
        XCTAssertTrue(try h.bool("""
        (function () {
          var page = __all('.page')[1];
          var kids = page.children;
          return kids.indexOf(__first('.layout-toggle', page)) < kids.indexOf(__first('.passage-ref', page))
            && kids.indexOf(__first('.passage-ref', page)) < kids.indexOf(__first('.side-by-side', page));
        })()
        """))
    }

    func testBesideSplitsAnOwnPageQuestionAndAboveRestoresTheDisclosure() throws {
        let h = try harness(itemSets: try ownPageSet(), wide: true)
        let page = "__all('.page')[1]"
        // Stand on the question page, so the block has travelled to it.
        try h.eval("__all('button', __first('.pager-strip'))[1].onclick()")
        XCTAssertEqual(try h.int("__count('.stimulus', __first('.passage-holder', \(page)))"), 1)

        let buttons = "__all('button', __first('.layout-toggle', \(page)))"
        try h.eval("\(buttons)[0].onclick()")
        XCTAssertEqual(try h.string("__first('.side-by-side', \(page)).className"), "side-by-side")
        XCTAssertEqual(try h.int("__count('.stimulus', __first('.side-source', \(page)))"), 1)
        XCTAssertEqual(try h.int("__count('.source-pane', __first('.side-source', \(page)))"), 1)
        XCTAssertEqual(try h.int("__count('.item', __first('.side-questions', \(page)))"), 1)
        XCTAssertEqual(
            try h.string("__first('.passage-ref', \(page)).getAttribute('hidden')"), "",
            "an empty disclosure would be a dead control"
        )
        XCTAssertEqual(
            try h.string("\(buttons).map(function (b) { return b.getAttribute('aria-pressed'); }).join(',')"),
            "true,false"
        )
        XCTAssertEqual(try h.int("__count('.stimulus')"), 1, "the block is one element, never copied")

        try h.eval("\(buttons)[1].onclick()")
        XCTAssertEqual(try h.string("__first('.side-by-side', \(page)).className"), "side-by-side stacked")
        XCTAssertEqual(try h.int("__count('.stimulus', __first('.passage-holder', \(page)))"), 1)
        XCTAssertEqual(try h.int("__count('.stimulus', __first('.side-source', \(page)))"), 0)
        XCTAssertNil(try h.string("__first('.passage-ref', \(page)).getAttribute('hidden')"))
        XCTAssertEqual(try h.int("__count('.item', __first('.side-questions', \(page)))"), 1)
        XCTAssertEqual(try h.int("__count('.stimulus')"), 1)
    }

    func testTheChoiceHoldsAcrossAPageTurnWithinTheSet() throws {
        let h = try harness(itemSets: try ownPageSet(), wide: true)
        try h.eval("__all('button', __first('.pager-strip'))[1].onclick()")
        try h.eval("__all('button', __first('.layout-toggle', __all('.page')[1]))[0].onclick()")
        // The set's OTHER question page agrees at once, before it is shown.
        let second = "__all('.page')[2]"
        XCTAssertEqual(try h.string("__first('.side-by-side', \(second)).className"), "side-by-side")
        XCTAssertEqual(
            try h.string("__all('button', __first('.layout-toggle', \(second))).map(function (b) { return b.getAttribute('aria-pressed'); }).join(',')"),
            "true,false"
        )
        // Turning to it brings the block into ITS left column, not a holder.
        try h.eval("__first('.pager-next').onclick()")
        XCTAssertEqual(try h.string("__first('.pager-current').textContent"), "Question 2 of 9")
        XCTAssertEqual(try h.int("__count('.stimulus', __first('.side-source', \(second)))"), 1)
        XCTAssertEqual(try h.int("__count('.stimulus', __all('.page')[1])"), 0)
        XCTAssertEqual(try h.int("__count('.stimulus')"), 1)
        // And the passage page still holds it when the student goes back.
        try h.eval("__all('button', __first('.pager-strip'))[0].onclick()")
        XCTAssertEqual(try h.int("__count('.stimulus', __all('.page')[0])"), 1)
        XCTAssertEqual(try h.int("__count('.stimulus', \(second))"), 0)
    }

    func testANarrowOwnPageBuildKeepsTheDisclosureAndHasNoToggle() throws {
        let h = try harness(itemSets: try ownPageSet(), wide: false)
        XCTAssertEqual(try h.int("__count('.layout-toggle')"), 0)
        XCTAssertEqual(
            try h.int("__count('.side-by-side')"), 0,
            "there is no room for two columns, so there is no choice to offer"
        )
        let page = "__all('.page')[1]"
        XCTAssertEqual(try h.int("__count('.passage-ref', \(page))"), 1)
        XCTAssertEqual(try h.string("__first('summary', \(page)).textContent"), "Show the sources")
        try h.eval("__all('button', __first('.pager-strip'))[1].onclick()")
        XCTAssertEqual(try h.int("__count('.stimulus', __first('.passage-holder', \(page)))"), 1)
    }

    func testTheStylesheetCarriesTheStackedAndToggleRules() throws {
        let css = AssessmentPage.html(title: "T", bundleJSON: "{}")
        XCTAssertTrue(css.contains(".side-by-side.stacked { display: block; }"))
        XCTAssertTrue(css.contains(
            ".side-by-side.stacked > .side-source, .side-by-side.stacked > .side-questions { max-height: none; overflow: visible; }"
        ))
        XCTAssertTrue(css.contains(".layout-toggle-label { font-size: 0.8125rem; color: var(--ink-soft); }"))
        XCTAssertTrue(css.contains(".layout-toggle button[aria-pressed=\"true\"]"))
        XCTAssertTrue(css.contains(".layout-toggle button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }"))
        // C-8: "Beside" hides the disclosure with the attribute, so the rule
        // has to be ours (T-1's lesson), not the UA sheet's.
        XCTAssertTrue(css.contains(".passage-ref[hidden] { display: none; }"))
    }
}
