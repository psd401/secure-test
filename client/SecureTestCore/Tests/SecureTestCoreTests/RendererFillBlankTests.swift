import XCTest
@testable import SecureTestCore

/// FB slice 5 (docs/fill-in-blank-design.md): the sentence with its blanks
/// inline. The fixture's fill-in-the-blank item is index 9: "Air rising on the
/// [[b1]] side **cools**, so the dry side is called the [[b2]] side." — b1 a
/// dropdown (windward / leeward / _northern_), b2 typed. Option ids are read
/// off the bundle by their text, never named (a regeneration churns ids).
///
/// FB-S2 (2026-10-07): a dropdown blank is a button + an in-page listbox
/// (`.fill-select` / `.fill-list`), so options can carry emphasis and math;
/// the button's `value` / `onchange()` are the interface the select had.
///
/// What this cannot prove: that WebKit lays the controls out in the line, how
/// the list looks or scrolls, or how VoiceOver announces them — those are the
/// "Fill in the blank (v1.6.0)" rows in client/MANUAL-CHECKS.md.
final class RendererFillBlankTests: XCTestCase {
    private let item = "__item(9)"
    private let stem = "__first('.stem', __item(9))"
    private let select = "__first('.fill-select', __item(9))"
    private let list = "__first('.fill-list', __item(9))"
    private let key = "function (k) { return { key: k, preventDefault: function () {}, stopPropagation: function () {} }; }"
    private let typed = "__first('input', __item(9))"

    private func injected(_ inject: String) throws -> RendererHarness {
        var json = try RendererHarness.fixtureJSON()
        if !inject.isEmpty {
            let range = try XCTUnwrap(json.range(of: "\"test_id\":"))
            json.replaceSubrange(range, with: inject + "\"test_id\":")
        }
        return try RendererHarness(bundleJSON: json)
    }

    private func harness() throws -> RendererHarness { try injected("") }
    private func paged() throws -> RendererHarness { try injected("\"layout\": \"paged\", ") }

    private func optionID(_ h: RendererHarness, text: String) throws -> String {
        try XCTUnwrap(h.string(
            "BUNDLE.items[9].blanks[0].options.filter(function (o) { return o.text === '\(text)'; })[0].id"
        ))
    }

    private func itemID(_ h: RendererHarness) throws -> String {
        try XCTUnwrap(h.string("BUNDLE.items[9].id"))
    }

    /// The strip button for the fill-in-the-blank question, found by label.
    private func stripClass(_ h: RendererHarness) throws -> String? {
        try h.string(
            "__all('button', __first('.pager-strip')).filter(function (b) {"
            + " return (b.getAttribute('aria-label') || '').indexOf('Question 10 of 10') === 0; })[0].className"
        )
    }

    private func lastAnswers(_ h: RendererHarness) throws -> [String: String]? {
        let response = try h.postedMessages().last?["response"] as? [String: Any]
        XCTAssertEqual(response?["type"] as? String, "fill_blank")
        return response?["answers"] as? [String: String]
    }

    // MARK: - Rendering

    func testTheBlanksSitInsideTheSentenceInStemOrder() throws {
        let h = try harness()
        XCTAssertEqual(
            try h.string("\(stem).children.map(function (n) { return n.tagName; }).join(',')"),
            "#text,span,#text,strong,#text,input,#text"
        )
        XCTAssertEqual(try h.string("\(stem).children[0].textContent"), "Air rising on the ")
        XCTAssertEqual(try h.string("\(stem).children[3].textContent"), "cools")
        XCTAssertEqual(try h.string("\(stem).children[6].textContent"), " side.")
        XCTAssertFalse(try h.string("\(stem).textContent")?.contains("[[") ?? true, "no marker shows")
        // The answer block holds no second copy of the controls.
        XCTAssertEqual(try h.int("__count('.fill-select', \(item))"), 1)
        XCTAssertEqual(try h.int("__count('select', \(item))"), 0, "no native select (FB-S2)")
        XCTAssertEqual(try h.int("__count('input', \(item))"), 1)
    }

