import XCTest
@testable import SecureTestCore

/// C-2 (James, 2026-09-09, `docs/multi-source-stimulus-design.md`): a single
/// `$` whose next character is a digit is money and never opens math — a pilot
/// stimulus's `$57,600 … $30,000–$120,000` rendered as one KaTeX run — and the
/// client's math pass is now the renderer's own walk over `mathSegments`
/// rather than KaTeX's auto-render.
///
/// What the JavaScriptCore harness can prove and what it cannot: KaTeX is NOT
/// loaded there, so the closing math pass (guarded on `typeof katex`) never
/// runs and no `.katex` element can be observed either way. What IS observable
/// is the split itself, because the E6 emphasis pass uses the SAME
/// `mathSegments` splitter and leaves math segments as untouched text while
/// turning `**bold**` inside a TEXT segment into a `strong` element. So a
/// `**…**` marker placed inside a `$…$` run reports, honestly and from the
/// real renderer, which side of the rule the run fell on.
final class RendererMathPassTests: XCTestCase {
    private static let bundle = """
    {
      "test_id": "c2", "title": "C-2",
      "items": [
        { "type": "multiple_choice_single", "id": "q1",
          "stem": "Costs rose from $57,600 to between $30,000\\u2013$120,000 a year.",
          "choices": [ { "id": "a", "text": "a" } ] },
        { "type": "multiple_choice_single", "id": "q2",
          "stem": "Costs $57,600 **rose** to $30,000 today.",
          "choices": [ { "id": "a", "text": "a" } ] },
        { "type": "multiple_choice_single", "id": "q3",
          "stem": "Solve $x**y**$ now.",
          "choices": [ { "id": "a", "text": "a" } ] },
        { "type": "multiple_choice_single", "id": "q4",
          "stem": "Pay $5**x**$ now.",
          "choices": [ { "id": "a", "text": "a" } ] },
        { "type": "multiple_choice_single", "id": "q5",
          "stem": "Display $$5**x**$$ end.",
          "choices": [ { "id": "a", "text": "a" } ] },
        { "type": "multiple_choice_single", "id": "q6",
          "stem": "Cost \\\\$5 and $x**y**$ here.",
          "choices": [ { "id": "a", "text": "a" } ] },
        { "type": "multiple_choice_single", "id": "q7",
          "stem": "Fee \\\\$57,600 flat, no math.",
          "choices": [ { "id": "a", "text": "a" } ] }
      ],
      "item_sets": [], "assets": {}, "accommodations": {}
    }
    """

    private func harness() throws -> RendererHarness {
        try RendererHarness(bundleJSON: Self.bundle)
    }

    private func stem(_ n: Int) -> String { "__first('.stem', __item(\(n)))" }

    /// (a) Every `$` of a money run survives into the visible text, and nothing
    /// of it became math markup.
    func testDollarAmountsStayPlainText() throws {
        let h = try harness()
        XCTAssertEqual(
            try h.string("\(stem(0)).textContent"),
            "Costs rose from $57,600 to between $30,000\u{2013}$120,000 a year."
        )
        XCTAssertEqual(try h.int("__count('.katex', __item(0))"), 0)
        XCTAssertEqual(try h.int("__count('strong', __item(0))"), 0, "no marker to fold")
    }

