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
}
