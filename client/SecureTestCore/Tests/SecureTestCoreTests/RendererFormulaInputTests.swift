import XCTest
@testable import SecureTestCore

/// E7(b) (2026-09-02): a short-text answer typed as a formula previews as
/// math under the field. The harness has no KaTeX, so the preview's
/// `data-tex` attribute is what proves the conversion; the response posted
/// is still the raw typed text.
final class RendererFormulaInputTests: XCTestCase {
    private static let bundle = """
    {
      "test_id": "e7b", "title": "E7b",
      "items": [
        { "type": "short_text", "id": "chem", "stem": "Formula of water, given $\\\\mathrm{H}$ and $\\\\mathrm{O}$?" },
        { "type": "short_text", "id": "prose", "stem": "Capital of Washington?" }
      ]
    }
    """

    private func harness() throws -> RendererHarness {
        try RendererHarness(bundleJSON: Self.bundle)
    }

    func testTypedSubscriptPreviewsAsMathrmAndPostsTheRawText() throws {
        let h = try harness()
        try h.eval("""
        var field = __first('input', __item(0));
        field.value = 'H_2O';
        field.oninput();
        field.onchange();
        """)
        XCTAssertEqual(try h.string("__first('.formula-preview', __item(0)).getAttribute('data-tex')"), "\\mathrm{H_2O}")
        let response = try h.postedMessages().last?["response"] as? [String: Any]
        XCTAssertEqual(response?["text"] as? String, "H_2O")
    }

    /// Batch 0b slice 2 (James, 2026-09-03): every non-empty answer previews,
    /// plain words included — before, only text carrying `_ ^ $ \` did. A space
    /// becomes `\ ` so math mode does not swallow it.
    func testEveryAnswerPreviewsDollarsAreStrippedSpecialsEscapedSpacesKept() throws {
        let h = try harness()
        try h.eval("""
        var f = __first('input', __item(0));
        f.value = 'Olympia'; f.oninput();
        """)
        XCTAssertEqual(try h.string("__first('.formula-preview', __item(0)).getAttribute('data-tex')"), "\\mathrm{Olympia}")
        try h.eval("""
        var s = __first('input', __item(1));
        s.value = '  New   York '; s.oninput();
        """)
        XCTAssertEqual(try h.string("__first('.formula-preview', __item(1)).getAttribute('data-tex')"), "\\mathrm{New\\ York}")
        try h.eval("""
        var g = __first('input', __item(0));
        g.value = '$x^2$ 50%'; g.oninput();
        """)
        XCTAssertEqual(try h.string("__first('.formula-preview', __item(0)).getAttribute('data-tex')"), "\\mathrm{x^2\\ 50\\%}")
        try h.eval("""
        var k = __first('input', __item(0));
        k.value = ''; k.oninput();
        """)
        XCTAssertNil(try h.string("__first('.formula-preview', __item(0)).getAttribute('data-tex')"))
        try h.eval("""
        var w = __first('input', __item(0));
        w.value = '   '; w.oninput();
        """)
        XCTAssertNil(try h.string("__first('.formula-preview', __item(0)).getAttribute('data-tex')"), "whitespace only is an empty answer")
    }

