import XCTest
@testable import SecureTestCore

/// TTS slice 1 (`docs/speech-tools-design.md`): the page half of read-aloud —
/// which blocks get a Speak control for each scope, what the page sends on the
/// `tts` channel (the spoken form, never markup), the per-utterance controls,
/// the word highlight mapped back onto the page's own text, and the stop on a
/// page turn, a source-tab change and Finish.
///
/// What this cannot prove: that a voice is heard, that WebKit paints the
/// `::highlight` pseudo-element, or that a contrast set colours it — those are
/// hand-run rows (`client/MANUAL-CHECKS.md`).
final class RendererTextToSpeechTests: XCTestCase {
    private static let bundle = #"""
    {
      "test_id": "tts", "title": "TTS",
      "items": [
        { "type": "short_text", "id": "q1", "stem": "Solve $x^2 = 9$ for **x**." },
        { "type": "essay", "id": "q2", "stem": "Which source costs $57,600 more?" },
        { "type": "essay", "id": "q3", "stem": "Third." }
      ],
      "item_sets": [
        { "id": "s1", "stimulus": "Read the passage.", "layout": "inline",
          "sources": [ { "label": "Source A", "text": "Alpha text." },
                       { "label": "Source B", "text": "Beta text." } ],
          "item_ids": ["q2"] }
      ]
    }
    """#

    private func harness(
        items: Bool, stimuli: Bool, paged: Bool = false, extra: String = ""
    ) throws -> RendererHarness {
        var json = Self.bundle
        if paged {
            json = json.replacingOccurrences(of: #""test_id": "tts","#, with: #""layout": "paged", "test_id": "tts","#)
        }
        return try RendererHarness(
            bundleJSON: json,
            prelude: "var TTS_SCOPE = { items: \(items), stimuli: \(stimuli) };\n" + extra)
    }

    /// The `n`th Speak bar's primary button (Speak / Pause / Resume).
    private func play(_ n: Int) -> String { "__all('.tts-play')[\(n)]" }
    private func stop(_ n: Int) -> String { "__all('.tts-stop')[\(n)]" }

    // MARK: - Gating

    func testNoScopeNoControls() throws {
        let h = try RendererHarness(bundleJSON: Self.bundle)
        XCTAssertEqual(try h.int("__count('.tts-bar')"), 0)
        XCTAssertEqual(try h.int("__count('.tts-rate')"), 0)
    }

    func testOffScopeNoControls() throws {
        let h = try harness(items: false, stimuli: false)
        XCTAssertEqual(try h.int("__count('.tts-bar')"), 0)
        XCTAssertEqual(try h.int("__count('.tts-rate')"), 0)
    }

    func testItemsPutsOneControlOnEveryStem() throws {
        let h = try harness(items: true, stimuli: false)
        XCTAssertEqual(try h.int("__count('.tts-bar')"), 3)
        for i in 0..<3 {
            XCTAssertEqual(try h.int("__count('.tts-bar', __item(\(i)))"), 1)
        }
        XCTAssertEqual(try h.int("__count('.tts-bar', __first('.stimulus'))"), 0)
        XCTAssertEqual(try h.string("\(play(0)).getAttribute('aria-label')"), "Speak the question")
        XCTAssertEqual(try h.int("__count('.tts-rate')"), 1)
    }

    func testStimuliPutsControlsOnThePassageAndEachSource() throws {
        let h = try harness(items: false, stimuli: true)
        XCTAssertEqual(try h.int("__count('.tts-bar')"), 3)
        XCTAssertEqual(try h.int("__count('.tts-bar', __first('.stimulus'))"), 3)
        XCTAssertEqual(
            try h.string("__all('.tts-play').map(function (b) { return b.getAttribute('aria-label'); }).join('|')"),
            "Speak the passage|Speak source Source A|Speak source Source B")
        // Each source's control lives in its own panel, so it hides with it.
        XCTAssertEqual(try h.int("__count('.tts-bar', __all('.source-panel')[1])"), 1)
    }

    func testBothScopes() throws {
        let h = try harness(items: true, stimuli: true)
        XCTAssertEqual(try h.int("__count('.tts-bar')"), 6)
    }

    func testAControlIsKeyboardReachableAndItsStopStartsHidden() throws {
        let h = try harness(items: true, stimuli: false)
        XCTAssertEqual(try h.string("\(play(0)).getAttribute('tabindex')"), "0")
        XCTAssertEqual(try h.string("\(play(0)).textContent"), "Speak")
        XCTAssertTrue(try h.bool("\(stop(0)).hidden"))
    }

    // MARK: - What is sent

    func testSpeakSendsTheSpokenFormOfTheStem() throws {
        let h = try harness(items: true, stimuli: false)
        try h.eval("\(play(0)).onclick()")
        let sent = try h.postedSpeech()
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent[0]["action"] as? String, "speak")
        XCTAssertEqual(sent[0]["rate"] as? String, "normal")
        let segments = try XCTUnwrap(sent[0]["segments"] as? [[String: String]])
        // No KaTeX in the harness, so the formula is still `$…$` text: it is
        // split out as math, and the bold markers are already gone (E6 turned
        // them into a <strong> whose text node is read).
        XCTAssertEqual(segments, [
            ["kind": "text", "text": "Solve "],
            ["kind": "math", "tex": "x^2 = 9"],
            ["kind": "text", "text": " for "],
            ["kind": "text", "text": "x"],
            ["kind": "text", "text": "."],
        ])
    }

    /// C-2 / M-1: a dollar before a digit with no math marker is money.
    func testAProseDollarIsNotMath() throws {
        let h = try harness(items: true, stimuli: false)
        try h.eval("\(play(1)).onclick()")
        let segments = try XCTUnwrap(try h.postedSpeech()[0]["segments"] as? [[String: String]])
        XCTAssertEqual(segments, [["kind": "text", "text": "Which source costs $57,600 more?"]])
    }

    func testASourceReadsOnlyItsOwnText() throws {
        let h = try harness(items: false, stimuli: true)
        try h.eval("__all('.tts-play')[1].onclick()")
        let segments = try XCTUnwrap(try h.postedSpeech()[0]["segments"] as? [[String: String]])
        XCTAssertEqual(segments, [["kind": "text", "text": "Alpha text."]])
    }

    /// A rendered formula is read from the TeX the math pass kept, with the
    /// real KaTeX — whose MathML annotation ME-3 strips.
    func testARenderedFormulaIsReadFromItsTex() throws {
        let h = try harness(
            items: true, stimuli: false,
            extra: "console.warn = function () {}; document.compatMode = 'CSS1Compat';\n"
                + KatexBundle.shared.js + "\n" + KatexBundle.macrosScript)
        XCTAssertEqual(try h.int("__count('.katex', __first('.stem', __item(0)))"), 1)
        try h.eval("\(play(0)).onclick()")
        let segments = try XCTUnwrap(try h.postedSpeech()[0]["segments"] as? [[String: String]])
        XCTAssertEqual(segments.first, ["kind": "text", "text": "Solve "])
        XCTAssertEqual(segments[1], ["kind": "math", "tex": "x^2 = 9"])
        XCTAssertEqual(try h.int("__count('annotation', __first('.stem', __item(0)))"), 0, "ME-3 still holds")
    }

    func testThePictureReadsItsAltText() throws {
        let json = #"""
        { "test_id": "t", "title": "t",
          "assets": { "11111111-1111-1111-1111-111111111111": { "content_type": "image/png", "base64": "AAAA" } },
          "items": [ { "type": "essay", "id": "e",
            "stem": "Look: ![A bar chart](asset:11111111-1111-1111-1111-111111111111)" } ] }
        """#
        let h = try RendererHarness(bundleJSON: json, prelude: "var TTS_SCOPE = { items: true, stimuli: false };")
        try h.eval("__first('.tts-play').onclick()")
        let segments = try XCTUnwrap(try h.postedSpeech()[0]["segments"] as? [[String: String]])
        XCTAssertEqual(segments, [
            ["kind": "text", "text": "Look: "],
            ["kind": "text", "text": " Picture: A bar chart. "],
        ])
    }

    // MARK: - Controls

    func testPauseResumeAndStop() throws {
        let h = try harness(items: true, stimuli: false)
        try h.eval("\(play(0)).onclick()")
        XCTAssertEqual(try h.string("\(play(0)).textContent"), "Pause")
        XCTAssertFalse(try h.bool("\(stop(0)).hidden"))
        XCTAssertTrue(try h.bool("(' ' + __item(0).className + ' ').indexOf(' tts-reading ') !== -1"), "the whole question is outlined")

        try h.eval("\(play(0)).onclick()")
        XCTAssertEqual(try h.string("\(play(0)).textContent"), "Resume")
        try h.eval("\(play(0)).onclick()")
        XCTAssertEqual(try h.string("\(play(0)).textContent"), "Pause")

        try h.eval("\(stop(0)).onclick()")
        XCTAssertEqual(try h.string("\(play(0)).textContent"), "Speak")
        XCTAssertTrue(try h.bool("\(stop(0)).hidden"))
        XCTAssertTrue(try h.bool("document.activeElement === \(play(0))"), "focus back on Speak")
        XCTAssertEqual(
            try h.postedSpeech().map { $0["action"] as? String },
            ["speak", "pause", "resume", "stop"])
    }

    func testOneAtATime() throws {
        let h = try harness(items: true, stimuli: false)
        try h.eval("\(play(0)).onclick()")
        try h.eval("\(play(2)).onclick()")
        XCTAssertEqual(try h.string("\(play(0)).textContent"), "Speak")
        XCTAssertEqual(try h.string("\(play(2)).textContent"), "Pause")
        let sent = try h.postedSpeech()
        XCTAssertEqual(sent.map { $0["action"] as? String }, ["speak", "stop", "speak"])
        XCTAssertNotEqual(sent[0]["id"] as? String, sent[2]["id"] as? String)
    }

    func testTheRateRidesTheNextSpeak() throws {
        let h = try harness(items: true, stimuli: false)
        let buttons = "__first('.tts-rate').children.filter(function (c) { return c.tagName === 'button'; })"
        XCTAssertEqual(try h.string("\(buttons).map(function (b) { return b.getAttribute('aria-pressed'); }).join(',')"), "false,true,false")
        try h.eval("\(buttons)[0].onclick()")
        XCTAssertEqual(try h.string("\(buttons).map(function (b) { return b.getAttribute('aria-pressed'); }).join(',')"), "true,false,false")
        try h.eval("\(play(0)).onclick()")
        XCTAssertEqual(try h.postedSpeech()[0]["rate"] as? String, "slow")
    }

    // MARK: - Host callbacks

    private func utteranceId(_ h: RendererHarness) throws -> String {
        try XCTUnwrap(try h.postedSpeech().last?["id"] as? String)
    }

    func testFinishedResetsTheControl() throws {
        let h = try harness(items: true, stimuli: false)
        try h.eval("\(play(0)).onclick()")
        let id = try utteranceId(h)
        try h.eval("window.__secureTestSpeech.finished('\(id)')")
        XCTAssertEqual(try h.string("\(play(0)).textContent"), "Speak")
        XCTAssertTrue(try h.bool("\(stop(0)).hidden"))
    }

    /// A cancel for an utterance already replaced must not reset the new one.
    func testALateCallbackForAnOldUtteranceIsIgnored() throws {
        let h = try harness(items: true, stimuli: false)
        try h.eval("\(play(0)).onclick()")
        let first = try utteranceId(h)
        try h.eval("\(stop(0)).onclick()")
        try h.eval("\(play(0)).onclick()")
        try h.eval("window.__secureTestSpeech.cancelled('\(first)')")
        XCTAssertEqual(try h.string("\(play(0)).textContent"), "Pause")
    }

    /// The word highlight is a Range over the page's own text node, built from
    /// the host's segment and offset. Stubs the Highlight API, which
    /// JavaScriptCore does not have.
    func testAWordIsHighlightedInItsOwnTextNode() throws {
        let stub = """
        var __ranges = [];
        function Highlight(range) { this.range = range; }
        var CSS = { highlights: {
          set: function (name, h) { __ranges.push({ name: name, node: h.range.node, start: h.range.start, end: h.range.end }); },
          delete: function () {}
        } };
        document.createRange = function () {
          return { setStart: function (n, o) { this.node = n; this.start = o; }, setEnd: function (n, o) { this.end = o; } };
        };
        """
        let h = try harness(items: true, stimuli: false, extra: stub)
        try h.eval("\(play(0)).onclick()")
        let id = try utteranceId(h)
        // Segment 0 is "Solve " — the first text node of the stem.
        try h.eval("window.__secureTestSpeech.word('\(id)', 0, 0, 5)")
        XCTAssertEqual(try h.string("__ranges[0].name"), "tts-word")
        XCTAssertEqual(try h.string("__ranges[0].node._text.slice(__ranges[0].start, __ranges[0].end)"), "Solve")
        // Segment 2 is " for " — the text node after the formula.
        try h.eval("window.__secureTestSpeech.word('\(id)', 2, 1, 3)")
        XCTAssertEqual(try h.string("__ranges[1].node._text.slice(__ranges[1].start, __ranges[1].end)"), "for")
        // Segment 1 is the unrendered formula: the whole `$…$`.
        try h.eval("window.__secureTestSpeech.word('\(id)', 1, 0, 0)")
        XCTAssertEqual(try h.string("__ranges[2].node._text.slice(__ranges[2].start, __ranges[2].end)"), "$x^2 = 9$")
    }

    func testARenderedFormulaIsMarkedWhole() throws {
        let h = try harness(
            items: true, stimuli: false,
            extra: "console.warn = function () {}; document.compatMode = 'CSS1Compat';\n"
                + KatexBundle.shared.js + "\n" + KatexBundle.macrosScript)
        try h.eval("\(play(0)).onclick()")
        let id = try utteranceId(h)
        try h.eval("window.__secureTestSpeech.word('\(id)', 1, 0, 0)")
        XCTAssertEqual(try h.int("__count('.tts-word', __item(0))"), 1)
        try h.eval("window.__secureTestSpeech.finished('\(id)')")
        XCTAssertEqual(try h.int("__count('.tts-word', __item(0))"), 0, "cleared at the end")
    }

    // MARK: - Stops

    func testAPageTurnStops() throws {
        let h = try harness(items: true, stimuli: false, paged: true)
        try h.eval("__first('.tts-play').onclick()")
        try h.eval("__first('.pager-next').onclick()")
        XCTAssertEqual(try h.postedSpeech().map { $0["action"] as? String }, ["speak", "stop"])
    }

    func testFinishStops() throws {
        let h = try harness(items: true, stimuli: false)
        try h.eval("\(play(0)).onclick()")
        try h.eval("__first('button', __first('.finish')).onclick()")
        XCTAssertEqual(try h.postedSpeech().map { $0["action"] as? String }, ["speak", "stop"])
        XCTAssertEqual(try h.postedSubmits().count, 1)
    }

    func testChangingSourceTabStops() throws {
        let h = try harness(items: false, stimuli: true)
        try h.eval("__all('.tts-play')[1].onclick()")
        try h.eval("__all('.source-tab')[0].onclick()")
        XCTAssertEqual(try h.postedSpeech().count, 1, "the open tab again is not a change")
        try h.eval("__all('.source-tab')[1].onclick()")
        XCTAssertEqual(try h.postedSpeech().map { $0["action"] as? String }, ["speak", "stop"])
    }

    func testNothingIsSentWhenNothingIsBeingRead() throws {
        let h = try harness(items: true, stimuli: false, paged: true)
        try h.eval("__first('.pager-next').onclick()")
        XCTAssertEqual(try h.postedSpeech().count, 0)
    }

    // MARK: - Options (James, 2026-10-01: Items reads the stem AND its options)

    private static let optionsBundle = #"""
    {
      "test_id": "opts", "title": "Options",
      "items": [
        { "type": "multiple_choice_single", "id": "mc", "stem": "Pick one.",
          "choices": [ { "id": "c1", "text": "Red" }, { "id": "c2", "text": "$x^2$ apples" } ] },
        { "type": "order", "id": "or", "stem": "Order these.",
          "entries": [ { "id": "e1", "label": "First" }, { "id": "e2", "label": "Second" } ] },
        { "type": "match", "id": "ma", "stem": "Match them.",
          "lefts": [ { "id": "l1", "text": "Dog" }, { "id": "l2", "text": "Cat" } ],
          "rights": [ { "id": "r1", "text": "Bark" }, { "id": "r2", "text": "$\\frac{1}{2}$ meow" } ] },
        { "type": "table", "id": "tb", "stem": "Fill it.", "corner": "",
          "columns": [ { "id": "k1", "label": "Mass" } ],
          "rows": [ { "id": "w1", "label": "Trial 1" } ] },
        { "type": "essay", "id": "es", "stem": "Write." }
      ],
      "saved_responses": {
        "mc": { "type": "multiple_choice_single", "choice_id": "c1" },
        "tb": { "type": "table", "cells": { "w1": { "k1": "SECRET ANSWER" } } }
      }
    }
    """#

    private func optionsHarness() throws -> RendererHarness {
        try RendererHarness(bundleJSON: Self.optionsBundle, prelude: "var TTS_SCOPE = { items: true, stimuli: false };")
    }

    private func spoken(_ h: RendererHarness, item n: Int) throws -> [[String: String]] {
        // A second Speak on the same question would be Pause: stop first.
        try h.eval("var __s = __first('.tts-stop', __item(\(n))); if (!__s.hidden) __s.onclick();")
        try h.eval("__first('.tts-play', __item(\(n))).onclick()")
        return try XCTUnwrap(try h.postedSpeech().last?["segments"] as? [[String: String]])
    }

    private func text(_ segments: [[String: String]]) -> String {
        segments.map { $0["kind"] == "math" ? "[\($0["tex"] ?? "")]" : ($0["text"] ?? "") }.joined()
    }

    func testMultipleChoiceReadsEveryChoiceNumberedAndNeverTheSelection() throws {
        let h = try optionsHarness()
        XCTAssertTrue(try h.bool("__all('input', __item(0))[0].checked"), "restored as selected")
        let segments = try spoken(h, item: 0)
        XCTAssertEqual(text(segments), "Pick one. Choice 1, Red.  Choice 2, [x^2] apples. ")
        XCTAssertFalse(text(segments).lowercased().contains("selected"))
    }

    /// The highlight follows into a choice: its segment carries the choice's
    /// own text node.
    func testAChoiceWordIsHighlightable() throws {
        let stub = """
        var __ranges = [];
        function Highlight(range) { this.range = range; }
        var CSS = { highlights: { set: function (n, h) { __ranges.push(h.range); }, delete: function () {} } };
        document.createRange = function () {
          return { setStart: function (n, o) { this.node = n; this.start = o; }, setEnd: function (n, o) { this.end = o; } };
        };
        """
        let h = try RendererHarness(
            bundleJSON: Self.optionsBundle,
            prelude: "var TTS_SCOPE = { items: true, stimuli: false };\n" + stub)
        let segments = try spoken(h, item: 0)
        let red = try XCTUnwrap(segments.firstIndex { $0["text"] == "Red" })
        let id = try XCTUnwrap(try h.postedSpeech().last?["id"] as? String)
        try h.eval("window.__secureTestSpeech.word('\(id)', \(red), 0, 3)")
        XCTAssertEqual(try h.string("__ranges[0].node._text.slice(__ranges[0].start, __ranges[0].end)"), "Red")
        // A connective ("Choice 1, ") has no node: no highlight, no error.
        try h.eval("window.__secureTestSpeech.word('\(id)', \(red - 1), 1, 6)")
        XCTAssertEqual(try h.int("__ranges.length"), 1)
    }

    func testOrderReadsItsCurrentOnScreenOrder() throws {
        let h = try optionsHarness()
        let before = text(try spoken(h, item: 1))
        XCTAssertTrue(before.hasPrefix("Order these. Items to put in order: "), before)
        let first = try XCTUnwrap(h.string("__all('.order-label', __item(1))[0].textContent"))
        let second = try XCTUnwrap(h.string("__all('.order-label', __item(1))[1].textContent"))
        XCTAssertEqual(before, "Order these. Items to put in order: \(first). \(second). ")
        // Move the first entry down; the read follows the screen.
        try h.eval("__all('button', __all('.order-row', __item(1))[0]).filter(function (b) { return /down/i.test(b.textContent + (b.getAttribute('aria-label') || '')); })[0].onclick()")
        XCTAssertEqual(text(try spoken(h, item: 1)), "Order these. Items to put in order: \(second). \(first). ")
    }

    func testMatchReadsPromptsThenOptionsWithoutThePlaceholder() throws {
        let h = try optionsHarness()
        XCTAssertEqual(
            text(try spoken(h, item: 2)),
            "Match them. Match: Dog, Cat,  Options: Bark, [\\frac{1}{2}] meow, ")
    }

    func testTableReadsHeadersNeverTheCells() throws {
        let h = try optionsHarness()
        let said = text(try spoken(h, item: 3))
        XCTAssertEqual(said, "Fill it. Table: Mass, Trial 1, ")
        XCTAssertFalse(said.contains("SECRET"))
    }

    func testEssayIsStemOnly() throws {
        let h = try optionsHarness()
        XCTAssertEqual(text(try spoken(h, item: 4)), "Write.")
    }
}
