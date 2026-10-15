import XCTest
@testable import SecureTestCore

/// Exercises the renderer for real via JavaScriptCore (see RendererHarness),
/// against the fixture the design tool's own delivery route produced.
final class RendererBehaviourTests: XCTestCase {
    private func harness() throws -> RendererHarness {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/delivery-bundle.json")
        return try RendererHarness(bundleJSON: try String(contentsOf: url, encoding: .utf8))
    }

    // Fixture order matches the seeded positions.
    private enum Index {
        static let mcSingle = 0, mcMulti = 1, shortText = 2, essay = 3
        static let match = 4, order = 5, hotspot = 6, drawing = 7, table = 8, fillBlank = 9
    }

    func testRendersOneBlockPerItem() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('.item')"), 10)
    }

    func testStemsRenderAsText() throws {
        let h = try harness()
        XCTAssertEqual(
            try h.string("__first('.stem', __item(\(Index.mcSingle))).textContent"),
            "Which organelle produces ATP?"
        )
    }

    /// The stem contains a literal `</script><b>not markup</b>`. It must reach
    /// the page as characters — the renderer builds text nodes, never markup.
    func testMarkupShapedStemStaysText() throws {
        let h = try harness()
        let stem = try h.string("__first('.stem', __item(\(Index.mcMulti))).textContent")
        XCTAssertEqual(stem, "Select all prime numbers. </script><b>not markup</b>")
        // If it had been parsed, there would be a <b> element in the tree.
        XCTAssertEqual(try h.int("__count('b', __item(\(Index.mcMulti)))"), 0)
    }

    func testSingleSelectRendersRadiosAndPostsTheChosenID() throws {
        let h = try harness()
        let item = "__item(\(Index.mcSingle))"
        XCTAssertEqual(try h.int("__count('input', \(item))"), 3)
        XCTAssertEqual(try h.string("__first('input', \(item)).type"), "radio")

        try h.eval("__all('input', \(item))[1].onchange()")
        let messages = try h.postedMessages()
        XCTAssertEqual(messages.count, 1)
        let response = messages[0]["response"] as? [String: Any]
        XCTAssertEqual(response?["type"] as? String, "multiple_choice_single")
        XCTAssertEqual(response?["choice_id"] as? String, "c2")
    }

    func testMultiSelectPostsEveryCheckedID() throws {
        let h = try harness()
        let item = "__item(\(Index.mcMulti))"
        XCTAssertEqual(try h.string("__first('input', \(item)).type"), "checkbox")

        try h.eval("""
        var boxes = __all('input', \(item));
        boxes[0].checked = true; boxes[0].onchange();
        boxes[2].checked = true; boxes[2].onchange();
        """)
        let messages = try h.postedMessages()
        XCTAssertEqual(messages.count, 2)
        let last = messages[1]["response"] as? [String: Any]
        XCTAssertEqual(last?["type"] as? String, "multiple_choice_multi")
        XCTAssertEqual(last?["choice_ids"] as? [String], ["c1", "c3"])
    }

    /// Clearing every box has nothing valid to send — the wire schema requires
    /// at least one id and an unanswered item is the ABSENCE of a response. The
    /// renderer must not post something the server rejects; since client-fixes
    /// batch 1b it withdraws the saved response instead of doing nothing
    /// (RendererClearAnswerTests covers the withdrawal itself).
    func testClearingEveryCheckboxPostsNothing() throws {
        let h = try harness()
        let item = "__item(\(Index.mcMulti))"
        try h.eval("""
        var boxes = __all('input', \(item));
        boxes[0].checked = true; boxes[0].onchange();
        boxes[0].checked = false; boxes[0].onchange();
        """)
        XCTAssertEqual(try h.postedMessages().count, 1)
    }

    func testShortTextPostsItsValue() throws {
        let h = try harness()
        let item = "__item(\(Index.shortText))"
        try h.eval("""
        var field = __first('input', \(item));
        field.value = 'photosynthesis';
        field.onchange();
        """)
        let response = try h.postedMessages().last?["response"] as? [String: Any]
        XCTAssertEqual(response?["type"] as? String, "short_text")
        XCTAssertEqual(response?["text"] as? String, "photosynthesis")
    }

    /// AAC-2b follow-up 3.3: short_text follows the same per-student
    /// spell-check gate as essay — autocomplete stays off for everyone.
    func testShortTextSpellCheckFollowsTheStudentsAccommodations() throws {
        // The fixture's student is entitled to spell_check.
        let h = try harness()
        let item = "__item(\(Index.shortText))"
        XCTAssertEqual(try h.string("__first('input', \(item)).autocomplete"), "off")
        XCTAssertTrue(try h.bool("__first('input', \(item)).spellcheck"))

        let notEntitled = try RendererHarness(bundleJSON: """
        {"test_id":"t","title":"T","items":[{"type":"short_text","id":"i","stem":"s"}]}
        """)
        XCTAssertFalse(try notEntitled.bool("__first('input').spellcheck"))
    }

    // MARK: essay (slice 54)

    func testEssayRendersATextareaWithItsPlaceholder() throws {
        let h = try harness()
        let item = "__item(\(Index.essay))"
        XCTAssertEqual(try h.int("__count('textarea', \(item))"), 1)
        XCTAssertEqual(
            try h.string("__first('textarea', \(item)).placeholder"),
            "Write your response here…"
        )
    }

    func testEssayPostsItsText() throws {
        let h = try harness()
        let item = "__item(\(Index.essay))"
        try h.eval("""
        var area = __first('textarea', \(item));
        area.value = 'The author builds their argument with evidence.';
        area.onchange();
        """)
        let response = try h.postedMessages().last?["response"] as? [String: Any]
        XCTAssertEqual(response?["type"] as? String, "essay")
        XCTAssertEqual(
            response?["text"] as? String,
            "The author builds their argument with evidence."
        )
    }

    func testEssayWordCounterStartsAtZeroAndTracksTyping() throws {
        let h = try harness()
        let item = "__item(\(Index.essay))"
        XCTAssertEqual(try h.string("__first('.word-count', \(item)).textContent"), "0 / 400 words")

        try h.eval("""
        var area = __first('textarea', \(item));
        area.value = '  one   two \\n three  ';
        area.oninput();
        """)
        // Whitespace-separated tokens, matching what a student would count.
        XCTAssertEqual(try h.string("__first('.word-count', \(item)).textContent"), "3 / 400 words")
    }

    /// Over-limit is flagged, never truncated: silently deleting a student's
    /// words is a worse failure than an over-length response.
    func testEssayFlagsOverLimitWithoutTruncatingTheText() throws {
        let h = try harness()
        let item = "__item(\(Index.essay))"
        try h.eval("""
        var area = __first('textarea', \(item));
        var words = [];
        for (var i = 0; i < 401; i++) words.push('word');
        area.value = words.join(' ');
        area.oninput();
        """)
        XCTAssertEqual(try h.string("__first('.word-count', \(item)).className"), "word-count over")
        XCTAssertEqual(try h.int("__first('textarea', \(item)).value.split(' ').length"), 401)
    }

    // MARK: - WC-2: the word count VoiceOver hears

    private static let liveJS = "__all('.sr-only', __item(0)).filter(function (n) { return n.id.indexOf('essay-count-live-') === 0; })[0].textContent"

    /// The textarea was named only by its placeholder and linked to its count
    /// by nothing (WC-2). WC-3: its name is just "Your answer"; the count,
    /// worded for listening, is the hidden node right after the visible
    /// counter (which VoiceOver skips), so moving on from the box reaches it.
    func testAPlainEssayIsNamedAndItsSpokenCountFollowsTheCounter() throws {
        let h = try RendererHarness(bundleJSON: """
        {"test_id":"t","title":"T","items":[{"type":"essay","id":"i","stem":"s","max_word_count":50}]}
        """)
        let area = "__first('textarea', __item(0))"
        XCTAssertEqual(try h.string("__accessibleName(\(area))"), "Your answer")
        XCTAssertEqual(try h.string("__spokenCount(\(area))"), "0 of 50 words")
        XCTAssertEqual(try h.string("__first('.word-count', __item(0)).getAttribute('aria-hidden')"), "true")
        XCTAssertNil(try h.string("\(area).getAttribute('aria-describedby')"))
        // The label is read only as the name, never on its own.
        XCTAssertEqual(try h.string("__all('.sr-only', __item(0)).filter(function (n) { return n.id.indexOf('essay-label-') === 0; })[0].getAttribute('aria-hidden')"), "true")
        // The spoken count is the node right after the visible counter.
        XCTAssertEqual(try h.string("(function () { var c = __first('.word-count', __item(0)); var k = c.parentNode.children; return k[k.indexOf(c) + 1].id; })()"), "essay-count-spoken-i")
        try h.eval("var a = \(area); a.value = 'one two three'; a.oninput();")
        XCTAssertEqual(try h.string("__accessibleName(\(area))"), "Your answer")
        XCTAssertEqual(try h.string("__spokenCount(\(area))"), "3 of 50 words")
        XCTAssertEqual(try h.string("__first('.word-count', __item(0)).textContent"), "3 / 50 words")
    }

    /// Over the maximum is SAID ("over the limit"), not only coloured, and
    /// crossing it is announced once each way — staying over says nothing new.
    func testAPlainEssayAnnouncesCrossingTheLimitOnceEachWay() throws {
        let h = try RendererHarness(bundleJSON: """
        {"test_id":"t","title":"T","items":[{"type":"essay","id":"i","stem":"s","max_word_count":3}]}
        """)
        let area = "__first('textarea', __item(0))"
        XCTAssertEqual(try h.string(Self.liveJS), "")
        try h.eval("var a = \(area); a.value = 'one two three four'; a.oninput();")
        XCTAssertEqual(try h.string("__accessibleName(\(area))"), "Your answer")
        XCTAssertEqual(try h.string("__spokenCount(\(area))"), "4 of 3 words, over the limit")
        XCTAssertEqual(try h.string(Self.liveJS), "Over the 3-word limit")
        // Still over: the live text is unchanged, so nothing is re-announced.
        try h.eval("var a = \(area); a.value = 'one two three four five'; a.oninput();")
        XCTAssertEqual(try h.string(Self.liveJS), "Over the 3-word limit")
        try h.eval("var a = \(area); a.value = 'one two'; a.oninput();")
        XCTAssertEqual(try h.string("__accessibleName(\(area))"), "Your answer")
        XCTAssertEqual(try h.string("__spokenCount(\(area))"), "2 of 3 words")
        XCTAssertEqual(try h.string(Self.liveJS), "Back within the limit")
    }

    /// U-22's count without a maximum: "n words" in the name, never "over",
    /// never announced.
    func testAPlainEssayWithACountButNoMaximumNeverAnnounces() throws {
        let h = try RendererHarness(bundleJSON: """
        {"test_id":"t","title":"T","items":[{"type":"essay","id":"i","stem":"s","show_word_count":true}]}
        """)
        let area = "__first('textarea', __item(0))"
        try h.eval("var a = \(area); a.value = 'one'; a.oninput();")
        XCTAssertEqual(try h.string("__accessibleName(\(area))"), "Your answer")
        XCTAssertEqual(try h.string("__spokenCount(\(area))"), "1 word")
        XCTAssertEqual(try h.string(Self.liveJS), "")
    }

    /// No count at all: the textarea is still named, and nothing else is added.
    func testAPlainEssayWithoutACountIsStillNamed() throws {
        let h = try RendererHarness(bundleJSON: """
        {"test_id":"t","title":"T","items":[{"type":"essay","id":"i","stem":"s"}]}
        """)
        XCTAssertEqual(try h.string("__accessibleName(__first('textarea', __item(0)))"), "Your answer")
        XCTAssertEqual(try h.int("__count('.sr-only', __item(0))"), 1)
    }

    /// The hidden text is hidden by a stylesheet rule, not by display:none
    /// (which would take it out of what VoiceOver reads).
    func testTheStylesheetHasTheScreenReaderOnlyRule() throws {
        let css = AssessmentPage.html(title: "T", bundleJSON: "{}")
        XCTAssertTrue(css.contains(".sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }"))
    }

    /// WC-1 (2026-10-13): the `over` class above had no rule, so an
    /// over-limit count looked like any other count.
    func testTheStylesheetColoursAnOverLimitCount() throws {
        let css = AssessmentPage.html(title: "T", bundleJSON: "{}")
        XCTAssertTrue(css.contains(".word-count.over { color: var(--danger); font-weight: 600; }"))
    }

    /// Slice 62: spell-check follows THIS STUDENT's effective accommodations,
    /// so two children sitting the same assessment can get different answers.
    /// macOS AAC does not restrict spell-check the way iPadOS does, which makes
    /// this WebKit attribute the only control that exists.
    func testEssaySpellCheckFollowsTheStudentsAccommodations() throws {
        // The fixture's student is entitled to spell_check.
        let h = try harness()
        XCTAssertTrue(try h.bool("__first('textarea', __item(\(Index.essay))).spellcheck"))

        let entitled = try RendererHarness(bundleJSON: """
        {"test_id":"t","title":"T","accommodations":{"spell_check":"On"},
         "items":[{"type":"essay","id":"i","stem":"s"}]}
        """)
        XCTAssertTrue(try entitled.bool("__first('textarea').spellcheck"))

        let notEntitled = try RendererHarness(bundleJSON: """
        {"test_id":"t","title":"T","items":[{"type":"essay","id":"i","stem":"s"}]}
        """)
        XCTAssertFalse(try notEntitled.bool("__first('textarea').spellcheck"))
    }

    func testEssayShowsAVisibleRubric() throws {
        let h = try harness()
        let item = "__item(\(Index.essay))"
        XCTAssertEqual(try h.int("__count('.rubric', \(item))"), 1)
        XCTAssertEqual(
            try h.string("__first('.rubric-criterion-name', \(item)).textContent"),
            "Use of evidence"
        )
        XCTAssertEqual(try h.int("__count('.rubric-level', \(item))"), 2)
        let firstLevel = try h.string("__all('.rubric-level', \(item))[0].textContent")
        XCTAssertEqual(firstLevel, "Emerging (1 pts) — Cites no evidence.")
    }

    /// A hidden rubric never leaves the server, so the client's correct
    /// behaviour is simply to render nothing when the field is absent.
    func testEssayWithoutARubricRendersNoRubricBlock() throws {
        let h = try RendererHarness(bundleJSON: """
        {"test_id":"t","title":"T","items":[
          {"type":"essay","id":"i","stem":"s","max_word_count":100}]}
        """)
        XCTAssertEqual(try h.int("__count('.rubric')"), 0)
        XCTAssertEqual(try h.int("__count('.word-count')"), 1)
    }

    /// U-22: the teacher's "Show students a word count" with no maximum —
    /// a plain running count, never flagged over.
    func testEssayShowWordCountWithoutACapCountsWithNoLimit() throws {
        let h = try RendererHarness(bundleJSON: """
        {"test_id":"t","title":"T","items":[{"type":"essay","id":"i","stem":"s","show_word_count":true}]}
        """)
        XCTAssertEqual(try h.int("__count('.word-count')"), 1)
        XCTAssertEqual(try h.string("__first('.word-count', __item(0)).textContent"), "0 words")
        try h.eval("var area = __first('textarea', __item(0)); area.value = 'one'; area.oninput();")
        XCTAssertEqual(try h.string("__first('.word-count', __item(0)).textContent"), "1 word")
        try h.eval("""
        var area = __first('textarea', __item(0));
        var words = [];
        for (var i = 0; i < 5000; i++) words.push('word');
        area.value = words.join(' ');
        area.oninput();
        """)
        XCTAssertEqual(try h.string("__first('.word-count', __item(0)).textContent"), "5000 words")
        XCTAssertEqual(try h.string("__first('.word-count', __item(0)).className"), "word-count")
    }

    /// U-22 decision 2.2: a maximum always shows "n / max", flag or not.
    func testEssayShowWordCountWithACapKeepsTheLimitCounter() throws {
        let h = try RendererHarness(bundleJSON: """
        {"test_id":"t","title":"T","items":[{"type":"essay","id":"i","stem":"s","max_word_count":50,"show_word_count":true}]}
        """)
        XCTAssertEqual(try h.string("__first('.word-count', __item(0)).textContent"), "0 / 50 words")
    }

    func testEssayWithoutAWordCapShowsNoCounter() throws {
        let h = try RendererHarness(bundleJSON: """
        {"test_id":"t","title":"T","items":[{"type":"essay","id":"i","stem":"s"}]}
        """)
        XCTAssertEqual(try h.int("__count('.word-count')"), 0)
    }

}