    func testEachBlankIsNamedByItsNumberForAssistiveTechnology() throws {
        let h = try harness()
        // The pick is named by a hidden label plus its shown value.
        let label = try XCTUnwrap(h.string("__first('.fill-pick-label', \(item)).id"))
        XCTAssertEqual(try h.string("__first('.fill-pick-label', \(item)).textContent"), "Blank 1")
        XCTAssertTrue(try h.string("\(select).getAttribute('aria-labelledby')")?.hasPrefix(label + " ") ?? false)
        XCTAssertEqual(try h.string("\(select).getAttribute('aria-haspopup')"), "listbox")
        XCTAssertEqual(try h.string("\(select).getAttribute('aria-expanded')"), "false")
        XCTAssertEqual(try h.string("\(list).getAttribute('role')"), "listbox")
        XCTAssertEqual(try h.string("\(typed).getAttribute('aria-label')"), "Blank 2")
    }

    /// D-6: the teacher's order, after "Choose…"; FB-S2: an option keeps its
    /// emphasis (`_northern_` is an <em>) instead of being stripped.
    func testTheDropdownOffersItsOptionsInTheTeachersOrder() throws {
        let h = try harness()
        let options = "__all('.fill-option', \(item))"
        XCTAssertEqual(
            try h.string("\(options).map(function (o) { return o.textContent; }).join('|')"),
            "Choose…|windward|leeward|northern"
        )
        XCTAssertEqual(try h.int("__count('em', \(options)[3])"), 1)
        XCTAssertEqual(try h.string("\(options)[1].getAttribute('role')"), "option")
        XCTAssertEqual(try h.string("\(select).__options[0].id"), "")
        XCTAssertEqual(try h.string("\(select).__options[1].id"), try optionID(h, text: "windward"))
        XCTAssertTrue(try h.bool("\(list).hidden"), "closed until opened")
        XCTAssertEqual(try h.string("__first('.fill-select-value', \(item)).textContent"), "Choose…")
    }

