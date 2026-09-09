import XCTest
@testable import SecureTestCore

/// Client paging (docs/client-paging-design.md). The fixture has nine items
/// and one own_page set over indices 1–2, so paged it is: Q1 · passage ·
/// Q2 · Q3 · Q4 … Q9 · review = 11 pages. Scroll mode builds the tree every
/// other renderer suite already asserts on; these tests only add the flag.
final class RendererPagingTests: XCTestCase {
    private func paged() throws -> RendererHarness {
        var json = try RendererHarness.fixtureJSON()
        let range = try XCTUnwrap(json.range(of: "\"test_id\":"))
        json.replaceSubrange(range, with: "\"layout\": \"paged\", \"test_id\":")
        return try RendererHarness(bundleJSON: json)
    }

    func testScrollModeBuildsNoPagesAndNoBar() throws {
        let h = try RendererHarness(bundleJSON: try RendererHarness.fixtureJSON())
        XCTAssertEqual(try h.int("__count('.page')"), 0)
        XCTAssertEqual(try h.int("__count('.pager')"), 0)
        XCTAssertEqual(try h.string("__root.children[0].className"), "item")
        // A value this build has not heard of is scroll too.
        let odd = try RendererHarness(bundleJSON: #"{"test_id":"t","title":"t","layout":"sideways","items":[{"type":"essay","id":"e","stem":"s"}]}"#)
        XCTAssertEqual(try odd.int("__count('.page')"), 0)
    }

    func testPagedBuildsOnePagePerQuestionAPassagePageAndAReviewPage() throws {
        let h = try paged()
        XCTAssertEqual(try h.int("__count('.page')"), 11)
        XCTAssertEqual(try h.int("__count('.item')"), 9, "every question is still in the tree")
        let kinds = try h.string("__all('.page').map(function (p) { return p.getAttribute('data-kind'); }).join(',')")
        // Page 4 is the side_by_side set's shared page (multi-source slice 4);
        // the harness has no window metrics, so the renderer treats it as wide.
        XCTAssertEqual(kinds, "question,passage,question,question,questions,question,question,question,question,question,review")
        XCTAssertEqual(try h.string("__all('.page-label')[0].textContent"), "Question 1 of 9")
        XCTAssertEqual(try h.string("__all('.page-label')[1].textContent"), "Passage for questions 2\u{2013}3")
        XCTAssertEqual(try h.string("__all('.page-label')[2].textContent"), "Question 2 of 9")
        XCTAssertEqual(try h.string("__all('.page-label')[10].textContent"), "Review and hand in")
    }

    func testOnlyTheFirstPageIsVisibleAndTheBarSaysSo() throws {
        let h = try paged()
        let hidden = try h.string("__all('.page').map(function (p) { return p.getAttribute('hidden') === null ? 'v' : 'h'; }).join('')")
        XCTAssertEqual(hidden, "vhhhhhhhhhh")
        XCTAssertEqual(try h.string("__first('.pager-current').textContent"), "Question 1 of 9")
        XCTAssertTrue(try h.bool("__first('.pager-prev').disabled"))
        XCTAssertFalse(try h.bool("__first('.pager-next').disabled"))
        XCTAssertEqual(try h.int("__count('button', __first('.pager-strip'))"), 11)
        XCTAssertEqual(try h.string("__all('button', __first('.pager-strip'))[1].textContent"), "P")
        XCTAssertEqual(try h.string("__all('button', __first('.pager-strip'))[0].getAttribute('aria-current')"), "page")
    }

    func testNextAndPreviousMoveOnePageAndTheLastPageDisablesNext() throws {
        let h = try paged()
        try h.eval("__first('.pager-next').onclick()")
        XCTAssertEqual(try h.string("__first('.pager-current').textContent"), "Passage for questions 2\u{2013}3")
        let hidden = try h.string("__all('.page').map(function (p) { return p.getAttribute('hidden') === null ? 'v' : 'h'; }).join('')")
        XCTAssertEqual(hidden, "hvhhhhhhhhh")
        try h.eval("__first('.pager-prev').onclick()")
        XCTAssertEqual(try h.string("__first('.pager-current').textContent"), "Question 1 of 9")
        try h.eval("__all('button', __first('.pager-strip'))[10].onclick()")
        XCTAssertEqual(try h.string("__first('.pager-current').textContent"), "Review and hand in")
        XCTAssertTrue(try h.bool("__first('.pager-next').disabled"))
        XCTAssertFalse(try h.bool("__first('.pager-prev').disabled"))
    }

    /// The passage is one element: on the passage page it sits in the page;
    /// on a member question's page it sits inside the collapsed disclosure;
    /// it is never in two places.
    func testThePassageTravelsBetweenItsPageAndTheOpenQuestionsDisclosure() throws {
        let h = try paged()
        // Two stimulus blocks now: this set's, and the sourced set's on its
        // own side_by_side page.
        XCTAssertEqual(try h.int("__count('.stimulus')"), 2)
        try h.eval("__all('button', __first('.pager-strip'))[1].onclick()")
        XCTAssertEqual(try h.int("__count('.stimulus', __all('.page')[1])"), 1)
        XCTAssertEqual(try h.int("__count('.passage-ref', __all('.page')[1])"), 0)
        try h.eval("__first('.pager-next').onclick()")
        XCTAssertEqual(try h.string("__first('.pager-current').textContent"), "Question 2 of 9")
        XCTAssertEqual(try h.int("__count('.stimulus', __all('.page')[2])"), 1)
        XCTAssertEqual(try h.int("__count('.stimulus', __all('.page')[1])"), 0)
        XCTAssertEqual(try h.string("__first('summary', __all('.page')[2]).textContent"), "Show the passage")
        XCTAssertEqual(try h.int("__count('.stimulus')"), 2)
        XCTAssertEqual(try h.int("__count('.passage-ref', __all('.page')[3])"), 1, "Q3 is a member too")
        XCTAssertEqual(try h.int("__count('.passage-ref', __all('.page')[4])"), 0, "Q4 is not")
    }

    func testAnInlineSetIsOnePageWithItsStimulusOnTop() throws {
        let h = try RendererHarness(bundleJSON: #"""
        {"test_id":"t","title":"t","layout":"paged",
         "items":[{"type":"essay","id":"a","stem":"A"},{"type":"essay","id":"b","stem":"B"},{"type":"essay","id":"c","stem":"C"},{"type":"essay","id":"d","stem":"D"}],
         "item_sets":[{"id":"s","stimulus":"Read this.","layout":"inline","item_ids":["b","c"]}]}
        """#)
        XCTAssertEqual(try h.int("__count('.page')"), 4)
        let kinds = try h.string("__all('.page').map(function (p) { return p.getAttribute('data-kind'); }).join(',')")
        XCTAssertEqual(kinds, "question,questions,question,review")
        XCTAssertEqual(try h.string("__all('.page-label')[1].textContent"), "Questions 2\u{2013}3 of 4")
        XCTAssertEqual(try h.string("__all('.page')[1].children[1].className"), "stimulus stimulus-inline")
        XCTAssertEqual(try h.int("__count('.item', __all('.page')[1])"), 2)
        XCTAssertEqual(try h.string("__all('button', __first('.pager-strip'))[1].textContent"), "2\u{2013}3")
    }

    func testTheReviewPageListsEveryQuestionAndCarriesTheHandIn() throws {
        let h = try paged()
        let review = "__all('.page')[10]"
        // Every page but the review itself: nine questions and the passage.
        XCTAssertEqual(try h.int("__count('button', __first('.review-list', \(review)))"), 10)
        XCTAssertEqual(try h.string("__all('button', __first('.review-list', \(review)))[1].textContent"), "Passage for questions 2\u{2013}3")
        XCTAssertEqual(try h.string("__all('button', __first('.review-list', \(review)))[4].textContent"), "Question 4 \u{00b7} not answered")
        XCTAssertEqual(try h.int("__count('.finish', \(review))"), 1)
        XCTAssertEqual(try h.int("__count('.finish')"), 1)
        try h.eval("__all('button', __first('.review-list', \(review)))[4].onclick()")
        XCTAssertEqual(try h.string("__first('.pager-current').textContent"), "Question 4 of 9")
    }

    /// E12: the writing area inside an own_page passage keeps posting after
    /// the passage has travelled into a question's disclosure.
    func testTheOutlineAreaStillPostsFromInsideTheDisclosure() throws {
        let h = try RendererHarness(bundleJSON: #"""
        {"test_id":"t","title":"t","layout":"paged",
         "items":[{"type":"essay","id":"e","stem":"Essay"}],
         "item_sets":[{"id":"s","stimulus":"Your outline:","layout":"own_page","item_ids":["e"],"source_missing":true,"inline_item_id":"outline-q"}]}
        """#)
        XCTAssertEqual(try h.int("__count('.page')"), 3)
        try h.eval("__first('.pager-next').onclick()")
        XCTAssertEqual(try h.int("__count('.outline-text', __all('.page')[1])"), 1)
        try h.eval("var ta = __first('.outline-text', __all('.page')[1]); ta.value = 'I. Claim'; ta.onchange();")
        let last = try h.postedMessages().last
        XCTAssertEqual(last?["item_id"] as? String, "outline-q")
        XCTAssertEqual((last?["response"] as? [String: Any])?["text"] as? String, "I. Claim")
        XCTAssertEqual(try h.int("__count('.outline-text')"), 1)
    }
}

/// Client paging follow-up (D-4): answered marks — seeded from the bundle's
/// answered_item_ids (this attempt's saved answers) and kept current as the
/// page posts. Scroll mode never shows them.
final class RendererAnsweredMarksTests: XCTestCase {
    /// The fixture, paged, with the given item indexes already answered.
    private func paged(answered: [Int]) throws -> RendererHarness {
        var json = try RendererHarness.fixtureJSON()
        let probe = try RendererHarness(bundleJSON: json)
        let ids = try answered.map { try XCTUnwrap(probe.string("BUNDLE.items[\($0)].id")) }
        let list = ids.map { "\"\($0)\"" }.joined(separator: ",")
        let range = try XCTUnwrap(json.range(of: "\"test_id\":"))
        json.replaceSubrange(range, with: "\"layout\": \"paged\", \"answered_item_ids\": [\(list)], \"test_id\":")
        return try RendererHarness(bundleJSON: json)
    }

    private func stripLabel(_ h: RendererHarness, _ i: Int) throws -> String? {
        try h.string("__all('button', __first('.pager-strip'))[\(i)].getAttribute('aria-label')")
    }

    func testSeededAnswersMarkTheStripTheReviewListAndTheCount() throws {
        // Items 0 (Q1) and 3 (Q4): page 0 and page 4 (Q1 · P · Q2 · Q3 · Q4).
        let h = try paged(answered: [0, 3])
        XCTAssertEqual(try h.string("__all('button', __first('.pager-strip'))[0].className"), "answered")
        XCTAssertEqual(try h.string("__all('button', __first('.pager-strip'))[0].textContent"), "1 \u{2713}")
        XCTAssertEqual(try stripLabel(h, 0), "Question 1 of 9, answered")
        XCTAssertEqual(try h.string("__all('button', __first('.pager-strip'))[2].className"), "unanswered")
        XCTAssertEqual(try stripLabel(h, 2), "Question 2 of 9, not answered")
        XCTAssertEqual(try h.string("__all('button', __first('.pager-strip'))[1].className"), "", "a passage has nothing to answer")
        XCTAssertEqual(try stripLabel(h, 1), "Passage for questions 2\u{2013}3")
        let review = "__all('.page')[10]"
        XCTAssertEqual(try h.string("__first('.review-count', \(review)).textContent"), "2 of 9 answered. Go back to any question, or hand in.")
        XCTAssertEqual(try h.string("__all('button', __first('.review-list', \(review)))[0].textContent"), "Question 1 \u{00b7} answered")
        XCTAssertEqual(try h.string("__all('button', __first('.review-list', \(review)))[2].textContent"), "Question 2 \u{00b7} not answered")
    }

    func testPostingAnAnswerMarksItsPage() throws {
        let h = try paged(answered: [])
        XCTAssertEqual(try h.string("__first('.review-count').textContent"), "0 of 9 answered. Go back to any question, or hand in.")
        try h.eval("__all('input', __item(0))[1].onchange()")
        XCTAssertEqual(try h.string("__all('button', __first('.pager-strip'))[0].className"), "answered")
        XCTAssertEqual(try h.string("__first('.review-count').textContent"), "1 of 9 answered. Go back to any question, or hand in.")
    }

    /// Client-fixes batch 1b (#3): Clear answer on an MC item withdraws it,
    /// which must drop the strip mark and the count exactly like an
    /// un-posted item — `refreshMarks` recomputes fully from ANSWERED rather
    /// than only ever adding the class.
    func testClearingAnAnsweredMCItemDropsItsStripMarkAndTheCount() throws {
        // Item 0 (Q1, mc single) seeded answered; page index 0.
        let h = try paged(answered: [0])
        XCTAssertEqual(try h.string("__all('button', __first('.pager-strip'))[0].className"), "answered")
        XCTAssertEqual(try h.string("__first('.review-count').textContent"), "1 of 9 answered. Go back to any question, or hand in.")

        try h.eval("__first('.clear-answer', __item(0)).onclick()")

        XCTAssertEqual(try h.string("__all('button', __first('.pager-strip'))[0].className"), "unanswered")
        XCTAssertEqual(try h.string("__first('.review-count').textContent"), "0 of 9 answered. Go back to any question, or hand in.")
        XCTAssertEqual(try h.postedWithdrawals().count, 1)
    }

    func testADrawingCountsOnceTheHostSaysItIsSaved() throws {
        let h = try paged(answered: [])
        let drawingId = try XCTUnwrap(h.string("BUNDLE.items[7].id"))
        // Page index: Q1 · P · Q2 · Q3 · Q4 · Q5 · Q6 · Q7 · Q8 → item 7 is page 8.
        try h.eval("window.__secureTestDrawingResult('\(drawingId)', false)")
        XCTAssertEqual(try h.string("__all('button', __first('.pager-strip'))[8].className"), "unanswered")
        try h.eval("window.__secureTestDrawingResult('\(drawingId)', true)")
        XCTAssertEqual(try h.string("__all('button', __first('.pager-strip'))[8].className"), "answered")
    }

    func testAnInlineSetPageSaysHowManyOfItsQuestionsAreAnswered() throws {
        let h = try RendererHarness(bundleJSON: #"""
        {"test_id":"t","title":"t","layout":"paged","answered_item_ids":["b"],
         "items":[{"type":"essay","id":"a","stem":"A"},{"type":"essay","id":"b","stem":"B"},{"type":"essay","id":"c","stem":"C"}],
         "item_sets":[{"id":"s","stimulus":"Read.","layout":"inline","item_ids":["b","c"]}]}
        """#)
        XCTAssertEqual(try h.string("__all('button', __first('.pager-strip'))[1].className"), "partial")
        XCTAssertEqual(try stripLabel(h, 1), "Questions 2\u{2013}3 of 3, 1 of 2 answered")
        XCTAssertEqual(try h.string("__all('button', __first('.review-list'))[1].textContent"), "Questions 2\u{2013}3 \u{00b7} 1 of 2 answered")
    }

    func testScrollModeIgnoresTheField() throws {
        var json = try RendererHarness.fixtureJSON()
        let range = try XCTUnwrap(json.range(of: "\"test_id\":"))
        json.replaceSubrange(range, with: "\"answered_item_ids\": [\"anything\"], \"test_id\":")
        let h = try RendererHarness(bundleJSON: json)
        XCTAssertEqual(try h.int("__count('.pager')"), 0)
        XCTAssertEqual(try h.int("__count('.answered')"), 0)
        XCTAssertEqual(try h.string("__root.children[0].className"), "item")
    }
}
