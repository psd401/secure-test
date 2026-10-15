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
    function __select(sn, so, en, eo, text, rect) {
      var box = rect || { left: 40, top: 100, bottom: 120, right: 90 };
      __sel = {
        startContainer: sn, startOffset: so, endContainer: en, endOffset: eo, text: text,
        getBoundingClientRect: function () { return box; }
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
    // Slice 3: a keydown on `el` as WebKit would deliver it; the event comes
    // back so a test can see whether the page claimed it.
    function __key(el, key, extra) {
      var ev = {
        key: key, prevented: false, stopped: false,
        preventDefault: function () { this.prevented = true; },
        stopPropagation: function () { this.stopped = true; }
      };
      if (extra) for (var k in extra) ev[k] = extra[k];
      if (typeof el.onkeydown === 'function') el.onkeydown(ev);
      return ev;
    }
    // H-3: the Clear buttons a student can see and press.
    function __clears() {
      return __all('.st-mark-clear').filter(function (c) { return !c.disabled; });
    }
    function __live() {
      var live = __first('.st-hl-live', document.body);
      return live ? live.textContent : null;
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
        // The last mark gone, "Clear highlights" is disabled and hidden again.
        XCTAssertEqual(try h.int("__clears().length"), 0)
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
        XCTAssertEqual(try h.int("__clears().length"), 2)
        let clear = "\(passage).__hlClear"
        XCTAssertEqual(try h.string("\(clear).textContent"), "Clear highlights")
        XCTAssertEqual(try h.string("\(clear).type"), "button")
        // H-3: in the row above the passage, beside its Highlight mode toggle.
        XCTAssertTrue(try h.bool("\(clear).parentNode === \(passage).__hlRow && \(passage).__hlRow.nextSibling === \(passage)"))
        try h.eval("\(clear).onclick()")
        XCTAssertEqual(try h.int("__marks(\(passage)).length"), 0)
        XCTAssertEqual(try h.string("\(passage).textContent"), "One two.\n\nThree four.")
        XCTAssertEqual(try h.int("\(passage).childNodes.length"), 1)
        // The source keeps its own mark and its own Clear.
        XCTAssertEqual(try h.int("__marks(src).length"), 1)
        XCTAssertEqual(try h.int("__clears().length"), 1)
        XCTAssertTrue(try h.bool("__clears()[0] === src.__hlClear"))
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
        // H-5: above the selection — 100 (its top) - 6 - 30 (the height).
        XCTAssertEqual(try h.string("\(button).style.left"), "40px")
        XCTAssertEqual(try h.string("\(button).style.top"), "64px")
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
            XCTAssertTrue(try h.bool("body.__hlClear && body.__hlClear.parentNode === body.__hlRow && body.__hlRow.nextSibling === body"))
            XCTAssertFalse(try h.bool("body.__hlClear.disabled"))
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

    // MARK: - Slice 3: the sentence cursor

    private let toggle = "__first('.stimulus-body').__hlToggle"

    func testFlagOffHasNoHighlightModeToggle() throws {
        for flag in [nil, "false"] {
            let h = try harness(flag: flag)
            XCTAssertEqual(try h.int("__count('.st-hl-toggle')"), 0)
            XCTAssertEqual(try h.string("typeof \(passage).onkeydown"), "undefined")
            XCTAssertEqual(try h.string("typeof \(passage).onblur"), "undefined")
            XCTAssertNil(try h.string("\(passage).getAttribute('tabindex')"))
            XCTAssertNil(try h.string("__live()"))
        }
    }

    func testEachPassageHasAHighlightModeToggleAbove() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('.st-hl-toggle')"), 3)
        XCTAssertTrue(try h.bool("""
            __all('.st-highlightable').every(function (body) {
              var t = body.__hlToggle;
              return t && t.tagName === 'button' && t.type === 'button' &&
                t.textContent === 'Highlight mode' && t.getAttribute('tabindex') === '0' &&
                t.getAttribute('aria-pressed') === 'false' &&
                t.parentNode === body.__hlRow && t.parentNode.className === 'st-hl-row' &&
                t.parentNode.nextSibling === body;
            })
            """))
        // Not in the mode: the passage itself is not a Tab stop.
        XCTAssertNil(try h.string("\(passage).getAttribute('tabindex')"))
    }

    func testAPassageWithNoTextGetsNoToggle() throws {
        let json = Self.bundle
            .replacingOccurrences(of: #""stimulus": "Read the passage.""#, with: #""stimulus": """#)
            .replacingOccurrences(of: #""test_id": "hl","#, with: #""allow_highlighting": true, "test_id": "hl","#)
        let h = try RendererHarness(bundleJSON: json, prelude: Self.selectionPrelude)
        XCTAssertEqual(try h.int("__count('.st-hl-toggle')"), 2)
    }

    private func sentences(_ h: RendererHarness, _ setup: String) throws -> String? {
        try h.eval(setup)
        return try h.string("\(passage).__hlSentences().join('|')")
    }

    func testSentenceSplitting() throws {
        let h = try harness()
        XCTAssertEqual(try sentences(h, "__setBody(\(passage), [__text('One. Two! Three? Four')])"),
                       "One.|Two!|Three?|Four")
        // A decimal is not an end; nor is a short abbreviation.
        XCTAssertEqual(try sentences(h, "__setBody(\(passage), [__text('It costs 3.5 dollars. Mr. Lee paid. Done.')])"),
                       "It costs 3.5 dollars.|Mr. Lee paid.|Done.")
        // A blank line ends a sentence, with or without punctuation; a single
        // line break does not.
        XCTAssertEqual(try sentences(h, "__setBody(\(passage), [__text('A heading\\n\\nFirst line\\nsame sentence. Last')])"),
                       "A heading|First line\nsame sentence.|Last")
        // Closing quotes and repeated marks stay with their sentence.
        XCTAssertEqual(try sentences(h, "__setBody(\(passage), [__text('He said \"Stop.\" Then?! he left.')])"),
                       "He said \"Stop.\"|Then?!|he left.")
        // Across several text nodes.
        XCTAssertEqual(try sentences(h, "__setBody(\(passage), [__text('Alpha be'), __text('ta. Gamma.')])"),
                       "Alpha beta.|Gamma.")
    }

    func testAFormulaStaysInsideItsSentence() throws {
        let h = try harness()
        XCTAssertEqual(try sentences(h, """
            var k = document.createElement('span'); k.className = 'katex';
            var kt = __text('3.5 + x. y'); k.appendChild(kt);
            __setBody(\(passage), [__text('Area is '), k, __text('. Next one.')]);
            """), "Area is 3.5 + x. y.|Next one.")
    }

    private func modeHarness(_ text: String = "First one here. Second one!\\n\\nThird one?") throws -> RendererHarness {
        let h = try harness()
        try h.eval("var s = '\(text)'; __setBody(\(passage), [__text(s)]); \(toggle).onclick();")
        return h
    }

    func testEnteringTheModeFocusesTheFirstSentence() throws {
        let h = try modeHarness()
        XCTAssertTrue(try h.bool("document.activeElement === \(passage)"))
        XCTAssertEqual(try h.string("\(toggle).getAttribute('aria-pressed')"), "true")
        XCTAssertEqual(try h.string("\(passage).getAttribute('tabindex')"), "-1")
        XCTAssertEqual(try h.string("\(passage).getAttribute('role')"), "application")
        XCTAssertTrue(try h.bool("/ st-hl-mode/.test(\(passage).className)"))
        XCTAssertEqual(try h.string("\(passage).__hlCurrent()"), "First one here.")
        XCTAssertEqual(try h.string("__live()"),
                       "Highlight mode. Arrow keys move by sentence, Space highlights, Escape leaves. First one here.")
    }

    func testArrowsHomeAndEndMoveBySentence() throws {
        let h = try modeHarness()
        let current = "\(passage).__hlCurrent()"
        for (key, expected) in [("ArrowDown", "Second one!"), ("ArrowRight", "Third one?"),
                                ("ArrowDown", "Third one?"), ("ArrowUp", "Second one!"),
                                ("ArrowLeft", "First one here."), ("ArrowUp", "First one here."),
                                ("End", "Third one?"), ("Home", "First one here.")] {
            let ev = "__key(\(passage), '\(key)')"
            XCTAssertTrue(try h.bool("var e = \(ev); e.prevented && e.stopped"), key)
            XCTAssertEqual(try h.string(current), expected, key)
            XCTAssertEqual(try h.string("__live()"), expected, key)
        }
        XCTAssertEqual(try h.int("__marks().length"), 0)
    }

    func testSpaceMarksExactlyTheSentenceAndSpaceAgainRemovesIt() throws {
        let h = try modeHarness()
        try h.eval("__key(\(passage), 'ArrowDown')")
        XCTAssertTrue(try h.bool("var e = __key(\(passage), ' '); e.prevented && e.stopped"))
        XCTAssertEqual(try h.string("__markTexts()"), "Second one!")
        XCTAssertEqual(try h.string("__marks()[0].className"), "st-mark")
        XCTAssertEqual(try h.string("__live()"), "Highlighted")
        XCTAssertEqual(try h.string("\(passage).textContent"), "First one here. Second one!\n\nThird one?")
        // Moving away and back: the state is heard.
        try h.eval("__key(\(passage), 'ArrowDown'); __key(\(passage), 'ArrowUp');")
        XCTAssertEqual(try h.string("__live()"), "Highlighted: Second one!")
        // Enter does what Space does.
        try h.eval("__key(\(passage), 'Enter')")
        XCTAssertEqual(try h.int("__marks().length"), 0)
        XCTAssertEqual(try h.string("__live()"), "Highlight removed")
        XCTAssertEqual(try h.string("\(passage).textContent"), "First one here. Second one!\n\nThird one?")
        XCTAssertEqual(try h.int("\(passage).childNodes.length"), 1)
        XCTAssertEqual(try h.int("__clears().length"), 0)
    }

    func testSpaceOnAPartlyMarkedSentenceMarksTheRestAndUnmarkingKeepsTheNeighbour() throws {
        let h = try harness()
        try h.eval("""
            var s = 'One two. Three four.'; var t = __text(s); __setBody(\(passage), [t]);
            \(passage).__hlMark(t, s.indexOf('two'), t, s.indexOf(' four'));
            \(toggle).onclick(); __key(\(passage), 'ArrowDown');
            """)
        XCTAssertEqual(try h.string("__markTexts()"), "two. Three")
        XCTAssertEqual(try h.string("__live()"), "Partly highlighted: Three four.")
        try h.eval("__key(\(passage), ' ')")
        XCTAssertEqual(try h.string("__markTexts()"), "two. Three|four.")
        XCTAssertEqual(try h.string("__live()"), "Highlighted")
        try h.eval("__key(\(passage), ' ')")
        // Only the first sentence's part of the mouse mark is left.
        XCTAssertEqual(try h.string("__markTexts()"), "two.")
        XCTAssertEqual(try h.string("__live()"), "Highlight removed")
        XCTAssertEqual(try h.string("\(passage).textContent"), "One two. Three four.")
    }

    func testSpaceMarksAFormulaWholeInsideItsSentence() throws {
        let h = try harness()
        try h.eval("""
            var k = document.createElement('span'); k.className = 'katex';
            var kt = __text('πr2'); k.appendChild(kt);
            __setBody(\(passage), [__text('Area is '), k, __text(' units. Next.')]);
            \(toggle).onclick(); __key(\(passage), ' ');
            """)
        XCTAssertEqual(try h.string("__markTexts()"), "Area is|πr2|units.")
        XCTAssertTrue(try h.bool("k.parentNode.className === 'st-mark' && kt.parentNode === k"))
        XCTAssertEqual(try h.string("__live()"), "Highlighted")
        try h.eval("__key(\(passage), ' ')")
        XCTAssertEqual(try h.int("__marks().length"), 0)
        XCTAssertEqual(try h.string("\(passage).textContent"), "Area is πr2 units. Next.")
    }

    func testEscapeLeavesTheModeAndReturnsToTheToggle() throws {
        let h = try modeHarness()
        XCTAssertTrue(try h.bool("var e = __key(\(passage), 'Escape'); e.prevented && e.stopped"))
        XCTAssertTrue(try h.bool("document.activeElement === \(toggle)"))
        XCTAssertEqual(try h.string("\(toggle).getAttribute('aria-pressed')"), "false")
        XCTAssertNil(try h.string("\(passage).getAttribute('tabindex')"))
        XCTAssertNil(try h.string("\(passage).getAttribute('role')"))
        XCTAssertFalse(try h.bool("/st-hl-mode/.test(\(passage).className)"))
        XCTAssertNil(try h.string("\(passage).__hlCurrent()"))
        XCTAssertEqual(try h.string("__live()"), "")
        // Out of the mode the keys are the page's again.
        XCTAssertFalse(try h.bool("var e = __key(\(passage), ' '); e.prevented || e.stopped"))
        XCTAssertEqual(try h.int("__marks().length"), 0)
    }

    func testLosingFocusOrPressingTheToggleAgainLeavesTheMode() throws {
        let h = try modeHarness()
        try h.eval("\(passage).onblur()")
        XCTAssertEqual(try h.string("\(toggle).getAttribute('aria-pressed')"), "false")
        XCTAssertNil(try h.string("\(passage).getAttribute('tabindex')"))
        try h.eval("\(toggle).onclick()")
        XCTAssertEqual(try h.string("\(toggle).getAttribute('aria-pressed')"), "true")
        try h.eval("\(toggle).onclick()")
        XCTAssertEqual(try h.string("\(toggle).getAttribute('aria-pressed')"), "false")
    }

    /// One passage in the mode at a time.
    func testEnteringAnotherPassageLeavesTheFirst() throws {
        let h = try modeHarness()
        try h.eval("var src = __first('.source-body'); src.__hlToggle.onclick();")
        XCTAssertEqual(try h.string("\(toggle).getAttribute('aria-pressed')"), "false")
        XCTAssertEqual(try h.string("src.__hlToggle.getAttribute('aria-pressed')"), "true")
        XCTAssertEqual(try h.string("src.__hlCurrent()"), "Alpha text.")
    }

    func testKeysTheModeDoesNotUsePassThrough() throws {
        let h = try harness()
        // Outside the mode, nothing is claimed.
        for key in ["ArrowDown", "ArrowUp", "Home", "End", " ", "Enter", "Escape"] {
            XCTAssertFalse(try h.bool("var e = __key(\(passage), '\(key)'); e.prevented || e.stopped"), key)
        }
        try h.eval("\(toggle).onclick()")
        // In the mode: other keys, and chords, are left alone.
        for key in ["a", "Tab", "PageDown"] {
            XCTAssertFalse(try h.bool("var e = __key(\(passage), '\(key)'); e.prevented || e.stopped"), key)
        }
        XCTAssertFalse(try h.bool("var e = __key(\(passage), 'ArrowDown', { metaKey: true }); e.prevented || e.stopped"))
        XCTAssertEqual(try h.int("__marks().length"), 0)
    }

    func testALongSentenceIsCutInTheAnnouncementOnly() throws {
        let h = try harness()
        try h.eval("""
            var long = ''; for (var i = 0; i < 80; i++) long += 'word ';
            __setBody(\(passage), [__text(long + 'end.')]); \(toggle).onclick();
            __key(\(passage), 'Home');
            """)
        XCTAssertLessThanOrEqual(try h.int("__live().length"), 300)
        XCTAssertTrue(try h.bool("/\\u2026$/.test(__live())"))
        XCTAssertEqual(try h.int("\(passage).__hlCurrent().length"), 404)
    }

    func testKeyboardMarkingPostsNothing() throws {
        let h = try modeHarness()
        try h.eval("""
            __key(\(passage), ' '); __key(\(passage), 'ArrowDown'); __key(\(passage), 'Enter');
            __key(\(passage), ' '); __key(\(passage), 'Escape');
            """)
        XCTAssertTrue(try h.postedMessages().isEmpty)
        XCTAssertTrue(try h.postedUploads().isEmpty)
        XCTAssertTrue(try h.postedSubmits().isEmpty)
        XCTAssertTrue(try h.postedWithdrawals().isEmpty)
        XCTAssertTrue(try h.postedSpeech().isEmpty)
    }

    func testHighlightModeStylesUseThePageTokens() {
        let css = AssessmentPage.itemStyles
        XCTAssertTrue(css.contains(".st-sentence-box { position: absolute; outline: 3px solid var(--accent);"))
        XCTAssertTrue(css.contains(".st-hl-toggle:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }"))
    }

    /// James, 2026-10-14: a mark shows without relying on colour. H-4: the
    /// underline is an inset shadow, so it runs under an inline-block formula
    /// too, and every line fragment of a mark gets its own.
    func testMarksAreUnderlined() throws {
        let css = AssessmentPage.itemStyles
        let rule = try XCTUnwrap(css.components(separatedBy: "\n").first { $0.contains("mark.st-mark {") })
        XCTAssertEqual(rule.trimmingCharacters(in: .whitespaces),
                       "mark.st-mark { background: var(--mark-paper); color: var(--mark-ink); cursor: pointer; border-radius: 2px; box-shadow: inset 0 -2px 0 var(--mark-ink); -webkit-box-decoration-break: clone; box-decoration-break: clone; }")
        XCTAssertFalse(rule.contains("text-decoration"))
    }

    // MARK: - Hand-run readings H-2, H-3, H-5

    /// H-3: the control row exists before any mark, with Clear in it but
    /// disabled and hidden from AT; the first mark enables it in place and the
    /// last removal disables it again — the row is never added or removed, so
    /// the passage text does not move.
    func testClearLivesInTheToggleRowBeforeAnyMark() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('.st-hl-row')"), 3)
        XCTAssertEqual(try h.int("__count('.st-mark-clear')"), 3)
        try h.eval("var row = \(passage).__hlRow; var clear = \(passage).__hlClear; var block = \(passage).parentNode;")
        XCTAssertTrue(try h.bool("""
            row.childNodes.length === 2 && row.childNodes[0] === \(passage).__hlToggle &&
            row.childNodes[1] === clear && row.nextSibling === \(passage)
            """))
        XCTAssertTrue(try h.bool("clear.disabled === true"))
        XCTAssertEqual(try h.string("clear.getAttribute('aria-hidden')"), "true")
        XCTAssertEqual(try h.string("clear.getAttribute('disabled')"), "")
        try h.eval("var kidsBefore = block.childNodes.length; var t = \(passage).childNodes[0]; \(passage).__hlMark(t, 5, t, 8);")
        XCTAssertTrue(try h.bool("clear.disabled === false && \(passage).__hlClear === clear && \(passage).__hlRow === row"))
        XCTAssertNil(try h.string("clear.getAttribute('aria-hidden')"))
        XCTAssertNil(try h.string("clear.getAttribute('disabled')"))
        XCTAssertTrue(try h.bool("block.childNodes.length === kidsBefore && row.nextSibling === \(passage)"))
        try h.eval("clear.focus(); clear.onclick();")
        XCTAssertEqual(try h.int("__marks().length"), 0)
        XCTAssertTrue(try h.bool("clear.disabled === true && block.childNodes.length === kidsBefore"))
        XCTAssertEqual(try h.string("clear.getAttribute('aria-hidden')"), "true")
        // Focus does not fall to nowhere when the pressed Clear disables.
        XCTAssertTrue(try h.bool("document.activeElement === \(passage).__hlToggle"))
    }

    func testClearStylesKeepTheRowsHeight() {
        let css = AssessmentPage.itemStyles
        XCTAssertTrue(css.contains(".st-hl-row { display: flex;"))
        XCTAssertTrue(css.contains(".st-mark-clear:disabled { visibility: hidden; }"))
        XCTAssertFalse(css.contains("display: block; margin: 0 0 0.5rem; font: inherit;"))
    }

    /// H-2: a formula's taller rect joins the line it sits on, and each line
    /// is one box spanning every rect on it.
    func testLineBoxesGroupByOverlapAndSpanTheUnion() throws {
        let h = try harness()
        let boxes = "JSON.stringify(\(passage).__hlLineBoxes(rects))"
        // Line 1: text, a taller formula (top 95, bottom 125), text; line 2
        // below; an empty rect is ignored.
        try h.eval("""
            var rects = [
              { left: 10, right: 80, top: 100, bottom: 120 },
              { left: 80, right: 130, top: 95, bottom: 125 },
              { left: 130, right: 200, top: 100, bottom: 120 },
              { left: 50, right: 50, top: 100, bottom: 120 },
              { left: 10, right: 90, top: 130, bottom: 150 }
            ];
            """)
        XCTAssertEqual(try h.string(boxes),
            #"[{"left":10,"right":200,"top":95,"bottom":125},{"left":10,"right":90,"top":130,"bottom":150}]"#)
        // The formula first, and a formula that starts lower than the text.
        try h.eval("""
            rects = [
              { left: 80, right: 130, top: 104, bottom: 140 },
              { left: 10, right: 80, top: 100, bottom: 120 }
            ];
            """)
        XCTAssertEqual(try h.string(boxes), #"[{"left":10,"right":130,"top":100,"bottom":140}]"#)
        // Two lines that merely touch stay two lines.
        try h.eval("""
            rects = [
              { left: 10, right: 80, top: 100, bottom: 120 },
              { left: 10, right: 80, top: 119, bottom: 139 }
            ];
            """)
        XCTAssertEqual(try h.int("\(passage).__hlLineBoxes(rects).length"), 2)
        XCTAssertEqual(try h.string("JSON.stringify(\(passage).__hlLineBoxes([]))"), "[]")
    }

    /// H-2 through the real path: the sentence ring draws one box per line
    /// from a Range's client rects.
    func testSentenceRingDrawsOneBoxPerLine() throws {
        let h = try harness()
        try h.eval("""
            document.createRange = function () {
              return {
                setStart: function () {}, setEnd: function () {},
                setStartBefore: function () {}, setEndAfter: function () {},
                getClientRects: function () {
                  return [
                    { left: 10, right: 80, top: 100, bottom: 120 },
                    { left: 80, right: 130, top: 95, bottom: 125 },
                    { left: 10, right: 60, top: 130, bottom: 150 }
                  ];
                }
              };
            };
            \(passage).getBoundingClientRect = function () { return { left: 10, top: 90 }; };
            __setBody(\(passage), [__text('One sentence here.')]); \(toggle).onclick();
            """)
        let ring = "\(passage).__hlRing"
        XCTAssertEqual(try h.int("\(ring).childNodes.length"), 2)
        let first = "\(ring).childNodes[0].style"
        XCTAssertEqual(try h.string("[\(first).left, \(first).top, \(first).width, \(first).height].join(',')"),
                       "0px,5px,120px,30px")
    }

    /// H-5: above the selection when it fits, else under it; inside the
    /// viewport horizontally.
    func testHighlightButtonSpot() throws {
        let h = try harness()
        let spot = "JSON.stringify(\(passage).__hlButtonSpot"
        let size = "{ width: 100, height: 30 }"
        XCTAssertEqual(try h.string("\(spot)({ left: 40, top: 100, bottom: 160 }, { width: 1000 }, \(size)))"),
                       #"{"left":40,"top":64,"above":true}"#)
        // Too near the viewport's top: under the selection's last line.
        XCTAssertEqual(try h.string("\(spot)({ left: 40, top: 20, bottom: 80 }, { width: 1000 }, \(size)))"),
                       #"{"left":40,"top":86,"above":false}"#)
        // Exactly fitting stays above.
        XCTAssertEqual(try h.string("\(spot)({ left: 40, top: 36, bottom: 50 }, { width: 1000 }, \(size)))"),
                       #"{"left":40,"top":0,"above":true}"#)
        // Near the right edge: pulled in; never off the left.
        XCTAssertEqual(try h.string("\(spot)({ left: 950, top: 100, bottom: 120 }, { width: 1000 }, \(size)))"),
                       #"{"left":896,"top":64,"above":true}"#)
        XCTAssertEqual(try h.string("\(spot)({ left: 40, top: 100, bottom: 120 }, { width: 80 }, \(size)))"),
                       #"{"left":0,"top":64,"above":true}"#)
        // Through a real selection near the top of the viewport.
        try h.eval("var t = \(passage).childNodes[0]; __select(t, 5, t, 8, 'the', { left: 40, top: 10, bottom: 30, right: 90 });")
        let button = "__first('.st-highlight-button', document.body)"
        XCTAssertEqual(try h.string("\(button).style.top"), "36px")
        XCTAssertEqual(try h.string("\(button).style.left"), "40px")
    }

}
