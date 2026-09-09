import JavaScriptCore
import XCTest
@testable import SecureTestCore

/// The math keypad on a short-text item — roadmap 4b slice 1b
/// (`docs/math-entry-design.md`, decisions D-1.1…D-4.2), 2026-09-08.
///
/// Everything here runs the real renderer script against the JavaScriptCore DOM
/// shim (ADR 0013 — no window server, no WebKit). What that proves is what the
/// student's field ends up holding, where the caret ends up, what is posted and
/// what the tree says to VoiceOver. What it cannot prove is layout, WebKit's own
/// `setRangeText` undo stack, or what the KaTeX-rendered key faces look like —
/// those are hand-run rows (slice 2).
final class RendererMathKeysTests: XCTestCase {
    /// Item 0's stem carries `$`, so the pad opens by default (D-2.2); item 1 is
    /// prose, so it gets the toggle and nothing else.
    private static let bundle = """
    {
      "test_id": "4b", "title": "Math keys",
      "items": [
        { "type": "short_text", "id": "chem", "stem": "Write $x$ as a fraction." },
        { "type": "short_text", "id": "prose", "stem": "Capital of Washington?" }
      ]
    }
    """

    private func harness() throws -> RendererHarness {
        let h = try RendererHarness(bundleJSON: Self.bundle)
        // Two conveniences the shim does not carry: it has no querySelectorAll,
        // so a key is found by walking the pad's buttons for its `data-key`.
        try h.eval("""
        function __pad(n) { return __first('.math-keys', __item(n)); }
        function __toggle(n) { return __first('.math-keys-toggle', __item(n)); }
        function __field(n) { return __first('input', __item(n)); }
        function __keys(n) { return __all('button', __pad(n)); }
        function __key(n, name) {
          return __keys(n).filter(function (b) {
            return b.getAttribute('data-key') === name;
          })[0];
        }
        function __attrs(n, name) {
          return __keys(n).map(function (b) { return b.getAttribute(name); });
        }
        """)
        return h
    }

    /// Puts `text` in item 0's field with the caret (or the selection) where a
    /// student would have left it.
    private func field(_ h: RendererHarness, _ text: String, from: Int, to: Int? = nil) throws {
        try h.eval("""
        var f = __field(0);
        f.value = \(jsString(text));
        f.setSelectionRange(\(from), \(to ?? from));
        """)
    }

    private func jsString(_ text: String) -> String {
        "'" + text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'") + "'"
    }

    /// A pointer activation (`detail` 1) or a keyboard one (`detail` 0).
    private func press(_ h: RendererHarness, _ key: String, detail: Int = 1) throws {
        try h.eval("__key(0, '\(key)').onclick({ detail: \(detail) });")
    }

    private func value(_ h: RendererHarness) throws -> String? {
        try h.string("__field(0).value")
    }

    private func caret(_ h: RendererHarness) throws -> Int {
        try h.int("__field(0).selectionStart")
    }

    private func strings(_ h: RendererHarness, _ expression: String) throws -> [String] {
        let json = try XCTUnwrap(h.string("JSON.stringify(\(expression))"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String])
    }

    // MARK: - the key set (D-2.3)