    /// (d) `$5x$` is text on BOTH sides of the run: the `**rose**` between two
    /// dollar amounts folds, which it could not do inside a math segment.
    func testARunBetweenTwoAmountsIsTextNotMath() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('strong', \(stem(1)))"), 1)
        XCTAssertEqual(try h.string("__first('strong', \(stem(1))).textContent"), "rose")
        XCTAssertEqual(
            try h.string("\(stem(1)).textContent"),
            "Costs $57,600 rose to $30,000 today."
        )
    }

    /// (b) A `$` before a non-digit still opens math: the markers inside stay
    /// literal because the segment is handed on untouched.
    func testASingleDollarBeforeALetterStillOpensMath() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('strong', \(stem(2)))"), 0)
        XCTAssertEqual(try h.string("\(stem(2)).textContent"), "Solve $x**y**$ now.")
    }

    /// (d) `$5x$` — a lone `$` before a digit does not open, so the whole line
    /// is text and the markers inside it fold.
    func testASingleDollarBeforeADigitDoesNotOpenMath() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('strong', \(stem(3)))"), 1)
        XCTAssertEqual(try h.string("\(stem(3)).textContent"), "Pay $5x$ now.")
    }

    /// The rule is for the SINGLE `$` only: a `$$` display opener before a
    /// digit behaves exactly as it did.
    func testADisplayOpenerBeforeADigitIsUnchanged() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('strong', \(stem(4)))"), 0)
        XCTAssertEqual(try h.string("\(stem(4)).textContent"), "Display $$5**x**$$ end.")
    }

    /// (c) `\$` still escapes: it opens nothing, so the `$x**y**$` after it is
    /// the math run. The harness can only show the escape UNRESOLVED — turning
    /// `\$` into `$` is the math pass's text branch, which needs KaTeX loaded;
    /// the rule itself is pinned against the design tool's `pushText` below.
    func testABackslashEscapedDollarOpensNothing() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('strong', \(stem(5)))"), 0, "the math run swallowed them")
        XCTAssertEqual(try h.string("\(stem(5)).textContent"), "Cost \\$5 and $x**y**$ here.")
        // renderLatex's pushText: `raw.replace(/\\\$/g, "$")` on text tokens.
        XCTAssertTrue(AssessmentPage.rendererScript.contains(#"seg.text.replace(/\\\$/g, '$')"#))
    }

    // MARK: - With the real vendored KaTeX loaded

    /// The library, as `AssessmentPage.html` inlines it, plus the two globals
    /// JavaScriptCore has no browser to supply: KaTeX warns through
    /// `console.warn` and reads `document.compatMode` at load.
    private func withKatex() throws -> RendererHarness {
        try RendererHarness(
            bundleJSON: Self.bundle,
            prelude: "console.warn = function () {}; document.compatMode = 'CSS1Compat';\n"
                + KatexBundle.shared.js + "\n" + KatexBundle.macrosScript)
    }

    /// End to end with the real library: `$x**y**$` becomes ONE katex element
    /// and every `$` of the money line is still literal text.
    ///
    /// The shim's `textContent` setter empties a node, and `katex.render`
    /// starts by clearing the span it was handed — so a rendered formula
    /// reports an empty `textContent` here. That is the shim, not the page;
    /// the assertions below read the element count rather than its text.
    func testTheRealLibraryRendersMathAndLeavesMoneyAlone() throws {
        let h = try withKatex()
        XCTAssertEqual(try h.int("__count('.katex', __item(0))"), 0, "no math on the money line")
        XCTAssertEqual(
            try h.string("\(stem(0)).textContent"),
            "Costs rose from $57,600 to between $30,000\u{2013}$120,000 a year."
        )
        XCTAssertEqual(try h.int("__count('.katex', __item(2))"), 1, "$x**y**$ is one formula")
        XCTAssertEqual(try h.int("__count('.katex', __item(3))"), 0, "$5x$ is money, not math")
        XCTAssertEqual(try h.string("\(stem(3)).textContent"), "Pay $5x$ now.")
    }

    /// (c) With the library loaded the text branch runs, and `\$` reaches the
    /// student as a plain `$` — the design tool's `pushText` rule.
    func testAnEscapedDollarBecomesALiteralDollar() throws {
        let h = try withKatex()
        XCTAssertEqual(try h.int("__count('.katex', __item(5))"), 1)
        XCTAssertEqual(try h.string("\(stem(5)).textContent"), "Cost $5 and  here.")
    }

    /// A prose-only run (no math at all) still loses the backslash — the
    /// importer writes money as `\$57,600` — so the pass must not skip it.
    func testAnEscapedDollarInProseWithoutMathIsUnescaped() throws {
        let h = try withKatex()
        XCTAssertEqual(try h.int("__count('.katex', __item(6))"), 0)
        XCTAssertEqual(try h.string("\(stem(6)).textContent"), "Fee $57,600 flat, no math.")
    }

    /// The pass is ours, not auto-render's, and it is guarded so a page without
    /// the library shows the source text instead of failing.
    func testTheMathPassIsTheRenderersOwnAndGuarded() {
        let script = AssessmentPage.rendererScript
        XCTAssertFalse(script.contains("renderMathInElement"))
        XCTAssertTrue(script.contains("typeof katex === 'object' && katex && typeof katex.render === 'function'"))
        XCTAssertTrue(script.contains("renderMathIn(root);"))
    }
}
