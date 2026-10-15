import XCTest
@testable import SecureTestCore

/// Passage highlighting slice 2 (`docs/passage-highlighting-design.md`): the
/// page half, mouse only. The gate (`allow_highlighting` true only), which
/// blocks opt in to selection, the wrapping rules the spike asked for —
/// boundary points rather than containers, one mark per paragraph, a formula
/// wrapped whole — removing one mark and clearing them all, the floating
/// Highlight button driven by a stub Selection, read-aloud over marked text,
/// and that nothing is ever posted. Also the mark colour of every contrast
/// set at 4.5:1 or better.
///
/// What this cannot prove: that WebKit lets the mouse select inside the
/// locked page, where the button lands, or that VoiceOver says
/// "highlighted" — spike rows already run, and the build's hand-run rows.
final class RendererHighlightTests: XCTestCase {
    private static let bundle = #"""
    {
      "test_id": "hl", "title": "Highlight",
      "items": [
        { "type": "short_text", "id": "q1", "stem": "A stem that stays unselectable." },
        { "type": "essay", "id": "q2", "stem": "Second." }
      ],
      "item_sets": [
        { "id": "s1", "stimulus": "Read the passage.", "layout": "inline",
          "sources": [ { "label": "Source A", "text": "Alpha text." },
                       { "label": "Source B", "text": "Beta text." } ],
          "item_ids": ["q2"] }
      ]
    }
    """#

    /// A stub Selection and document listeners, which the shim has neither
    /// of; `__select` makes a selection and fires a mouse-up as WebKit would.
    private static let selectionPrelude = #"""
    var __listeners = {};
    document.addEventListener = function (type, fn) {
      (__listeners[type] = __listeners[type] || []).push(fn);
    };
    function __fire(type, event) {
      (__listeners[type] || []).forEach(function (fn) { fn(event || {}); });
    }
    var __sel = null;
    window.getSelection = function () {
      return {
        rangeCount: __sel ? 1 : 0,
        isCollapsed: !__sel,
        getRangeAt: function () { return __sel; },
        removeAllRanges: function () { __sel = null; },
        toString: function () { return __sel ? __sel.text : ''; }
      };
    };
    function __select(sn, so, en, eo, text) {
      __sel = {
        startContainer: sn, startOffset: so, endContainer: en, endOffset: eo, text: text,
        getBoundingClientRect: function () { return { left: 40, top: 100, bottom: 120, right: 90 }; }
      };
      __fire('mouseup');
      __fireTimers();
    }
    // Replaces a passage body's children with the given nodes.
    function __setBody(body, nodes) {
      while (body.childNodes.length) body.removeChild(body.childNodes[0]);
      nodes.forEach(function (n) { body.appendChild(n); });
    }
    function __text(s) { return document.createTextNode(s); }
    function __marks(node) { return __all('mark', node || __root); }
    function __markTexts(node) {
      return __marks(node).map(function (m) { return m.textContent; }).join('|');
    }
    """#

    private func harness(
        flag: String? = "true", tts: Bool = false, selection: Bool = true
    ) throws -> RendererHarness {
        var json = Self.bundle
        if let flag {
            json = json.replacingOccurrences(
                of: #""test_id": "hl","#, with: #""allow_highlighting": \#(flag), "test_id": "hl","#)
        }
        var prelude = selection ? Self.selectionPrelude : ""
        if tts { prelude += "\nvar TTS_SCOPE = { items: false, stimuli: true };" }
        return try RendererHarness(bundleJSON: json, prelude: prelude)
    }

    private let passage = "__first('.stimulus-body')"

    // MARK: - The gate

    func testFlagAbsentOrFalseChangesNothing() throws {
        for flag in [nil, "false", "\"true\"", "1"] {
            let h = try harness(flag: flag)
            XCTAssertEqual(try h.int("__count('.st-highlightable')"), 0, "flag \(flag ?? "absent")")
            XCTAssertEqual(try h.int("__count('.st-highlight-button', document.body)"), 0)
            XCTAssertEqual(try h.int("__count('.st-mark-clear')"), 0)
            XCTAssertEqual(try h.string("typeof \(passage).__hlMark"), "undefined")
            XCTAssertEqual(try h.string("typeof \(passage).onclick"), "undefined")
            XCTAssertEqual(try h.string("Object.keys(__listeners).join(',')"), "")
        }
    }

    func testFlagOnOptsInPassagesAndNothingElse() throws {
        let h = try harness()
        // The introduction and both sources.
        XCTAssertEqual(try h.int("__count('.st-highlightable')"), 3)
        XCTAssertEqual(try h.int("__count('.stimulus-body')"), 1)
        XCTAssertEqual(try h.int("__count('.source-body')"), 2)
        XCTAssertTrue(try h.bool("""
            __all('.st-highlightable').every(function (n) {
              return n.className === 'stimulus-body st-highlightable' ||
                n.className === 'source-body st-highlightable';
            })
            """))
        // The button is made on first use, not at build.
        XCTAssertEqual(try h.int("__count('.st-highlight-button', document.body)"), 0)
        XCTAssertEqual(try h.string("Object.keys(__listeners).sort().join(',')"), "mouseup,scroll,selectionchange")
    }

    // MARK: - Wrapping

    func testWrapsOneWordInsideOneTextNodeExactly() throws {
        let h = try harness()
        try h.eval("var t = __text('The cell membrane controls entry.'); __setBody(\(passage), [t]);")
        XCTAssertEqual(try h.int("\(passage).__hlMark(t, 4, t, 8)"), 1)
        XCTAssertEqual(try h.string("__markTexts()"), "cell")
        XCTAssertEqual(try h.string("__marks()[0].className"), "st-mark")
        XCTAssertEqual(try h.string("\(passage).textContent"), "The cell membrane controls entry.")
        XCTAssertEqual(try h.int("\(passage).childNodes.length"), 3)
    }

    func testASelectionAcrossABlankLineMakesOneMarkPerParagraph() throws {
        let h = try harness()
        let text = "First para here.\\n\\nSecond para here."
        try h.eval("var s = '\(text)'; var t = __text(s); __setBody(\(passage), [t]);")
        XCTAssertEqual(try h.int("\(passage).__hlMark(t, s.indexOf('para'), t, s.indexOf('here', 20))"), 2)
        XCTAssertEqual(try h.string("__markTexts()"), "para here.|Second para")
        // The blank line itself stays outside every mark.
        XCTAssertFalse(try h.bool("__marks().some(function (m) { return m.textContent.indexOf('\\n') !== -1; })"))
        XCTAssertEqual(try h.string("\(passage).textContent"), "First para here.\n\nSecond para here.")
    }

    /// The spike's third detail: a point on an ELEMENT (offset = a child
    /// index) marks from that child on — not from the start of whatever
    /// contains it.
    func testElementBoundaryPointsMarkOnlyTheSelectedText() throws {
        let h = try harness()
        try h.eval("""
            var t1 = __text('Alpha beta '); var t2 = __text('gamma delta');
            __setBody(\(passage), [t1, t2]);
            """)
        // Start before the second child, end inside it.
        XCTAssertEqual(try h.int("\(passage).__hlMark(\(passage), 1, t2, 5)"), 1)
        XCTAssertEqual(try h.string("__markTexts()"), "gamma")
        XCTAssertEqual(try h.string("\(passage).textContent"), "Alpha beta gamma delta")

        let h2 = try harness()
        try h2.eval("""
            var t1 = __text('Alpha beta '); var t2 = __text('gamma delta');
            __setBody(\(passage), [t1, t2]);
            """)
        // Start inside the first child, end before the second.
        XCTAssertEqual(try h2.int("\(passage).__hlMark(t1, 6, \(passage), 1)"), 1)
        XCTAssertEqual(try h2.string("__markTexts()"), "beta")
    }

    func testAFormulaTouchedByTheSelectionIsWrappedWhole() throws {
        let h = try harness()
        try h.eval("""
            var k = document.createElement('span'); k.className = 'katex';
            var inner = document.createElement('span'); inner.className = 'mord';
            var kt = __text('πr2'); inner.appendChild(kt); k.appendChild(inner);
            var t1 = __text('Area is '); var t2 = __text(' square units.');
            __setBody(\(passage), [t1, k, t2]);
            """)
        // From "is" into the middle of the formula's own text.
        XCTAssertEqual(try h.int("\(passage).__hlMark(t1, 5, kt, 1)"), 2)
        XCTAssertEqual(try h.int("__marks().length"), 2)
        XCTAssertEqual(try h.string("__marks()[0].textContent"), "is")
        // One mark around the whole formula, nothing split inside it.
        XCTAssertTrue(try h.bool("k.parentNode === __marks()[1] && __marks()[1].childNodes.length === 1"))
        XCTAssertTrue(try h.bool("inner.childNodes.length === 1 && inner.childNodes[0] === kt && kt.textContent === 'πr2'"))
        XCTAssertEqual(try h.string("\(passage).textContent"), "Area is πr2 square units.")
    }

    func testAFormulaWhoseEndPointSitsJustBeforeItIsNotMarked() throws {
        let h = try harness()
        try h.eval("""
            var k = document.createElement('span'); k.__tex = 'x^2'; k.appendChild(__text('x2'));
            var t1 = __text('Area is '); __setBody(\(passage), [t1, k]);
            """)
        XCTAssertEqual(try h.int("\(passage).__hlMark(t1, 0, \(passage), 1)"), 1)
        XCTAssertEqual(try h.string("__markTexts()"), "Area is")
        XCTAssertTrue(try h.bool("k.parentNode === \(passage)"))
    }

    func testAlreadyMarkedTextIsNotMarkedTwice() throws {
        let h = try harness()
        try h.eval("var t = __text('one two three'); __setBody(\(passage), [t]);")
        XCTAssertEqual(try h.int("\(passage).__hlMark(t, 4, t, 7)"), 1)
        try h.eval("var kids = \(passage).childNodes; var a = kids[0], c = kids[2];")
        XCTAssertEqual(try h.int("\(passage).__hlMark(a, 0, c, 6)"), 2)
        XCTAssertEqual(try h.string("__markTexts()"), "one|two|three")
        XCTAssertFalse(try h.bool("__marks().some(function (m) { return __marks(m).length > 1; })"))
    }

    // MARK: - Removing

    func testClickingAMarkRemovesItAndNormalizesTheText() throws {
        let h = try harness()
        try h.eval("var t = __text('The cell membrane controls entry.'); __setBody(\(passage), [t]);")
        try h.eval("\(passage).__hlMark(t, 4, t, 8);")
        XCTAssertEqual(try h.int("__marks().length"), 1)
        try h.eval("\(passage).onclick({ target: __marks()[0] })")
        XCTAssertEqual(try h.int("__marks().length"), 0)
        XCTAssertEqual(try h.string("\(passage).textContent"), "The cell membrane controls entry.")
        XCTAssertEqual(try h.int("\(passage).childNodes.length"), 1)
        XCTAssertEqual(try h.int("\(passage).childNodes[0].nodeType"), 3)
        // The last mark gone, so is "Clear highlights".
        XCTAssertEqual(try h.int("__count('.st-mark-clear')"), 0)
    }

    func testAClickThatEndsASelectionRemovesNothing() throws {
        let h = try harness()
        try h.eval("var t = __text('The cell membrane.'); __setBody(\(passage), [t]); \(passage).__hlMark(t, 4, t, 8);")
        try h.eval("__sel = { startContainer: t, startOffset: 0, endContainer: t, endOffset: 1 };")
        try h.eval("\(passage).onclick({ target: __marks()[0] })")
        XCTAssertEqual(try h.int("__marks().length"), 1)
    }

    func testClearHighlightsRemovesEveryMarkOfThatPassage() throws {
        let h = try harness()
        try h.eval("""
            var s = 'One two.\\n\\nThree four.'; var t = __text(s); __setBody(\(passage), [t]);
            \(passage).__hlMark(t, 0, t, s.length);
            var src = __first('.source-body'); var st = src.childNodes[0];
            src.__hlMark(st, 0, st, 5);
            """)
        XCTAssertEqual(try h.int("__marks().length"), 3)
        XCTAssertEqual(try h.int("__count('.st-mark-clear')"), 2)
        let clear = "\(passage).__hlClear"
        XCTAssertEqual(try h.string("\(clear).textContent"), "Clear highlights")
        XCTAssertEqual(try h.string("\(clear).type"), "button")
        // Just above the passage it clears.
        XCTAssertTrue(try h.bool("\(clear).nextSibling === \(passage)"))
        try h.eval("\(clear).onclick()")
        XCTAssertEqual(try h.int("__marks(\(passage)).length"), 0)
        XCTAssertEqual(try h.string("\(passage).textContent"), "One two.\n\nThree four.")
        XCTAssertEqual(try h.int("\(passage).childNodes.length"), 1)
        // The source keeps its own mark and its own Clear.
        XCTAssertEqual(try h.int("__marks(src).length"), 1)
        XCTAssertEqual(try h.int("__count('.st-mark-clear')"), 1)
    }

    // MARK: - The Highlight button

    func testASelectionInsideOnePassageShowsTheButtonAndPressingItMarks() throws {
        let h = try harness()
        try h.eval("var t = \(passage).childNodes[0]; __select(t, 5, t, 8, 'the');")
        let button = "__first('.st-highlight-button', document.body)"
        XCTAssertEqual(try h.string("\(button).tagName"), "button")
        XCTAssertEqual(try h.string("\(button).type"), "button")
        XCTAssertEqual(try h.string("\(button).textContent"), "Highlight")
        XCTAssertNil(try h.string("\(button).getAttribute('hidden')"))
        // Under the selection.
        XCTAssertEqual(try h.string("\(button).style.left"), "40px")
        XCTAssertEqual(try h.string("\(button).style.top"), "126px")
        try h.eval("\(button).onclick()")
        XCTAssertEqual(try h.string("__markTexts()"), "the")
        XCTAssertEqual(try h.string("\(button).getAttribute('hidden')"), "")
        XCTAssertTrue(try h.bool("__sel === null"))
        XCTAssertEqual(try h.string("\(passage).textContent"), "Read the passage.")
    }

    func testASelectionOutsideOrAcrossPassagesShowsNothing() throws {
        let h = try harness()
        let button = "__first('.st-highlight-button', document.body)"
        // Across the introduction and a source.
        try h.eval("""
            var t = \(passage).childNodes[0]; var s = __first('.source-body').childNodes[0];
            __select(t, 0, s, 3, 'Read the passage. Alp');
            """)
        XCTAssertTrue(try h.bool("\(button) === null || \(button).getAttribute('hidden') === ''"))
        // A stem.
        try h.eval("var stem = __first('.stem'); __select(stem, 0, stem, 1, 'A');")
        XCTAssertTrue(try h.bool("\(button) === null || \(button).getAttribute('hidden') === ''"))
        // A good selection, then one outside: the button goes.
        try h.eval("__select(t, 5, t, 8, 'the');")
        XCTAssertNil(try h.string("\(button).getAttribute('hidden')"))
        try h.eval("__select(stem, 0, stem, 1, 'A');")
        XCTAssertEqual(try h.string("\(button).getAttribute('hidden')"), "")
        // A collapsed selection hides it too.
        try h.eval("__select(t, 5, t, 8, 'the'); __sel = null; __fire('selectionchange');")
        XCTAssertEqual(try h.string("\(button).getAttribute('hidden')"), "")
        XCTAssertEqual(try h.int("__marks().length"), 0)
    }

    // MARK: - Paging (spike item 4)

    /// An own_page passage travels between pages as one element, so its
    /// marks and its Clear button come along on every page turn.
    func testMarksSurvivePageTurnsOnAnOwnPagePassage() throws {
        var json = Self.bundle
            .replacingOccurrences(of: #""layout": "inline""#, with: #""layout": "own_page""#)
            .replacingOccurrences(of: #""item_ids": ["q2"]"#, with: #""item_ids": ["q1", "q2"]"#)
        json = json.replacingOccurrences(
            of: #""test_id": "hl","#, with: #""allow_highlighting": true, "layout": "paged", "test_id": "hl","#)
        let h = try RendererHarness(bundleJSON: json, prelude: Self.selectionPrelude)
        try h.eval("var body = __first('.stimulus-body'); var t = body.childNodes[0]; body.__hlMark(t, 5, t, 8);")
        for _ in 0..<3 {
            try h.eval("__first('.pager-next').onclick()")
            XCTAssertTrue(try h.bool("__first('.stimulus-body') === body"))
            XCTAssertEqual(try h.string("__markTexts(body)"), "the")
            XCTAssertTrue(try h.bool("body.__hlClear && body.__hlClear.nextSibling === body"))
        }
        try h.eval("__first('.pager-prev').onclick(); __first('.pager-prev').onclick();")
        XCTAssertEqual(try h.string("__markTexts(body)"), "the")
    }

    // MARK: - Nothing leaves the page

    func testMarkingRemovingAndClearingPostNothing() throws {
        let h = try harness()
        try h.eval("""
            var t = \(passage).childNodes[0]; __select(t, 0, t, 4, 'Read');
            __first('.st-highlight-button', document.body).onclick();
            \(passage).onclick({ target: __marks()[0] });
            var t2 = \(passage).childNodes[0]; \(passage).__hlMark(t2, 0, t2, 4);
            \(passage).__hlClear.onclick();
            """)
        XCTAssertTrue(try h.postedMessages().isEmpty)
        XCTAssertTrue(try h.postedUploads().isEmpty)
        XCTAssertTrue(try h.postedSubmits().isEmpty)
        XCTAssertTrue(try h.postedWithdrawals().isEmpty)
        XCTAssertTrue(try h.postedTimerDismissals().isEmpty)
        XCTAssertTrue(try h.postedSpeech().isEmpty)
        XCTAssertTrue(try h.postedDictation().isEmpty)
    }

    // MARK: - Read-aloud over marks

    /// Marks split the passage's text node; the read-aloud walks text nodes
    /// recursively, so the passage is still read whole and in order, each
    /// piece pointing at the node it came from.
    func testReadAloudReadsAMarkedPassageWhole() throws {
        let h = try harness(tts: true)
        try h.eval("var t = \(passage).childNodes[0]; \(passage).__hlMark(t, 5, t, 8);")
        try h.eval("__all('.tts-play')[0].onclick()")
        let speech = try h.postedSpeech()
        XCTAssertEqual(speech.count, 1)
        let segments = try XCTUnwrap(speech[0]["segments"] as? [[String: Any]])
        XCTAssertEqual(segments.compactMap { $0["text"] as? String }, ["Read ", "the", " passage."])
    }

    // MARK: - Colours

    /// Every contrast set, and the default page, defines the mark pair, and
    /// each pair carries its text at 4.5:1 or better.
    func testEveryContrastSetDefinesAMarkPairAtAA() throws {
        let css = AssessmentPage.itemStyles
        var selectors = [":root"]
        selectors += PageAccommodations.contrastSets.map {
            "html[\(PageAccommodations.contrastAttribute)=\"\($0.value)\"]"
        }
        for selector in selectors {
            let rule = try XCTUnwrap(
                css.components(separatedBy: "\n").first {
                    $0.hasPrefix("\(selector) {") && $0.contains("--mark-paper")
                },
                "no mark pair for \(selector)")
            let paper = try XCTUnwrap(Self.hex(after: "--mark-paper:", in: rule), selector)
            let ink = try XCTUnwrap(Self.hex(after: "--mark-ink:", in: rule), selector)
            XCTAssertGreaterThanOrEqual(Self.ratio(paper, ink), 4.5, "\(selector): \(ink) on \(paper)")
        }
        XCTAssertTrue(css.contains("mark.st-mark { background: var(--mark-paper); color: var(--mark-ink);"))
        XCTAssertTrue(css.contains(".st-highlightable { -webkit-user-select: text; user-select: text; }"))
    }

    private static func hex(after key: String, in rule: String) -> String? {
        guard let range = rule.range(of: key) else { return nil }
        let rest = rule[range.upperBound...].trimmingCharacters(in: .whitespaces)
        guard rest.hasPrefix("#") else { return nil }
        return String(rest.prefix(7))
    }

    private static func luminance(_ hex: String) -> Double {
        let value = Int(hex.dropFirst(), radix: 16) ?? 0
        let channels = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff].map { c -> Double in
            let v = Double(c) / 255
            return v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
    }

    private static func ratio(_ a: String, _ b: String) -> Double {
        let x = luminance(a), y = luminance(b)
        return (max(x, y) + 0.05) / (min(x, y) + 0.05)
    }

    /// James, 2026-10-14: a mark shows without relying on colour.
    func testMarksAreUnderlined() {
        XCTAssertTrue(AssessmentPage.itemStyles.contains("mark.st-mark { background: var(--mark-paper); color: var(--mark-ink); cursor: pointer; border-radius: 2px; text-decoration: underline;"))
    }

}
