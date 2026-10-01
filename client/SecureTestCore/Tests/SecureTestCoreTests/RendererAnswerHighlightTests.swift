import XCTest
@testable import SecureTestCore

/// Answer highlight (`docs/speech-tools-design.md` "Follow-ups", James
/// 2026-10-01): while "Read my answer" reads, a mirror laid over the field
/// carries the spoken word's CSS Custom Highlight — a range cannot reach
/// inside an input / textarea. Runs the real renderer with the Highlight API
/// stubbed (JavaScriptCore has none).
///
/// What this cannot prove: that the mirror's text lands exactly over the
/// field's (fonts, wrapping, the textarea's scrollbar), that WebKit paints it,
/// or the reveal-on-scroll in a long essay — hand-run rows.
final class RendererAnswerHighlightTests: XCTestCase {
    private static let bundle = #"""
    {
      "test_id": "hl", "title": "Highlight",
      "items": [
        { "type": "short_text", "id": "st", "stem": "Name it." },
        { "type": "essay", "id": "es", "stem": "Explain." },
        { "type": "table", "id": "tb", "stem": "Record.", "corner": "",
          "columns": [ { "id": "c1", "label": "Mass" }, { "id": "c2", "label": "Volume" } ],
          "rows": [ { "id": "r1", "label": "Trial 1" } ] }
      ]
    }
    """#

    private static let stub = """
    var __ranges = [];
    var __cleared = 0;
    function Highlight(range) { this.range = range; }
    var CSS = { highlights: {
      set: function (name, h) { __ranges.push({ node: h.range.node, start: h.range.start, end: h.range.end }); },
      delete: function () { __cleared += 1; }
    } };
    document.createRange = function () {
      return { setStart: function (n, o) { this.node = n; this.start = o; }, setEnd: function (n, o) { this.end = o; } };
    };
    """

    private func harness() throws -> RendererHarness {
        try RendererHarness(
            bundleJSON: Self.bundle,
            prelude: "var TTS_SCOPE = { items: false, stimuli: false, responses: true };\n" + Self.stub)
    }

    private let short = "__first('.short-text', __item(0))"
    private let essay = "__first('.essay', __item(1))"
    private let mirrors = "__all('.tts-mirror', document.body)"

    /// Presses Read my answer in `container`; returns the utterance id.
    @discardableResult
    private func read(_ h: RendererHarness, _ container: String) throws -> String {
        try h.eval("__first('.tts-play', \(container)).onclick()")
        return try XCTUnwrap(try h.postedSpeech().last?["id"] as? String)
    }

    func testAMirrorGoesUpWithReadingAndCarriesTheValue() throws {
        let h = try harness()
        try h.eval("\(essay).value = 'The cat sat on the mat.';")
        XCTAssertEqual(try h.int("\(mirrors).length"), 0)
        try read(h, "__item(1)")
        XCTAssertEqual(try h.int("\(mirrors).length"), 1)
        XCTAssertEqual(try h.string("\(mirrors)[0].getAttribute('aria-hidden')"), "true")
        XCTAssertEqual(try h.string("\(mirrors)[0].children[0]._text"), "The cat sat on the mat.")
        XCTAssertEqual(try h.string("\(mirrors)[0].style.whiteSpace"), "pre-wrap", "a textarea wraps")
    }

    func testASingleLineFieldMirrorDoesNotWrap() throws {
        let h = try harness()
        try h.eval("\(short).value = 'forty two';")
        try read(h, "__item(0)")
        XCTAssertEqual(try h.string("\(mirrors)[0].style.whiteSpace"), "pre")
    }

    func testAWordBecomesARangeInTheMirrorsTextNode() throws {
        let h = try harness()
        try h.eval("\(essay).value = 'The cat sat.';")
        let id = try read(h, "__item(1)")
        try h.eval("window.__secureTestSpeech.word('\(id)', 0, 4, 3)")
        XCTAssertTrue(try h.bool("__ranges[0].node === \(mirrors)[0].children[0]"))
        XCTAssertEqual(try h.string("__ranges[0].node._text.slice(__ranges[0].start, __ranges[0].end)"), "cat")
        // The stale-paint fix runs on the mirror too: toggled once per word.
        XCTAssertEqual(try h.string("\(mirrors)[0].style.filter"), "opacity(1)")
        try h.eval("window.__secureTestSpeech.word('\(id)', 0, 8, 3)")
        XCTAssertEqual(try h.string("\(mirrors)[0].style.filter"), "")
        XCTAssertEqual(try h.string("__ranges[1].node._text.slice(__ranges[1].start, __ranges[1].end)"), "sat")
        XCTAssertEqual(try h.int("\(mirrors).length"), 1, "one mirror, reused")
    }

    /// `$…$` in a typed answer: the prose after the formula maps past it.
    func testOffsetsAfterAFormulaMapIntoTheValue() throws {
        let h = try harness()
        try h.eval("\(essay).value = 'So $x^2$ grows';")
        let id = try read(h, "__item(1)")
        // Segments: "So ", the formula, " grows".
        try h.eval("window.__secureTestSpeech.word('\(id)', 2, 1, 5)")
        XCTAssertEqual(try h.string("__ranges[0].node._text.slice(__ranges[0].start, __ranges[0].end)"), "grows")
        try h.eval("window.__secureTestSpeech.word('\(id)', 1, 0, 0)")
        XCTAssertEqual(try h.string("__ranges[1].node._text.slice(__ranges[1].start, __ranges[1].end)"), "$x^2$")
    }

    func testAnAnswerReadAsOneFormulaIsHighlightedWhole() throws {
        let h = try harness()
        try h.eval("\(short).value = '\\\\frac{1}{2} + x^2';")
        let id = try read(h, "__item(0)")
        try h.eval("window.__secureTestSpeech.word('\(id)', 0, 0, 0)")
        XCTAssertEqual(
            try h.string("__ranges[0].node._text.slice(__ranges[0].start, __ranges[0].end)"),
            "\\frac{1}{2} + x^2")
    }

    func testTheMirrorComesDownOnFinishStopAndTyping() throws {
        let h = try harness()
        try h.eval("\(essay).value = 'Words here.';")
        var id = try read(h, "__item(1)")
        try h.eval("window.__secureTestSpeech.finished('\(id)')")
        XCTAssertEqual(try h.int("\(mirrors).length"), 0, "finished")

        id = try read(h, "__item(1)")
        XCTAssertEqual(try h.int("\(mirrors).length"), 1)
        try h.eval("__first('.tts-stop', __item(1)).onclick({ detail: 1 })")
        XCTAssertEqual(try h.int("\(mirrors).length"), 0, "Stop")

        id = try read(h, "__item(1)")
        try h.eval("\(essay).value = 'Words here!'; \(essay).oninput();")
        XCTAssertEqual(try h.int("\(mirrors).length"), 0, "typing in the field")
        _ = id
    }

    func testATableMovesTheMirrorToTheCellBeingRead() throws {
        let h = try harness()
        try h.eval("__all('.table-cell', __item(2))[0].value = '12 g';")
        try h.eval("__all('.table-cell', __item(2))[1].value = '3 mL';")
        let id = try read(h, "__item(2)")
        XCTAssertEqual(try h.int("\(mirrors).length"), 0, "no single field to cover yet")
        let segments = try XCTUnwrap(try h.postedSpeech().last?["segments"] as? [[String: String]])
        // label, value, '. ', label, value, '. '
        XCTAssertEqual(segments.map { $0["text"] ?? "" }, ["Row Trial 1, Mass: ", "12 g", ". ", "Row Trial 1, Volume: ", "3 mL", ". "])
        try h.eval("window.__secureTestSpeech.word('\(id)', 1, 0, 2)")
        XCTAssertEqual(try h.string("\(mirrors)[0].children[0]._text"), "12 g")
        XCTAssertEqual(try h.string("__ranges[0].node._text.slice(__ranges[0].start, __ranges[0].end)"), "12")
        // A label word has no field: no range, the mirror stays put.
        try h.eval("window.__secureTestSpeech.word('\(id)', 3, 4, 5)")
        XCTAssertEqual(try h.int("__ranges.length"), 1)
        try h.eval("window.__secureTestSpeech.word('\(id)', 4, 2, 2)")
        XCTAssertEqual(try h.int("\(mirrors).length"), 1, "one mirror, moved to the next cell")
        XCTAssertEqual(try h.string("\(mirrors)[0].children[0]._text"), "3 mL")
        XCTAssertEqual(try h.string("__ranges[1].node._text.slice(__ranges[1].start, __ranges[1].end)"), "mL")
        try h.eval("window.__secureTestSpeech.finished('\(id)')")
        XCTAssertEqual(try h.int("\(mirrors).length"), 0)
    }

    func testTheMirrorNeverTouchesTheFieldOrPosts() throws {
        let h = try harness()
        try h.eval("\(essay).value = 'Unchanged text';")
        let id = try read(h, "__item(1)")
        try h.eval("window.__secureTestSpeech.word('\(id)', 0, 0, 9)")
        try h.eval("window.__secureTestSpeech.finished('\(id)')")
        XCTAssertEqual(try h.string("\(essay).value"), "Unchanged text")
        XCTAssertEqual(try h.postedMessages().count, 0)
        XCTAssertEqual(try h.eval("__pendingTimers()").toInt32(), 0)
    }

    /// Geometry, with the shim given the browser APIs it lacks: the mirror
    /// copies the field's computed box and font, sits at its page position and
    /// takes its scroll.
    func testTheMirrorCopiesTheFieldsBoxAndScroll() throws {
        let prelude = "var TTS_SCOPE = { items: false, stimuli: false, responses: true };\n" + Self.stub + """
        window.scrollX = 0; window.scrollY = 100;
        window.getComputedStyle = function (el) {
          return { fontFamily: 'Inter', fontSize: '16px', lineHeight: '24px', paddingTop: '8px',
                   paddingLeft: '10px', borderTopWidth: '1px', boxSizing: 'border-box' };
        };
        """
        let h = try RendererHarness(bundleJSON: Self.bundle, prelude: prelude)
        try h.eval("""
        \(essay).value = 'x';
        \(essay).scrollTop = 40;
        \(essay).getBoundingClientRect = function () { return { left: 30, top: 200, width: 600, height: 240 }; };
        """)
        try read(h, "__item(1)")
        let m = "\(mirrors)[0]"
        XCTAssertEqual(try h.string("\(m).style.left"), "30px")
        XCTAssertEqual(try h.string("\(m).style.top"), "300px", "page coordinates: rect + scroll")
        XCTAssertEqual(try h.string("\(m).style.width"), "600px")
        XCTAssertEqual(try h.string("\(m).style.height"), "240px")
        XCTAssertEqual(try h.string("\(m).style.fontFamily"), "Inter")
        XCTAssertEqual(try h.string("\(m).style.lineHeight"), "24px")
        XCTAssertEqual(try h.string("\(m).style.paddingLeft"), "10px")
        XCTAssertEqual(try h.string("\(m).style.boxSizing"), "border-box")
        XCTAssertEqual(try h.int("\(m).scrollTop"), 40)
    }
}
