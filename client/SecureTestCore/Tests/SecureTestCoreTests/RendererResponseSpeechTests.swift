import XCTest
@testable import SecureTestCore

/// TTS slice 2 (`docs/speech-tools-design.md`): "Read my answer" beside every
/// field the student types into, gated on `tts_student_responses`. Reads the
/// field's value at the press — keypad LaTeX through the math mapper, a prose
/// dollar as text — and the filled cells of a table with their headers. Never
/// changes the field, and typing in the field being read stops it.
///
/// What this cannot prove: the voice, the field's outline under each contrast
/// set, and that a pointer press really leaves focus in the field in WebKit —
/// hand-run rows.
final class RendererResponseSpeechTests: XCTestCase {
    private static let bundle = #"""
    {
      "test_id": "resp", "title": "Responses",
      "items": [
        { "type": "short_text", "id": "st", "stem": "Simplify $x$." },
        { "type": "essay", "id": "es", "stem": "Explain." },
        { "type": "table", "id": "tb", "stem": "Record.", "corner": "",
          "columns": [ { "id": "c1", "label": "Mass" }, { "id": "c2", "label": "Volume" } ],
          "rows": [ { "id": "r1", "label": "Trial 1" }, { "id": "r2", "label": "Trial 2" } ] },
        { "type": "multiple_choice_single", "id": "mc", "stem": "Pick.",
          "choices": [ { "id": "a", "text": "A" } ] }
      ],
      "item_sets": [
        { "id": "set", "stimulus": "Use your outline.", "layout": "inline", "item_ids": ["es"],
          "inline_item_id": "outline", "inline_text": "My plan", "source_missing": false }
      ]
    }
    """#

    private func harness(_ scope: String) throws -> RendererHarness {
        try RendererHarness(bundleJSON: Self.bundle, prelude: "var TTS_SCOPE = \(scope);")
    }

    private let responsesOnly = "{ items: false, stimuli: false, responses: true }"

    private func text(_ segments: [[String: String]]) -> String {
        segments.map { $0["kind"] == "math" ? "[\($0["tex"] ?? "")]" : ($0["text"] ?? "") }.joined()
    }

    /// The containers, by field: 0 short text, 1 the E12 outline, 2 essay,
    /// 3 table.
    private func box(_ n: Int) -> String {
        ["__item(0)", "__first('.outline-inline')", "__item(1)", "__item(2)"][n]
    }

    /// Presses that field's "Read my answer" and returns what was sent.
    private func read(_ h: RendererHarness, _ n: Int) throws -> [[String: String]] {
        try h.eval("var __b = __first('.tts-play', \(box(n))); var __stopB = __first('.tts-stop', \(box(n)));")
        try h.eval("__b.onclick()")
        return try XCTUnwrap(try h.postedSpeech().last?["segments"] as? [[String: String]])
    }

    private let shortField = "__first('.short-text', __item(0))"
    private let essayField = "__first('.essay', __item(1))"

    // MARK: - Gating

    func testResponsesOnlyPutsAControlBesideEveryTypedFieldAndNoneOnStems() throws {
        let h = try harness(responsesOnly)
        let labels = try h.string("__all('.tts-play').map(function (b) { return b.textContent; }).join('|')")
        // Short text, outline, essay, table — and nothing on any stem or the MC.
        XCTAssertEqual(labels, "Read my answer|Read my answer|Read my answer|Read my answer")
        XCTAssertEqual(try h.int("__count('.tts-bar', __item(3))"), 0)
        XCTAssertEqual(try h.int("__count('.tts-rate')"), 1, "the speed control shows for responses alone")
        XCTAssertEqual(try h.string("__all('.tts-play')[1].getAttribute('aria-label')"), "Read my answer")
    }

    func testContentScopeAloneHasNoAnswerControls() throws {
        let h = try harness("{ items: true, stimuli: true, responses: false }")
        XCTAssertEqual(
            try h.int("__all('.tts-play').filter(function (b) { return b.textContent === 'Read my answer'; }).length"), 0)
    }

    // MARK: - What is read

    func testTheCurrentValueIsReadAtThePress() throws {
        let h = try harness(responsesOnly)
        try h.eval("\(shortField).value = 'forty two'; \(shortField).oninput();")
        XCTAssertEqual(text(try read(h, 0)), "forty two")
        // Typed again (which stops the reading), pressed again: the new value.
        try h.eval("\(shortField).value = 'forty three'; \(shortField).oninput();")
        XCTAssertEqual(text(try read(h, 0)), "forty three")
    }

    func testAnEmptyFieldSaysSo() throws {
        let h = try harness(responsesOnly)
        XCTAssertEqual(text(try read(h, 2)), "No answer yet.")
        try h.eval("\(essayField).value = '   ';")
        try h.eval("__stopB.onclick({ detail: 1 })")
        XCTAssertEqual(text(try read(h, 2)), "No answer yet.")
    }

    func testTheOutlineIsReadFromItsRestoredText() throws {
        let h = try harness(responsesOnly)
        XCTAssertEqual(text(try read(h, 1)), "My plan")
    }

    /// The keypad inserts LaTeX; a value carrying it is sent as one formula,
    /// which the host reads through MathSpeech.
    func testKeypadLatexIsReadAsMath() throws {
        let h = try harness(responsesOnly)
        try h.eval("""
        var __frac = __all('button', __item(0)).filter(function (b) { return b.getAttribute('data-key') === 'fraction'; })[0];
        __frac.onclick({ detail: 0 });
        """)
        XCTAssertEqual(try h.string("\(shortField).value"), "\\frac{}{}")
        try h.eval("\(shortField).value = '\\\\frac{1}{2} + x^2';")
        let segments = try read(h, 0)
        XCTAssertEqual(segments, [["kind": "math", "tex": "\\frac{1}{2} + x^2"]])
        XCTAssertEqual(MathSpeech.words("\\frac{1}{2} + x^2"), "1 over 2 plus x squared")
    }

    func testAProseDollarIsMoneyAndUnicodeSymbolsArePlainText() throws {
        let h = try harness(responsesOnly)
        try h.eval("\(shortField).value = 'It costs $5';")
        XCTAssertEqual(try read(h, 0), [["kind": "text", "text": "It costs $5"]])
        try h.eval("__stopB.onclick({ detail: 1 })")
        try h.eval("\(shortField).value = '45° ≤ π';")
        XCTAssertEqual(try read(h, 0), [["kind": "text", "text": "45° ≤ π"]])
    }

    func testTableReadsFilledCellsWithHeadersAndSkipsEmptyOnes() throws {
        let h = try harness(responsesOnly)
        try h.eval("__all('.table-cell', __item(2))[0].value = '12 g';")
        try h.eval("__all('.table-cell', __item(2))[3].value = 'x^2';")
        XCTAssertEqual(
            text(try read(h, 3)),
            "Row Trial 1, Mass: 12 g. Row Trial 2, Volume: [x^2]. ")
    }

    func testAnEmptyTableSaysSo() throws {
        let h = try harness(responsesOnly)
        XCTAssertEqual(text(try read(h, 3)), "No answer yet.")
    }

    // MARK: - Reading leaves the field alone

    func testReadingPostsNothingAndKeepsTheValueAndFocus() throws {
        let h = try harness(responsesOnly)
        try h.eval("\(shortField).value = 'kept'; \(shortField).focus();")
        _ = try read(h, 0)
        XCTAssertEqual(try h.string("\(shortField).value"), "kept")
        XCTAssertTrue(try h.bool("document.activeElement === \(shortField)"))
        XCTAssertEqual(try h.postedMessages().count, 0, "no response post from reading")
        XCTAssertEqual(try h.eval("__pendingTimers()").toInt32(), 0, "no autosave scheduled")
        // A pointer press on the button is told not to take focus.
        XCTAssertTrue(try h.bool("""
        (function () { var d = false; __b.onpointerdown({ preventDefault: function () { d = true; } }); return d; })()
        """))
    }

    /// While it reads, the field itself is outlined (no word highlight inside
    /// an input).
    func testTheFieldIsOutlinedWhileRead() throws {
        let h = try harness(responsesOnly)
        _ = try read(h, 0)
        XCTAssertTrue(try h.bool("(' ' + \(shortField).className + ' ').indexOf(' tts-reading ') !== -1"))
        let id = try XCTUnwrap(try h.postedSpeech().last?["id"] as? String)
        try h.eval("window.__secureTestSpeech.finished('\(id)')")
        XCTAssertEqual(try h.string("\(shortField).className"), "short-text")
    }

    // MARK: - Stops

    func testTypingInTheFieldBeingReadStopsTheReadingAndStillAutosaves() throws {
        let h = try harness(responsesOnly)
        try h.eval("\(shortField).value = 'abc';")
        _ = try read(h, 0)
        try h.eval("\(shortField).value = 'abcd'; \(shortField).oninput();")
        XCTAssertEqual(try h.postedSpeech().map { $0["action"] as? String }, ["speak", "stop"])
        XCTAssertGreaterThan(try h.eval("__pendingTimers()").toInt32(), 0, "the autosave still runs")
        XCTAssertEqual(try h.string("__b.textContent"), "Read my answer")
    }

    func testTypingInAnotherFieldDoesNotStopIt() throws {
        let h = try harness(responsesOnly)
        _ = try read(h, 2)
        try h.eval("\(shortField).value = 'x'; \(shortField).oninput();")
        XCTAssertEqual(try h.postedSpeech().map { $0["action"] as? String }, ["speak"])
    }

    func testTypingInATableCellStopsTheTableReading() throws {
        let h = try harness(responsesOnly)
        _ = try read(h, 3)
        try h.eval("var __c = __all('.table-cell', __item(2))[1]; __c.value = '9'; __c.oninput();")
        XCTAssertEqual(try h.postedSpeech().map { $0["action"] as? String }, ["speak", "stop"])
    }

    func testFinishStopsAResponseReading() throws {
        let h = try harness(responsesOnly)
        _ = try read(h, 0)
        try h.eval("__first('button', __first('.finish')).onclick()")
        XCTAssertEqual(try h.postedSpeech().map { $0["action"] as? String }, ["speak", "stop"])
    }
}