    func testTheTwentyTwoKeysAreInOrder() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__keys(0).length"), 22)
        XCTAssertEqual(try strings(h, "__attrs(0, 'data-key')"), [
            "fraction", "exponent", "subscript", "sqrt", "open-paren", "close-paren",
            "times", "divide", "pm", "le", "ge", "ne", "degree",
            "pi", "theta", "alpha", "beta", "delta", "lambda", "mu", "sigma", "omega",
        ])
        XCTAssertEqual(try strings(h, "__attrs(0, 'aria-label')"), [
            "Fraction", "Exponent", "Subscript", "Square root",
            "Open parenthesis", "Close parenthesis",
            "Times", "Divided by", "Plus or minus",
            "Less than or equal to", "Greater than or equal to", "Not equal to", "Degrees",
            "Pi", "Theta", "Alpha", "Beta", "Delta", "Lambda", "Mu", "Sigma", "Omega",
        ])
        // Three visual rows: Structure, Operators, Greek.
        XCTAssertEqual(try h.int("__count('.math-keys-row', __item(0))"), 3)
        XCTAssertEqual(
            try strings(h, "__all('.math-keys-row', __item(0)).map(function (r) { return String(r.children.length); })"),
            ["6", "7", "9"]
        )
    }

    /// The visible face is a span the screen reader skips — the words are on the
    /// button. Without KaTeX (the harness, a stripped build) the face is the
    /// text fallback, which is what makes the key readable at all in that case.
    func testEveryLabelIsAriaHiddenAndFallsBackToTextWithoutKatex() throws {
        let h = try harness()
        XCTAssertEqual(
            try strings(h, "__keys(0).map(function (b) { return b.children[0].getAttribute('aria-hidden'); })"),
            Array(repeating: "true", count: 22)
        )
        XCTAssertEqual(
            try strings(h, "__keys(0).slice(0, 6).map(function (b) { return b.textContent; })"),
            ["a/b", "x²", "x₂", "√a", "(", ")"]
        )
        XCTAssertEqual(
            try strings(h, "__keys(0).slice(6).map(function (b) { return b.textContent; })"),
            ["×", "÷", "±", "≤", "≥", "≠", "°",
             "π", "θ", "α", "β", "Δ", "λ", "μ", "Σ", "Ω"]
        )
        // Momentary, not toggles — no aria-pressed (the drawing toolbar's model
        // does not apply).
        XCTAssertEqual(try h.int("__keys(0).filter(function (b) { return b.getAttribute('aria-pressed') !== null; }).length"), 0)
    }

    func testThePadIsAToolbarTheToggleControls() throws {
        let h = try harness()
        XCTAssertEqual(try h.string("__pad(0).getAttribute('role')"), "toolbar")
        XCTAssertEqual(try h.string("__pad(0).getAttribute('aria-label')"), "Math keys")
        XCTAssertEqual(try h.string("__pad(0).getAttribute('id')"), "math-keys-chem")
        XCTAssertEqual(try h.string("__toggle(0).getAttribute('aria-controls')"), "math-keys-chem")
        XCTAssertEqual(try h.string("__toggle(0).textContent"), "Math keys")
        // Per item: the second field has its own pad with its own id.
        XCTAssertEqual(try h.string("__pad(1).getAttribute('id')"), "math-keys-prose")
    }

    /// D-2.1: field -> preview -> toggle -> pad, so the rendered answer stays
    /// directly under the text it renders.
    func testTheOrderIsFieldHintPreviewToggleThenPad() throws {
        let h = try harness()
        XCTAssertEqual(
            try strings(h, """
            __first('.short-text-wrap', __item(0)).children.map(function (c) {
              return c.className || c.tagName;
            })
            """),
            ["short-text", "formula-hint", "formula-preview", "math-keys-toggle", "math-keys"]
        )
        XCTAssertEqual(
            try strings(h, """
            __first('.short-text-wrap', __item(1)).children.map(function (c) {
              return c.className || c.tagName;
            })
            """),
            ["short-text", "formula-preview", "math-keys-toggle", "math-keys"]
        )
    }

    // MARK: - the toggle's default (D-2.2)

    func testThePadOpensByDefaultOnlyWhereTheStemCarriesMath() throws {
        let h = try harness()
        XCTAssertEqual(try h.string("__toggle(0).getAttribute('aria-expanded')"), "true")
        XCTAssertNil(try h.string("__pad(0).getAttribute('hidden')"))
        XCTAssertEqual(try h.string("__toggle(1).getAttribute('aria-expanded')"), "false")
        XCTAssertEqual(try h.string("__pad(1).getAttribute('hidden')"), "")
    }

    func testTheToggleFlipsBothTheStateAndThePad() throws {
        let h = try harness()
        try h.eval("__toggle(0).onclick();")
        XCTAssertEqual(try h.string("__toggle(0).getAttribute('aria-expanded')"), "false")
        XCTAssertEqual(try h.string("__pad(0).getAttribute('hidden')"), "")
        try h.eval("__toggle(0).onclick();")
        XCTAssertEqual(try h.string("__toggle(0).getAttribute('aria-expanded')"), "true")
        XCTAssertNil(try h.string("__pad(0).getAttribute('hidden')"))

        // The prose field's pad opens on request — a student may need a symbol
        // on any question, and the client cannot know which.
        try h.eval("__toggle(1).onclick();")
        XCTAssertEqual(try h.string("__toggle(1).getAttribute('aria-expanded')"), "true")
        XCTAssertNil(try h.string("__pad(1).getAttribute('hidden')"))
    }

    // MARK: - what each key inserts, and where the caret lands (D-1.1, D-1.4)

    func testFractionAtTheCaretInsertsTheEmptyStructureAndLandsInTheNumerator() throws {
        let h = try harness()
        try field(h, "1", from: 1)
        try press(h, "fraction")
        XCTAssertEqual(try value(h), #"1\frac{}{}"#)
        XCTAssertEqual(try caret(h), #"1\frac{"#.count, "inside the numerator")
    }

    func testFractionOverASelectionMakesItTheNumeratorAndLandsInTheDenominator() throws {
        let h = try harness()
        try field(h, "x+1", from: 0, to: 3)
        try press(h, "fraction")
        XCTAssertEqual(try value(h), #"\frac{x+1}{}"#)
        XCTAssertEqual(try caret(h), #"\frac{x+1}{"#.count, "inside the denominator")
    }

    func testExponentAndSubscriptWrapASelectionOrOpenAnEmptySlot() throws {
        let h = try harness()
        try field(h, "x", from: 1)
        try press(h, "exponent")
        XCTAssertEqual(try value(h), "x^{}")
        XCTAssertEqual(try caret(h), 3, "inside the braces")

        let g = try harness()
        try field(g, "10", from: 0, to: 2)
        try press(g, "exponent")
        XCTAssertEqual(try value(g), "^{10}")
        XCTAssertEqual(try caret(g), 5, "after the closing brace")

        let s = try harness()
        try field(s, "H", from: 1)
        try press(s, "subscript")
        XCTAssertEqual(try value(s), "H_{}")
        XCTAssertEqual(try caret(s), 3)

        let t = try harness()
        try field(t, "H2O", from: 1, to: 2)
        try press(t, "subscript")
        XCTAssertEqual(try value(t), "H_{2}O")
        XCTAssertEqual(try caret(t), 5, "after the closing brace, before the O")
    }

    func testSquareRootOpensAnEmptyRadicalOrWrapsTheSelection() throws {
        let h = try harness()
        try field(h, "", from: 0)
        try press(h, "sqrt")
        XCTAssertEqual(try value(h), #"\sqrt{}"#)
        XCTAssertEqual(try caret(h), #"\sqrt{"#.count)

        let g = try harness()
        try field(g, "2", from: 0, to: 1)
        try press(g, "sqrt")
        XCTAssertEqual(try value(g), #"\sqrt{2}"#)
        XCTAssertEqual(try caret(g), #"\sqrt{2}"#.count, "after the closing brace")
    }

    func testTheParenthesesGoInAsThemselves() throws {
        let h = try harness()
        try field(h, "", from: 0)
        try press(h, "open-paren")
        try press(h, "close-paren")
        XCTAssertEqual(try value(h), "()")
        XCTAssertEqual(try caret(h), 2)
    }

    /// A symbol key is one character at the caret — the whole point of D-1.1.
    func testASymbolKeyInsertsOneCharacterAtTheCaret() throws {
        let h = try harness()
        try field(h, "3.210", from: 3)
        try press(h, "times")
        XCTAssertEqual(try value(h), "3.2×10")
        XCTAssertEqual(try caret(h), 4, "after the ×")
    }

    func testAGreekKeyInsertsTheLetter() throws {
        let h = try harness()
        try field(h, "", from: 0)
        try press(h, "pi")
        XCTAssertEqual(try value(h), "π")
        try press(h, "sigma")
        XCTAssertEqual(try value(h), "πΣ")
        XCTAssertEqual(try caret(h), 2)
    }

    /// With no selection API answer at all (a field nobody has clicked into),
    /// the insertion appends rather than landing at position zero.
    func testAnUntouchedFieldInsertsAtTheEnd() throws {
        let h = try harness()
        try h.eval("__field(0).value = '45';")
        try press(h, "degree")
        XCTAssertEqual(try value(h), "45°")
    }

    // MARK: - the change trap (D-3.2)

    func testEveryInsertionPostsTheNewFullValue() throws {
        let h = try harness()
        try field(h, "H", from: 1)
        try press(h, "subscript")
        try h.eval("__field(0).value = 'H_{2}'; __field(0).setSelectionRange(5, 5);")
        try press(h, "times")

        let posted = try h.postedMessages()
        XCTAssertEqual(posted.count, 2, "one post per insertion, not one at the end")
        XCTAssertEqual(
            posted.map { (($0["response"] as? [String: Any])?["text"] as? String) ?? "" },
            ["H_{}", "H_{2}×"]
        )
        XCTAssertEqual((posted[0]["response"] as? [String: Any])?["type"] as? String, "short_text")
        XCTAssertEqual(posted[0]["item_id"] as? String, "chem")
    }

    /// The pre-keypad path is untouched: typing and blurring still posts the raw
    /// typed text through the same handler.
    func testTheTypedThenChangePathStillPosts() throws {
        let h = try harness()
        try h.eval("var f = __field(0); f.value = 'H_2O'; f.oninput(); f.onchange();")
        let posted = try h.postedMessages()
        XCTAssertEqual(posted.count, 1)
        XCTAssertEqual((posted[0]["response"] as? [String: Any])?["text"] as? String, "H_2O")
    }

    /// D-4.1: the preview is unchanged — `formulaTex` still wraps the raw field
    /// text in `\mathrm{…}`, and an empty fraction parses, so the bar appears
    /// the moment the key is pressed.
    func testTheInsertionRepaintsThePreview() throws {
        let h = try harness()
        try field(h, "", from: 0)
        try press(h, "fraction")
        XCTAssertEqual(
            try h.string("__first('.formula-preview', __item(0)).getAttribute('data-tex')"),
            #"\mathrm{\frac{}{}}"#
        )
    }

    // MARK: - focus (D-3.1)

    func testAPointerClickPutsFocusBackInTheFieldAndAKeyboardActivationDoesNot() throws {
        let h = try harness()
        try field(h, "", from: 0)
        try h.eval("__focused = null;")
        try press(h, "times", detail: 1)
        XCTAssertTrue(try h.bool("document.activeElement === __field(0)"), "a pointer click returns to the field")

        try h.eval("__focused = null;")
        try press(h, "times", detail: 0)
        XCTAssertTrue(try h.bool("document.activeElement === null"), "a keyboard activation stays on the key")

        // No event at all (the harness's own bare call) is treated as keyboard.
        try h.eval("__focused = null; __key(0, 'pi').onclick();")
        XCTAssertTrue(try h.bool("document.activeElement === null"))
    }

    func testPointerDownIsPreventedSoTheFieldKeepsItsSelection() throws {
        let h = try harness()
        try h.eval("""
        var prevented = 0;
        __keys(0).forEach(function (b) {
          b.onpointerdown({ preventDefault: function () { prevented += 1; } });
        });
        """)
        XCTAssertEqual(try h.int("prevented"), 22)
    }

    // MARK: - roving tabindex (D-3.1)

    private func tabIndexes(_ h: RendererHarness) throws -> [String] {
        try strings(h, "__attrs(0, 'tabindex')")
    }

    func testExactlyOneKeyIsATabStopAndArrowsMoveIt() throws {
        let h = try harness()
        var expected = Array(repeating: "-1", count: 22)
        expected[0] = "0"
        XCTAssertEqual(try tabIndexes(h), expected, "Fraction starts as the pad's one Tab stop")

        try h.eval("__focused = null; __pad(0).onkeydown({ key: 'ArrowRight', preventDefault: function () { window.__prevented = true; } });")
        expected[0] = "-1"
        expected[1] = "0"
        XCTAssertEqual(try tabIndexes(h), expected)
        XCTAssertTrue(try h.bool("document.activeElement === __key(0, 'exponent')"))
        XCTAssertTrue(try h.bool("window.__prevented === true"), "the arrow must not also scroll the page")
    }

    func testArrowLeftWrapsFromTheFirstKeyToTheLast() throws {
        let h = try harness()
        try h.eval("__focused = null; __pad(0).onkeydown({ key: 'ArrowLeft' });")
        var expected = Array(repeating: "-1", count: 22)
        expected[21] = "0"
        XCTAssertEqual(try tabIndexes(h), expected)
        XCTAssertTrue(try h.bool("document.activeElement === __key(0, 'omega')"))
    }

    func testHomeAndEndGoToTheEnds() throws {
        let h = try harness()
        try h.eval("__pad(0).onkeydown({ key: 'End' });")
        XCTAssertTrue(try h.bool("document.activeElement === __key(0, 'omega')"))
        try h.eval("__pad(0).onkeydown({ key: 'Home' });")
        XCTAssertTrue(try h.bool("document.activeElement === __key(0, 'fraction')"))
        var expected = Array(repeating: "-1", count: 22)
        expected[0] = "0"
        XCTAssertEqual(try tabIndexes(h), expected)
    }

    func testAnUnhandledKeyLeavesTheRovingIndexAlone() throws {
        let h = try harness()
        try h.eval("__focused = null; __pad(0).onkeydown({ key: 'a' });")
        XCTAssertTrue(try h.bool("document.activeElement === null"))
        var expected = Array(repeating: "-1", count: 22)
        expected[0] = "0"
        XCTAssertEqual(try tabIndexes(h), expected)
    }

    // MARK: - the hint (D-4.2)

    func testTheHintNamesTheKeysAndAppearsOnlyWhereTheStemCarriesMath() throws {
        let h = try harness()
        XCTAssertEqual(
            try h.string("__first('.formula-hint', __item(0)).textContent"),
            "Use the math keys below, or type _ for a subscript and ^ for an exponent. "
                + "Your answer shows below as it will be read."
        )
        XCTAssertEqual(try h.int("__count('.formula-hint', __item(1))"), 0)
    }

    // MARK: - the real library (the design note's "try one more")

    /// The vendored `katex.min.js` IS the client's, and it evaluates in a bare
    /// `JSContext`: it is a UMD bundle whose `document` use on the
    /// `renderToString` path is a `compatMode` probe and element construction it
    /// never needs for a string. So every key's insertion can be proven to PARSE
    /// here, headlessly, rather than only in a hand-run row — the one thing the
    /// DOM-shim tests above cannot show.
    ///
    /// The wrapper is `formulaTex`'s: `\mathrm{…}` around the field's text, with
    /// a whitespace run as `\ `. That function lives inside the renderer's IIFE
    /// and is not reachable from here, so the two cases below that carry a space
    /// spell the `\ ` out; everything else has none.
    private func katexContext() throws -> JSContext {
        let context = try XCTUnwrap(JSContext())
        var thrown: String?
        context.exceptionHandler = { _, exception in thrown = exception?.toString() ?? "unknown" }
        // The library's whole `document` surface on this path.
        context.evaluateScript("""
        var window = this;
        var document = {
          compatMode: 'CSS1Compat',
          createElement: function () {
            return { style: {}, setAttribute: function () {}, appendChild: function () {} };
          },
          createTextNode: function () { return {}; }
        };
        """)
        context.evaluateScript(KatexBundle.shared.js)
        context.evaluateScript(KatexBundle.macrosScript)
        if let thrown { XCTFail("katex did not evaluate: \(thrown)") }
        XCTAssertEqual(context.evaluateScript("typeof katex.renderToString")?.toString(), "function")
        return context
    }

    /// Every insertion the 22 keys make — empty, as the key leaves it, and
    /// filled, as the student leaves it — parses with `throwOnError: true`. An
    /// empty structure MUST parse: that is what makes the preview a live guide
    /// while a slot is still being filled (D-1.4).
    func testEveryKeysInsertionParsesInTheRealKatex() throws {
        let context = try katexContext()
        let insertions = [
            #"\frac{}{}"#, #"\frac{1}{2}"#, #"\frac{x+1}{2}"#,
            "x^{}", "10^{-4}",
            "x_{}", "H_{2}O",
            #"\sqrt{}"#, #"\sqrt{2}"#,
            "()", "(x+1)",
            "×", "÷", "±", "≤", "≥", "≠", "°", "45°C",
            #"3.2\ ×\ 10^{5}"#,
            "π", "θ", "α", "β", "Δ", "λ", "μ", "Σ", "Ω",
            #"Δ\ =\ 5°"#,
        ]
        for insertion in insertions {
            let tex = #"\mathrm{"# + insertion + "}"
            let escaped = tex.replacingOccurrences(of: "\\", with: "\\\\")
            let result = context.evaluateScript("""
            (function () {
              try {
                katex.renderToString('\(escaped)', {
                  throwOnError: true, strict: 'ignore', trust: false, macros: KATEX_MACROS
                });
                return 'ok';
              } catch (e) { return 'ERROR: ' + (e && e.message); }
            })()
            """)
            XCTAssertEqual(result?.toString(), "ok", "\(tex) must render")
        }
    }
}