    func testHintOnlyWhereTheStemCarriesMath() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('.formula-hint', __item(0))"), 1)
        XCTAssertEqual(try h.int("__count('.formula-hint', __item(1))"), 0)
        XCTAssertEqual(try h.int("__count('.formula-preview', __item(1))"), 1, "the preview exists everywhere, empty until something is typed")
    }

    // MARK: - fix slice S-4 (2026-09-08): half-typed math says so in words

    /// The harness ships no KaTeX, so these install a stub that behaves the way
    /// the real library does on the one axis that matters here: with
    /// `throwOnError: true` an unbalanced expression throws instead of
    /// returning error markup.
    private func harnessWithKatex() throws -> RendererHarness {
        let h = try harness()
        try h.eval("""
        var __katexCalls = [];
        var katex = {
          render: function (tex, node, opts) {
            __katexCalls.push({ tex: tex, throwOnError: !!(opts && opts.throwOnError) });
            var depth = 0;
            for (var i = 0; i < tex.length; i++) {
              if (tex.charAt(i) === '{') depth++;
              if (tex.charAt(i) === '}') depth--;
            }
            if (depth !== 0) {
              if (opts && opts.throwOnError) throw new Error('ParseError: unbalanced');
              node.textContent = 'KATEX-ERROR';
              return;
            }
            node.textContent = 'KATEX:' + tex;
          }
        };
        function __type(text) {
          var f = __first('input', __item(0));
          f.value = text;
          f.oninput();
        }
        """)
        return h
    }

    private func noteText(_ h: RendererHarness) throws -> String? {
        try h.string("""
        (function () {
          var note = __first('.formula-preview-note', __item(0));
          return note ? note.textContent : null;
        })()
        """)
    }

    func testUnparseableInputShowsThePlainNoteAndNoKatexErrorMarkup() throws {
        let h = try harnessWithKatex()
        try h.eval("__type('\\\\frac{');")
        XCTAssertEqual(try noteText(h), "Can't read that as math yet — keep typing.")
        XCTAssertEqual(
            try h.string("__first('.formula-preview', __item(0)).textContent"),
            "",
            "nothing rendered yet, so the preview carries only the note"
        )
        XCTAssertTrue(
            try h.bool("__katexCalls[__katexCalls.length - 1].throwOnError"),
            "the render is asked to throw rather than to draw its own error"
        )
    }

    func testThePreviousGoodRenderSurvivesAHalfTypedFormula() throws {
        let h = try harnessWithKatex()
        try h.eval("__type('H_2O');")
        XCTAssertEqual(
            try h.string("__first('.formula-preview', __item(0)).textContent"),
            "KATEX:\\mathrm{H_2O}"
        )
        XCTAssertNil(try noteText(h), "a parseable answer carries no note")

        try h.eval("__type('H_2O \\\\frac{');")
        XCTAssertEqual(
            try h.string("__first('.formula-preview', __item(0)).textContent"),
            "KATEX:\\mathrm{H_2O}",
            "the last good render stays on screen"
        )
        XCTAssertEqual(try noteText(h), "Can't read that as math yet — keep typing.")
        XCTAssertEqual(
            try h.string("__first('.formula-preview', __item(0)).getAttribute('data-last-good')"),
            "\\mathrm{H_2O}"
        )
    }

    func testAValidInputReplacesTheNote() throws {
        let h = try harnessWithKatex()
        try h.eval("__type('\\\\frac{');")
        XCTAssertNotNil(try noteText(h))
        try h.eval("__type('x^2');")
        XCTAssertNil(try noteText(h))
        XCTAssertEqual(
            try h.string("__first('.formula-preview', __item(0)).textContent"),
            "KATEX:\\mathrm{x^2}"
        )
    }

    func testClearingTheFieldClearsTheNoteAndTheRememberedRender() throws {
        let h = try harnessWithKatex()
        try h.eval("__type('H_2O');")
        try h.eval("__type('\\\\frac{');")
        try h.eval("__type('');")
        XCTAssertNil(try noteText(h))
        XCTAssertEqual(try h.string("__first('.formula-preview', __item(0)).textContent"), "")
        XCTAssertNil(try h.string("__first('.formula-preview', __item(0)).getAttribute('data-last-good')"))
    }

    /// The announcement contract from E7(b) is unchanged: the preview is a
    /// polite live region, so the note is spoken without interrupting.
    func testThePreviewStaysAPoliteLiveRegion() throws {
        let h = try harnessWithKatex()
        try h.eval("__type('\\\\frac{');")
        XCTAssertEqual(
            try h.string("__first('.formula-preview', __item(0)).getAttribute('aria-live')"),
            "polite"
        )
    }
}
