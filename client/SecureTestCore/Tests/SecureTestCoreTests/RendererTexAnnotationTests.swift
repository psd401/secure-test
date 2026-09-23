import XCTest
@testable import SecureTestCore

/// Finding ME-3 (2026-09-23, district Mac, real AAC session, v1.3.4): VoiceOver
/// read a short-text answer's formula preview as the literal `\frac{1}{2}`.
/// KaTeX's MathML twin carries the LaTeX source in an
/// `<annotation encoding="application/x-tex">`; the renderer now removes every
/// annotation after a render — in the answer preview (main and last-good
/// renders) and in the page-wide math pass over stems and choices — and keeps
/// the MathML.
///
/// What this cannot prove: what VoiceOver actually speaks. The harness has no
/// accessibility tree; that is a hand-run row.
final class RendererTexAnnotationTests: XCTestCase {
    private static let bundle = """
    {
      "test_id": "me3", "title": "ME-3",
      "items": [
        { "type": "short_text", "id": "half", "stem": "Write $\\\\frac{1}{2}$ as a fraction." }
      ]
    }
    """

    /// Every text node's own text under a node. The shim's `textContent`
    /// getter reports "" for a node `katex.render` cleared (see
    /// RendererMathPassTests), so the text a live region would read is
    /// collected from the leaves instead.
    private static let leafTextJS = """
    function __leafText(n) {
      if (!n) return '';
      if (n.tagName === '#text') return n._text || '';
      return (n.children || []).map(__leafText).join('');
    }
    function __type(text) {
      var f = __first('input', __item(0));
      f.value = text;
      f.oninput();
    }
    """

    private func withRealKatex() throws -> RendererHarness {
        let h = try RendererHarness(
            bundleJSON: Self.bundle,
            prelude: "console.warn = function () {}; document.compatMode = 'CSS1Compat';\n"
                + KatexBundle.shared.js + "\n" + KatexBundle.macrosScript)
        try h.eval(Self.leafTextJS)
        return h
    }

    private let preview = "__first('.formula-preview', __item(0))"
    private let stem = "__first('.stem', __item(0))"

    /// The helper against a KaTeX-shaped tree built by a stub: the annotation
    /// goes, its siblings and the rest of the markup stay.
    func testTheHelperRemovesOnlyTheAnnotation() throws {
        let h = try RendererHarness(bundleJSON: Self.bundle)
        try h.eval(Self.leafTextJS)
        try h.eval("""
        var katex = {
          render: function (tex, node) {
            node.textContent = '';
            function el(tag, cls, kids) {
              var e = document.createElement(tag);
              if (cls) e.className = cls;
              (kids || []).forEach(function (k) { e.appendChild(k); });
              return e;
            }
            var ann = el('annotation');
            ann.setAttribute('encoding', 'application/x-tex');
            ann.appendChild(document.createTextNode(tex));
            var sem = el('semantics', '', [el('mrow', '', [el('mn', '', [document.createTextNode('1')])]), ann]);
            var html = el('span', 'katex-html', [document.createTextNode('VISUAL')]);
            html.setAttribute('aria-hidden', 'true');
            node.appendChild(el('span', 'katex', [el('span', 'katex-mathml', [el('math', '', [sem])]), html]));
          }
        };
        __type('x^2');
        """)
        XCTAssertEqual(try h.int("__count('annotation', \(preview))"), 0)
        XCTAssertEqual(try h.int("__count('semantics', \(preview))"), 1)
        XCTAssertEqual(try h.int("__count('mn', \(preview))"), 1)
        XCTAssertEqual(try h.int("__count('.katex-html', \(preview))"), 1)
        XCTAssertEqual(try h.string("__leafText(\(preview))"), "1VISUAL")
    }

    /// Guard against a vacuous pass: the vendored library really does emit the
    /// annotation the renderer strips.
    func testTheVendoredLibraryEmitsATexAnnotation() throws {
        let h = try withRealKatex()
        XCTAssertTrue(try h.bool(
            "katex.renderToString('\\\\frac{1}{2}', {}).indexOf('application/x-tex') !== -1"
        ))
        // And into the shim, as the renderer's own calls do, before any strip.
        XCTAssertEqual(try h.int("""
        (function () {
          var n = document.createElement('div');
          katex.render('\\\\frac{1}{2}', n, {});
          return __count('annotation', n);
        })()
        """), 1)
    }

    /// The main preview render with the real library: MathML kept, no LaTeX
    /// left in any text node, and the posted answer and `data-tex` untouched.
    func testThePreviewKeepsMathmlAndLosesTheLatexSource() throws {
        let h = try withRealKatex()
        try h.eval("__type('\\\\frac{1}{2}'); __first('input', __item(0)).onchange();")
        XCTAssertEqual(try h.int("__count('.katex', \(preview))"), 1)
        XCTAssertEqual(try h.int("__count('math', \(preview))"), 1)
        XCTAssertEqual(try h.int("__count('mfrac', \(preview))"), 1)
        XCTAssertEqual(try h.int("__count('annotation', \(preview))"), 0)
        let text = try XCTUnwrap(try h.string("__leafText(\(preview))"))
        XCTAssertFalse(text.contains("\\"), "no LaTeX in the preview's text, got: \(text)")
        XCTAssertEqual(try h.string("\(preview).getAttribute('data-tex')"), "\\mathrm{\\frac{1}{2}}")
        let response = try h.postedMessages().last?["response"] as? [String: Any]
        XCTAssertEqual(response?["text"] as? String, "\\frac{1}{2}")
    }

    /// The last-good repaint after a half-typed formula strips too.
    func testTheLastGoodRepaintLosesTheLatexSource() throws {
        let h = try withRealKatex()
        try h.eval("__type('\\\\frac{1}{2}'); __type('\\\\frac{1}{2} \\\\frac{');")
        XCTAssertEqual(try h.int("__count('.formula-preview-note', \(preview))"), 1)
        XCTAssertEqual(try h.int("__count('math', \(preview))"), 1, "the last good render is back")
        XCTAssertEqual(try h.int("__count('annotation', \(preview))"), 0)
        let text = try XCTUnwrap(try h.string("__leafText(\(preview))"))
        XCTAssertFalse(text.contains("\\"), "no LaTeX in the preview's text, got: \(text)")
    }

    /// The page-wide math pass over stems has the same leak and the same fix.
    func testTheStemMathPassLosesTheLatexSource() throws {
        let h = try withRealKatex()
        XCTAssertEqual(try h.int("__count('.katex', \(stem))"), 1)
        XCTAssertEqual(try h.int("__count('mfrac', \(stem))"), 1)
        XCTAssertEqual(try h.int("__count('annotation', \(stem))"), 0)
        let text = try XCTUnwrap(try h.string("__leafText(\(stem))"))
        XCTAssertFalse(text.contains("\\frac"), "no LaTeX in the stem's text, got: \(text)")
    }
}