    /// FB-S2: math in an option renders through the same pass as the stem,
    /// in the list AND on the button once picked.
    func testOptionMathRendersInTheListAndOnTheButton() throws {
        let h = try RendererHarness(bundleJSON: #"""
        {"test_id":"t","title":"t","items":[{"type":"fill_blank","id":"f","stem":"Half is [[b1]].",
          "blanks":[{"id":"b1","kind":"dropdown","options":[{"id":"o1","text":"$\\frac{1}{2}$"},{"id":"o2","text":"two"}]}]}]}
        """#, prelude: "var katex = { render: function (tex, span) { span.className = 'katex'; span.appendChild(document.createTextNode('K[' + tex + ']')); } };")
        XCTAssertEqual(try h.string("__all('.fill-option')[1].textContent"), "K[\\frac{1}{2}]")
        try h.eval("__first('.fill-select').value = 'o1'; __first('.fill-select').onchange();")
        XCTAssertEqual(try h.string("__first('.fill-select-value').textContent"), "K[\\frac{1}{2}]")
    }

    func testTheTypedBlankIsAPlainTextFieldOnTheSpellCheckGate() throws {
        let h = try harness()
        XCTAssertEqual(try h.string("\(typed).type"), "text")
        XCTAssertEqual(try h.string("\(typed).className"), "fill-text")
        XCTAssertEqual(try h.string("\(typed).autocomplete"), "off")
        XCTAssertEqual(try h.int("\(typed).maxLength"), 500)
        // The fixture's student has spell_check On.
        XCTAssertTrue(try h.bool("\(typed).spellcheck"))
        let off = try RendererHarness(bundleJSON: #"""
        {"test_id":"t","title":"t","items":[{"type":"fill_blank","id":"f","stem":"A [[b1]].",
          "blanks":[{"id":"b1","kind":"text"}]}]}
        """#)
        XCTAssertFalse(try off.bool("__first('input').spellcheck"))
        XCTAssertEqual(try off.int("__count('.math-keys-toggle')"), 0, "no keypad on a blank (v1)")
    }

    /// The v1.3.5 rule: a button carries tabindex 0 and the list -1 (one stop
    /// per blank); a text field is reached natively. DOM order is sentence
    /// order, so Tab goes Blank 1, Blank 2.
    func testEveryBlankIsATabStopInSentenceOrder() throws {
        let h = try harness()
        XCTAssertEqual(try h.string("\(select).getAttribute('tabindex')"), "0")
        XCTAssertEqual(try h.string("\(list).getAttribute('tabindex')"), "-1")
        XCTAssertEqual(
            try h.string("\(stem).children.filter(function (n) { return n.className === 'fill-pick' || n.tagName === 'input'; })"
                + ".map(function (n) { return n.tagName === 'input' ? n.getAttribute('aria-label') : n.children[0].textContent; }).join(',')"),
            "Blank 1,Blank 2"
        )
    }

    // MARK: - The pick control (FB-S2)

    /// Down on the button opens the list on the current pick; Down moves;
    /// Enter picks, posts, closes, and gives focus back to the button.
    func testTheKeyboardOpensMovesAndPicks() throws {
        let h = try harness()
        let leeward = try optionID(h, text: "leeward")
        try h.eval("var __k = \(key); \(select).onkeydown(__k('ArrowDown'));")
        XCTAssertFalse(try h.bool("\(list).hidden"))
        XCTAssertEqual(try h.string("\(select).getAttribute('aria-expanded')"), "true")
        XCTAssertTrue(try h.bool("document.activeElement === \(list)"))
        XCTAssertEqual(try h.string("__first('.active', \(list)).textContent"), "Choose…")
        try h.eval("\(list).onkeydown(__k('ArrowDown')); \(list).onkeydown(__k('ArrowDown'));")
        XCTAssertEqual(try h.string("__first('.active', \(list)).textContent"), "leeward")
        XCTAssertEqual(try h.string("\(list).getAttribute('aria-activedescendant')"), try h.string("__first('.active', \(list)).id"))
        XCTAssertEqual(try h.postedMessages().count, 0, "moving never posts")
        try h.eval("\(list).onkeydown(__k('Enter'));")
        XCTAssertEqual(try lastAnswers(h), ["b1": leeward])
        XCTAssertTrue(try h.bool("\(list).hidden"))
        XCTAssertTrue(try h.bool("document.activeElement === \(select)"))
        XCTAssertEqual(try h.string("__first('.fill-select-value', \(item)).textContent"), "leeward")
        XCTAssertEqual(try h.string("__all('.fill-option', \(item))[2].getAttribute('aria-selected')"), "true")
        // Reopening starts on the pick; End / Home clamp.
        try h.eval("\(select).onclick(); \(list).onkeydown(__k('End'));")
        XCTAssertEqual(try h.string("__first('.active', \(list)).textContent"), "northern")
        try h.eval("\(list).onkeydown(__k('ArrowDown')); \(list).onkeydown(__k('Home'));")
        XCTAssertEqual(try h.string("__first('.active', \(list)).textContent"), "Choose…")
    }

    /// Escape and Tab close without picking; a letter jumps to the next
    /// option starting with it (emphasis markers ignored).
    func testEscapeAndTabCloseWithoutPostingAndALetterJumps() throws {
        let h = try harness()
        try h.eval("var __k = \(key); \(select).onclick(); \(list).onkeydown(__k('n'));")
        XCTAssertEqual(try h.string("__first('.active', \(list)).textContent"), "northern")
        try h.eval("\(list).onkeydown(__k('Escape'));")
        XCTAssertTrue(try h.bool("\(list).hidden"))
        XCTAssertTrue(try h.bool("document.activeElement === \(select)"))
        try h.eval("\(select).onclick(); \(list).onkeydown(__k('ArrowDown')); \(list).onkeydown(__k('Tab'));")
        XCTAssertTrue(try h.bool("\(list).hidden"))
        XCTAssertEqual(try h.postedMessages().count, 0)
        XCTAssertEqual(try h.string("\(select).value"), "")
    }

    /// A pointer pick posts; picking "Choose…" takes the answer back
    /// (withdrawn — the item's only answered blank); clicking the button
    /// while open closes it rather than reopening it.
    func testAPointerPickAndChooseTakesItBack() throws {
        let h = try harness()
        let windward = try optionID(h, text: "windward")
        try h.eval("\(select).onclick(); __all('.fill-option', \(item))[1].onclick();")
        XCTAssertEqual(try lastAnswers(h), ["b1": windward])
        try h.eval("\(select).onclick(); __all('.fill-option', \(item))[0].onclick();")
        XCTAssertEqual(try h.postedWithdrawals().count, 1)
        XCTAssertEqual(try h.string("__first('.fill-select-value', \(item)).textContent"), "Choose…")
        // Open, then a mousedown on the button blurs the list (closing it)
        // before the click: the click must not reopen it.
        try h.eval("\(select).onclick(); \(select).onmousedown(); \(list).onblur(); \(select).onclick();")
        XCTAssertTrue(try h.bool("\(list).hidden"))
    }

    /// FB-S1 (2026-10-07 sitting): emphasis around or spanning a blank renders
    /// — no literal `**` / `_` — and the control sits inside the <strong> /
    /// <em>.
    func testEmphasisAroundABlankRendersAndHoldsTheControl() throws {
        let h = try RendererHarness(bundleJSON: #"""
        {"test_id":"t","title":"t","items":[{"type":"fill_blank","id":"f",
          "stem":"Air on the **[[b1]]** side and _the [[b2]] gap_.",
          "blanks":[{"id":"b1","kind":"dropdown","options":[{"id":"o1","text":"x"},{"id":"o2","text":"y"}]},
                    {"id":"b2","kind":"text"}]}]}
        """#)
        let stemText = try XCTUnwrap(h.string("__first('.stem').textContent"))
        XCTAssertFalse(stemText.contains("**"), stemText)
        XCTAssertFalse(stemText.contains("_"), stemText)
        XCTAssertEqual(try h.int("__count('.fill-pick', __first('strong', __first('.stem')))"), 1)
        XCTAssertEqual(try h.int("__count('input', __first('em', __first('.stem')))"), 1)
        XCTAssertEqual(try h.string("__first('input').getAttribute('aria-label')"), "Blank 2")
        XCTAssertEqual(try h.int("__count('.fill-unplaced')"), 0)
    }

    /// The design-tool preview's rule: an unknown marker and a repeated
    /// marker's second occurrence stay literal; a blank no marker places is
    /// rendered after the sentence, numbered last, so it can still be answered.
    func testOddMarkersStayLiteralAndAnUnplacedBlankComesLast() throws {
        let h = try RendererHarness(bundleJSON: #"""
        {"test_id":"t","title":"t","items":[{"type":"fill_blank","id":"f",
          "stem":"One [[b1]], again [[b1]], unknown [[zz]].",
          "blanks":[{"id":"b1","kind":"text"},
                    {"id":"b2","kind":"dropdown","options":[{"id":"o1","text":"x"},{"id":"o2","text":"y"}]}]}]}
        """#)
        let stemText = try XCTUnwrap(h.string("__first('.stem').textContent"))
        XCTAssertTrue(stemText.contains("again [[b1]], unknown [[zz]]."), stemText)
        XCTAssertEqual(try h.int("__count('input', __first('.stem'))"), 1)
        XCTAssertEqual(try h.int("__count('.fill-select', __first('.stem'))"), 0)
        XCTAssertEqual(try h.int("__count('.fill-unplaced')"), 1)
        XCTAssertEqual(try h.string("__first('.fill-pick-label', __first('.fill-unplaced')).textContent"), "Blank 2")
        XCTAssertEqual(try h.string("__first('.fill-unplaced').children[0].textContent"), "Blank 2: ")
    }

    // MARK: - Posting

    func testAPickPostsAtOnceAndTypingPostsTheWholeMap() throws {
        let h = try harness()
        let windward = try optionID(h, text: "windward")
        try h.eval("\(select).value = '\(windward)'; \(select).onchange();")
        XCTAssertEqual(try h.postedMessages().count, 1)
        XCTAssertEqual(try h.postedMessages()[0]["item_id"] as? String, try itemID(h))
        XCTAssertEqual(try lastAnswers(h), ["b1": windward])

        try h.eval("\(typed).value = 'Rain shadow'; \(typed).onchange();")
        XCTAssertEqual(try h.postedMessages().count, 2)
        XCTAssertEqual(try lastAnswers(h), ["b1": windward, "b2": "Rain shadow"])
    }

    /// The text autosave rules (5 s idle) apply to a typed blank, and the
    /// autosave sends the whole map, as `change` does.
    func testATypedBlankAutosaves() throws {
        let h = try harness()
        try h.eval("\(typed).value = 'lee'; \(typed).oninput();")
        XCTAssertEqual(try h.postedMessages().count, 0)
        try h.eval("__fireTimers()")
        XCTAssertEqual(try h.postedMessages().count, 1)
        XCTAssertEqual(try lastAnswers(h), ["b2": "lee"])
    }

    /// Nothing answered is the absence of a response: clearing every blank
    /// after a save withdraws it; a whitespace-only field never posts.
    func testClearingEveryBlankWithdrawsAndBlankTextNeverPosts() throws {
        let h = try harness()
        try h.eval("\(typed).value = '   '; \(typed).onchange();")
        XCTAssertEqual(try h.postedMessages().count, 0)
        XCTAssertEqual(try h.postedWithdrawals().count, 0, "nothing was saved, nothing to withdraw")

        let leeward = try optionID(h, text: "leeward")
        try h.eval("\(select).value = '\(leeward)'; \(select).onchange();")
        XCTAssertEqual(try lastAnswers(h), ["b1": leeward])
        try h.eval("\(select).value = ''; \(select).onchange();")
        XCTAssertEqual(try h.postedMessages().count, 1, "an empty map is never posted")
        XCTAssertEqual(try h.postedWithdrawals().count, 1)
        XCTAssertEqual(try h.postedWithdrawals()[0]["item_id"] as? String, try itemID(h))
    }

    // MARK: - Answered mark (the match rule)

    func testMarkWaitsForEveryBlankAndDropsWhenOneIsCleared() throws {
        let h = try paged()
        let windward = try optionID(h, text: "windward")
        XCTAssertEqual(try stripClass(h), "unanswered")
        try h.eval("\(select).value = '\(windward)'; \(select).onchange();")
        XCTAssertEqual(try stripClass(h), "unanswered", "one of two blanks")
        try h.eval("\(typed).value = 'leeward'; \(typed).onchange();")
        XCTAssertEqual(try stripClass(h), "answered")
        try h.eval("\(typed).value = ''; \(typed).onchange();")
        XCTAssertEqual(try stripClass(h), "unanswered")
        XCTAssertEqual(try lastAnswers(h), ["b1": windward], "the partial answer is still saved")
    }

    // MARK: - Resume (P-1)

    func testASavedAnswerComesBackSilentlyAndMarked() throws {
        let probe = try harness()
        let id = try itemID(probe)
        let leeward = try optionID(probe, text: "leeward")
        let h = try injected(
            "\"layout\": \"paged\", \"answered_item_ids\": [\"\(id)\"], "
            + "\"saved_responses\": {\"\(id)\": {\"type\": \"fill_blank\", \"answers\": {\"b1\": \"\(leeward)\", \"b2\": \"rain shadow\"}}}, "
        )
        XCTAssertEqual(try h.string("\(select).value"), leeward)
        XCTAssertEqual(try h.string("\(typed).value"), "rain shadow")
        XCTAssertEqual(try h.postedMessages().count, 0, "a restore must not post")
        XCTAssertEqual(try h.postedWithdrawals().count, 0)
        XCTAssertEqual(try stripClass(h), "answered")
        // The restored text is the autosave baseline: a blur without a change
        // posts nothing.
        try h.eval("\(typed).onchange();")
        XCTAssertEqual(try h.postedMessages().count, 0)
    }

    func testARestoredPartialAnswerStartsUnmarkedAndAnUnknownOptionIsNotSelected() throws {
        let probe = try harness()
        let id = try itemID(probe)
        let h = try injected(
            "\"layout\": \"paged\", \"answered_item_ids\": [\"\(id)\"], "
            + "\"saved_responses\": {\"\(id)\": {\"type\": \"fill_blank\", \"answers\": {\"b1\": \"gone\"}}}, "
        )
        XCTAssertEqual(try h.string("\(select).value || ''"), "", "left on Choose…")
        XCTAssertEqual(try stripClass(h), "unanswered")
        // Clearing what the server holds still withdraws it.
        try h.eval("\(typed).value = 'x'; \(typed).onchange(); \(typed).value = ''; \(typed).onchange();")
        XCTAssertEqual(try h.postedWithdrawals().count, 1)
    }

    // MARK: - Read-aloud

    /// The question's Speak reads a blank as "blank n" — never what fills it —
    /// and then each dropdown's options, as a match's are read.
    func testSpeakReadsTheGapsAndTheOptionsButNotThePick() throws {
        let h = try RendererHarness(
            bundleJSON: try RendererHarness.fixtureJSON(),
            prelude: "var TTS_SCOPE = { items: true, stimuli: false, responses: false };")
        let windward = try optionID(h, text: "windward")
        try h.eval("\(select).value = '\(windward)';")
        try h.eval("__first('.tts-play', \(item)).onclick()")
        let segments = try XCTUnwrap(try h.postedSpeech().last?["segments"] as? [[String: String]])
        let spoken = segments.map { $0["text"] ?? "[\($0["tex"] ?? "")]" }.joined()
        XCTAssertTrue(spoken.hasPrefix("Air rising on the  blank 1  side cools, so the dry side is called the  blank 2  side."), spoken)
        XCTAssertTrue(spoken.hasSuffix(" Blank 1 options: windward, leeward, northern, "), spoken)
    }

    /// "Read my answer": each answered blank by number, a pick as its option
    /// text; empty blanks are skipped.
    func testReadMyAnswerReadsEachAnsweredBlank() throws {
        let h = try RendererHarness(
            bundleJSON: try RendererHarness.fixtureJSON(),
            prelude: "var TTS_SCOPE = { items: false, stimuli: false, responses: true };")
        let play = "__first('.tts-play', \(item))"
        XCTAssertEqual(try h.int("__all('.tts-play', \(item)).length"), 1)
        XCTAssertEqual(try h.string("\(play).textContent"), "Read my answer")
        try h.eval("\(play).onclick()")
        var segments = try XCTUnwrap(try h.postedSpeech().last?["segments"] as? [[String: String]])
        XCTAssertEqual(segments.map { $0["text"] ?? "" }.joined(), "No answer yet.")

        try h.eval("__first('.tts-stop', \(item)).onclick({ detail: 1 })")
        let leeward = try optionID(h, text: "leeward")
        try h.eval("\(select).value = '\(leeward)'; \(typed).value = 'rain shadow';")
        try h.eval("\(play).onclick()")
        segments = try XCTUnwrap(try h.postedSpeech().last?["segments"] as? [[String: String]])
        XCTAssertEqual(segments.map { $0["text"] ?? "" }.joined(), "Blank 1: leeward. Blank 2: rain shadow. ")
    }
}
