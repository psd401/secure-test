import XCTest
@testable import SecureTestCore

/// RT slice 3 (docs/rich-text-essay-design.md): the formatted essay box and the
/// page's own undo in every text field (D-6).
///
/// The fixture's essay is item 3; the prelude turns `rich_text` on for it, as
/// the delivery route does when the teacher ticked the box (D-1).
///
/// JavaScriptCore has no editing engine: no `execCommand`, no Selection, no
/// contenteditable. So the prelude STUBS `document.execCommand` (recording each
/// call, and optionally mutating the box the way WebKit would) and a
/// `window.getSelection` the test points at a node. What this proves: the
/// wiring — which command a shortcut or button runs, that the box is read
/// through the server's rules, what is posted, undo / redo, paste and the
/// restore. What it cannot prove — that WebKit's bold really makes a `<b>`,
/// that the caret survives, that the chords reach the page under AAC, how
/// VoiceOver reads the toolbar — is the "Formatting in essays + undo (v1.6.0,
/// RT slice 3)" block of client/MANUAL-CHECKS.md.
final class RendererRichTextTests: XCTestCase {
    private static let essay = 3
    private static let shortText = 2
    private static let table = 8

    /// The autosave suite's virtual clock (and `Date.now` on it, so undo's
    /// one-second coalescing is driven by the same clock), plus the editing
    /// stubs described above.
    private static let prelude = #"""
    var __now = 0;
    var __virtual = [];
    var __virtualId = 0;
    function setTimeout(fn, ms) {
      __virtualId += 1;
      __virtual.push({ id: __virtualId, fn: fn, at: __now + (ms || 0) });
      return __virtualId;
    }
    function clearTimeout(id) {
      for (var i = 0; i < __virtual.length; i++) {
        if (__virtual[i].id === id) { __virtual.splice(i, 1); return; }
      }
    }
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    function __advance(ms) {
      var target = __now + ms;
      for (;;) {
        var due = null;
        for (var i = 0; i < __virtual.length; i++) {
          if (__virtual[i].at <= target && (due === null || __virtual[i].at < due.at)) due = __virtual[i];
        }
        if (due === null) break;
        __virtual.splice(__virtual.indexOf(due), 1);
        __now = due.at;
        due.fn();
      }
      __now = target;
    }
    Date.now = function () { return __now; };

    var __exec = [];
    var __execHook = null;
    document.execCommand = function (name, ui, value) {
      __exec.push([name, value === undefined ? null : value]);
      if (typeof __execHook === 'function') __execHook(name, value);
      return true;
    };
    var __range = null;
    window.getSelection = function () {
      return {
        rangeCount: __range ? 1 : 0,
        getRangeAt: function () { return __range; },
        removeAllRanges: function () { __range = null; },
        addRange: function (r) { __range = r; }
      };
    };
    document.createRange = function () {
      return {
        setStart: function (n, o) { this.startContainer = n; this.startOffset = o; },
        setEnd: function (n, o) { this.endContainer = n; this.endOffset = o; }
      };
    };
    function __select(a, ao, b, bo) {
      __range = { startContainer: a, startOffset: ao,
        endContainer: b === undefined ? a : b, endOffset: bo === undefined ? ao : bo };
    }
    function __key(el, init) {
      var e = init;
      e.prevented = false;
      e.preventDefault = function () { e.prevented = true; };
      el.onkeydown(e);
      return e.prevented;
    }
    function __box() { return __first('.essay-rich', __item(3)); }
    function __para(text) {
      var p = document.createElement('p');
      p.appendChild(document.createTextNode(text));
      return p;
    }
    // Replaces the box with one paragraph per string, then fires `input` —
    // what the student typing those paragraphs leaves behind.
    function __typeBox(paras, data) {
      var box = __box();
      while (box.firstChild) box.removeChild(box.firstChild);
      paras.forEach(function (t) { box.appendChild(__para(t)); });
      box.oninput({ type: 'input', data: data });
    }
    function __type(el, text, data) { el.value = text; el.oninput({ type: 'input', data: data }); }
    function __boxHTML(node) {
      return (node.childNodes || []).map(function (k) {
        if (k.nodeType === 3) return k.textContent;
        var attrs = k.getAttribute('data-indent') ? ' data-indent="' + k.getAttribute('data-indent') + '"' : '';
        return '<' + k.tagName + attrs + '>' + __boxHTML(k) + '<' + '/' + k.tagName + '>';
      }).join('');
    }
    BUNDLE.items[3].rich_text = true;
    """#

    private func harness(extra: String = "") throws -> RendererHarness {
        try RendererHarness(bundleJSON: try RendererHarness.fixtureJSON(), prelude: Self.prelude + extra)
    }

    private func essayID(_ h: RendererHarness) throws -> String {
        try XCTUnwrap(h.string("BUNDLE.items[\(Self.essay)].id"))
    }

    private func posts(_ h: RendererHarness, item: Int) throws -> [[String: Any]] {
        let id = try XCTUnwrap(h.string("BUNDLE.items[\(item)].id"))
        return try h.postedMessages().filter { ($0["item_id"] as? String) == id }
    }

    private func lastResponse(_ h: RendererHarness, item: Int = essay) throws -> [String: Any]? {
        try posts(h, item: item).last?["response"] as? [String: Any]
    }

    private func execNames(_ h: RendererHarness) throws -> [String] {
        try XCTUnwrap(h.string("__exec.map(function (c) { return c[0]; }).join(',')"))
            .split(separator: ",").map(String.init)
    }

    // MARK: - Core: the item flag and the response field

    func testTheEssayDecodesRichTextDefaultingToFalse() throws {
        let plain = try JSONDecoder().decode(
            DeliveryItem.self, from: Data(#"{"type":"essay","id":"e1","stem":"Why?"}"#.utf8)
        )
        guard case .essay(let p) = plain else { return XCTFail("not an essay") }
        XCTAssertFalse(p.richText)
        let rich = try JSONDecoder().decode(
            DeliveryItem.self, from: Data(#"{"type":"essay","id":"e1","stem":"Why?","rich_text":true}"#.utf8)
        )
        guard case .essay(let r) = rich else { return XCTFail("not an essay") }
        XCTAssertTrue(r.richText)
    }

    func testTheEssayResponseCarriesHtmlOnlyWhenPresent() throws {
        let plain = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(ItemResponse.essay(text: "Hi"))
        ) as? [String: Any]
        XCTAssertEqual(plain?["text"] as? String, "Hi")
        XCTAssertNil(plain?["html"], "nil is absent, not null")

        let rich = ItemResponse.essay(text: "Hi", html: "<p><strong>Hi</strong></p>")
        let round = try JSONDecoder().decode(ItemResponse.self, from: JSONEncoder().encode(rich))
        XCTAssertEqual(round, rich)

        let decoded = try ItemResponseMessage.decode(fromMessageBody: [
            "item_id": "e1",
            "response": ["type": "essay", "text": "Hi", "html": "<p>Hi</p>"],
        ])
        XCTAssertEqual(decoded.response, .essay(text: "Hi", html: "<p>Hi</p>"))
        XCTAssertEqual(
            try ItemResponseMessage.decode(fromMessageBody: [
                "item_id": "e1", "response": ["type": "essay", "text": "Hi"],
            ]).response,
            .essay(text: "Hi")
        )
    }

    // MARK: - The server's rules, ported (shared table with the design tool)

    /// The same [input, output] cases as `sanitizeEssayHtml` in
    /// design-tool/test/rich-text-essay-html.test.ts — the page posts what the
    /// server would keep.
    private static let sanitizeCases: [(String, String)] = [
        ("<p>a <strong>b</strong> <em>c</em> <u>d</u><br>e</p>", "<p>a <strong>b</strong> <em>c</em> <u>d</u><br>e</p>"),
        ("<p data-indent=\"first\">Para</p>", "<p data-indent=\"first\">Para</p>"),
        ("<ul><li>a</li></ul><ol><li>b</li></ol>", "<ul><li>a</li></ul><ol><li>b</li></ol>"),
        ("<p><b>x</b><i>y</i></p>", "<p><strong>x</strong><em>y</em></p>"),
        ("<div data-indent=\"first\">One</div><div>Two</div>", "<p data-indent=\"first\">One</p><p>Two</p>"),
        ("<h1>T</h1><blockquote>Q</blockquote>", "<p>T</p><p>Q</p>"),
        (
            "<p><span style=\"font-weight: 700\">B</span><span style=\"font-style:italic\">I</span><span style=\"text-decoration: underline\">U</span><span style=\"color:red\">plain</span></p>",
            "<p><strong>B</strong><em>I</em><u>U</u>plain</p>"
        ),
        (
            "<p class=\"x\" style=\"color:red\" onclick=\"evil()\" data-indent=\"block\"><strong title=\"t\">x</strong></p>",
            "<p><strong>x</strong></p>"
        ),
        ("<strong data-indent=\"first\">x</strong>", "<p><strong>x</strong></p>"),
        ("<p>a<script>alert(1)</script>b<style>p{color:red}</style>c</p>", "<p>abc</p>"),
        ("<p>keep<script>alert(", "<p>keep</p>"),
        ("<p>a<iframe src=\"x\">t</iframe><svg><text>s</text></svg><img src=x onerror=alert(1)><input value=\"v\">b</p>", "<p>ab</p>"),
        ("<p>a<SCRIPT>x</ScRiPt>b</p>", "<p>ab</p>"),
        ("<p><a href=\"javascript:x\">link</a> <mark>m</mark></p>", "<p>link m</p>"),
        ("<!doctype html><!-- c --><?xml x?><p>x</p>", "<p>x</p>"),
        ("hello <b>world</b><p>next</p>tail", "<p>hello <strong>world</strong></p><p>next</p><p>tail</p>"),
        ("<ul><li>a<ul><li>b</li><li>c</li></ul>d</li><li>e</li></ul>", "<ul><li>a</li><li>b</li><li>c</li><li>d</li><li>e</li></ul>"),
        ("<ul><li>a<ol><li>b</li></ol></li></ul>", "<ul><li>a</li><li>b</li></ul>"),
        ("<ul><li><p>a</p><p>b</p></li></ul>", "<ul><li>a<br>b</li></ul>"),
        ("<li>stray</li>", "<p>stray</p>"),
        ("<ul><li> </li></ul><ol><li>x</li><li></li></ol>", "<ol><li>x</li></ol>"),
        ("<ol>\n  <li>one</li>\n  <li>two</li>\n</ol>\n<p>x</p>\n", "<ol><li>one</li><li>two</li></ol><p>x</p>"),
        ("<div>One</div><div><br></div><div>Two</div>", "<p>One</p><p><br></p><p>Two</p>"),
        ("<p><br></p><p>x</p><p></p><p>  </p>", "<p>x</p>"),
        ("<p>3 &lt; 4 &amp;&amp; 5 &gt; 2 &#169; &#x41; &quot;q&quot; &apos;</p>", "<p>3 &lt; 4 &amp;&amp; 5 &gt; 2 © A \"q\" '</p>"),
        ("<p>&copy;</p>", "<p>&amp;copy;</p>"),
        ("<p>3 < 4</p>", "<p>3 &lt; 4</p>"),
        ("<p>a&nbsp;&nbsp;b</p>", "<p>a\u{00A0}\u{00A0}b</p>"),
        ("<b><i>x</i></b><i><b>y</b></i>", "<p><strong><em>xy</em></strong></p>"),
        ("<b><p>x</p></b>", "<p><strong>x</strong></p>"),
        ("<p>a<p>b", "<p>a</p><p>b</p>"),
        ("<p title=\"a>b\">x</p>", "<p>x</p>"),
        ("", ""),
        ("<script>x</script><img src=x>", ""),
        // RT-1 (the server's table): WebKit's list inside a paragraph.
        ("<p>Plain <b>bold</b></p><p><ul><li>first item</li></ul></p><p>after</p>",
         "<p>Plain <strong>bold</strong></p><ul><li>first item</li></ul><p>after</p>"),
        ("<p>x<ul><li>y</li></ul>z</p>", "<p>x</p><ul><li>y</li></ul><p>z</p>"),
        ("<p>a</p><p><br></p><p>b</p>", "<p>a</p><p><br></p><p>b</p>"),
    ]

    /// `essayTextFromHtml(sanitizeEssayHtml(html))` in the same file.
    private static let textCases: [(String, String)] = [
        ("<p>One</p><p>Two</p>", "One\nTwo"),
        ("<p>One</p><p><br></p><p>Two</p>", "One\n\nTwo"),
        ("<p>a<br>b<br></p><p>c<br><br></p>", "a\nb\nc"),
        ("<p><strong>Bold</strong> <em>it</em> <u>u</u></p>", "Bold it u"),
        ("<p data-indent=\"first\">Indented</p>", "Indented"),
        ("<ul><li>apple</li><li>pear</li></ul>", "\u{2022} apple\n\u{2022} pear"),
        ("<ol><li>a</li><li>b</li></ol><p>x</p><ol><li>c</li></ol>", "1. a\n2. b\nx\n1. c"),
        ("<ul><li>a<br>b</li></ul>", "\u{2022} a\nb"),
        ("<p>3 &lt; 4 &amp; R&amp;D &#169;</p>", "3 < 4 & R&D ©"),
        ("<p>a&nbsp;&nbsp;b</p>", "a  b"),
        ("<p>  a \n  b  </p>", "a b"),
        ("", ""),
        // RT-1: no blank line from WebKit's list-inside-a-paragraph wrapper;
        // a typed blank paragraph is still one.
        ("<p>Plain <b>bold</b></p><p><ul><li>first item</li></ul></p><p>after</p>",
         "Plain bold\n• first item\nafter"),
        ("<p>x<ul><li>y</li></ul>z</p>", "x\n• y\nz"),
        ("<p>a</p><p><br></p><p>b</p>", "a\n\nb"),
    ]

    /// The pure functions evaluated on their own, at the harness's top level.
    private func pure() throws -> RendererHarness {
        let h = try RendererHarness(bundleJSON: #"{"test_id":"t","title":"t","items":[]}"#)
        try h.eval(AssessmentPage.richTextFunctions)
        return h
    }

    private func js(_ s: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [s], options: [.fragmentsAllowed])
        let array = String(decoding: data, as: UTF8.self)
        return String(array.dropFirst().dropLast())
    }

    func testTheSanitiserMatchesTheServersTable() throws {
        let h = try pure()
        for (input, output) in Self.sanitizeCases {
            XCTAssertEqual(try h.string("richSanitize(\(js(input)))"), output, input)
            // Idempotent, as the server's is.
            XCTAssertEqual(try h.string("richSanitize(richSanitize(\(js(input))))"), output, input)
        }
        XCTAssertEqual(
            try h.string("richSanitize(new Array(5001).join('<b>') + 'deep' + new Array(5001).join('</' + 'b>'))"),
            "<p><strong>deep</strong></p>"
        )
    }

    func testTheTextRuleMatchesTheServersTable() throws {
        let h = try pure()
        for (html, text) in Self.textCases {
            XCTAssertEqual(try h.string("richTextFromHtml(richSanitize(\(js(html))))"), text, html)
        }
    }

    /// The live box is read through the same rules, from DOM rather than markup.
    func testTheDomReaderAgreesWithTheMarkupReader() throws {
        let h = try pure()
        let html = try h.string("""
        (function () {
          var box = document.createElement('div');
          var p = document.createElement('p');
          p.setAttribute('data-indent', 'first');
          var b = document.createElement('b');
          b.appendChild(document.createTextNode('Bold'));
          p.appendChild(b);
          p.appendChild(document.createTextNode(' and plain'));
          box.appendChild(p);
          var ul = document.createElement('ul');
          var li = document.createElement('li');
          li.appendChild(document.createTextNode('one'));
          var inner = document.createElement('ul');
          var li2 = document.createElement('li');
          li2.appendChild(document.createTextNode('two'));
          inner.appendChild(li2);
          li.appendChild(inner);
          ul.appendChild(li);
          box.appendChild(ul);
          return richSerialize(richBlocksFromDom(box));
        })()
        """)
        XCTAssertEqual(html, "<p data-indent=\"first\"><strong>Bold</strong> and plain</p><ul><li>one</li><li>two</li></ul>")
    }

    // MARK: - Rendering

    func testTheFormattedBoxAndItsToolbarReplaceTheTextarea() throws {
        let h = try harness()
        let item = "__item(\(Self.essay))"
        XCTAssertEqual(try h.int("__count('textarea', \(item))"), 0)
        XCTAssertEqual(try h.string("__box().getAttribute('contenteditable')"), "true")
        XCTAssertEqual(try h.string("__box().getAttribute('role')"), "textbox")
        XCTAssertEqual(try h.string("__box().getAttribute('aria-multiline')"), "true")
        XCTAssertEqual(try h.string("__box().getAttribute('aria-label')"), "Your answer")
        XCTAssertEqual(try h.string("__box().getAttribute('data-placeholder')"), "Write your response here…")
        XCTAssertEqual(try h.string("__first('.essay-toolbar', \(item)).getAttribute('role')"), "toolbar")
        XCTAssertEqual(
            try h.string("__all('button', __first('.essay-toolbar', \(item))).map(function (b) { return b.getAttribute('data-tool'); }).join(',')"),
            "bold,italic,underline,ul,ol,indent,undo,redo"
        )
        // Toggles announce a pressed state; Undo / Redo do not (D-6).
        XCTAssertEqual(
            try h.string("__all('button', __first('.essay-toolbar', \(item))).map(function (b) { return b.getAttribute('aria-pressed') || '-'; }).join(',')"),
            "false,false,false,false,false,false,-,-"
        )
        // One Tab stop for the strip (the keypad / drawing pattern).
        XCTAssertEqual(
            try h.string("__all('button', __first('.essay-toolbar', \(item))).map(function (b) { return b.getAttribute('tabindex'); }).join(',')"),
            "0,-1,-1,-1,-1,-1,-1,-1"
        )
        // Toolbar above the box, word count below.
        XCTAssertEqual(
            try h.string("__item(\(Self.essay)).children[1].children.map(function (n) { return n.className; }).slice(0, 3).join('|')"),
            "essay-toolbar|essay essay-rich|word-count"
        )
        XCTAssertEqual(try h.string("__first('.word-count', \(item)).textContent"), "0 / 400 words")
        // An empty box still holds one paragraph to type into.
        XCTAssertEqual(try h.string("__boxHTML(__box())"), "<p><br></br></p>")
        XCTAssertEqual(try h.string("__box().getAttribute('data-empty')"), "true")
        // WebKit's editing defaults for the page.
        XCTAssertTrue(try execNames(h).contains("defaultParagraphSeparator"))
        XCTAssertEqual(try h.string("__exec.filter(function (c) { return c[0] === 'defaultParagraphSeparator'; })[0][1]"), "p")
    }

    func testAPlainEssayIsUnchanged() throws {
        let h = try harness(extra: "BUNDLE.items[3].rich_text = false;")
        XCTAssertEqual(try h.int("__count('textarea', __item(3))"), 1)
        XCTAssertEqual(try h.int("__count('.essay-toolbar', __item(3))"), 0)
        XCTAssertEqual(try h.int("__count('.essay-rich')"), 0)
    }

    func testSpellCheckFollowsThePerStudentGrant() throws {
        let on = try harness()
        XCTAssertEqual(try on.string("__box().getAttribute('spellcheck')"), "true")
        let off = try harness(extra: "delete BUNDLE.accommodations.spell_check;")
        XCTAssertEqual(try off.string("__box().getAttribute('spellcheck')"), "false")
        XCTAssertFalse(try off.bool("__box().spellcheck"))
    }

    // MARK: - Posting

    func testTypingAutosavesHtmlAndDerivedText() throws {
        let h = try harness()
        try h.eval("""
        (function () {
          var box = __box();
          while (box.firstChild) box.removeChild(box.firstChild);
          var p = __para('The author ');
          var b = document.createElement('b');
          b.appendChild(document.createTextNode('argues'));
          p.appendChild(b);
          box.appendChild(p);
          var ul = document.createElement('ul');
          var li = document.createElement('li');
          li.appendChild(document.createTextNode('first point'));
          ul.appendChild(li);
          box.appendChild(ul);
          box.oninput({ type: 'input' });
        })()
        """)
        XCTAssertEqual(try posts(h, item: Self.essay).count, 0, "not while typing")
        try h.eval("__advance(5000);")
        let response = try XCTUnwrap(lastResponse(h))
        XCTAssertEqual(response["type"] as? String, "essay")
        XCTAssertEqual(response["html"] as? String, "<p>The author <strong>argues</strong></p><ul><li>first point</li></ul>")
        XCTAssertEqual(response["text"] as? String, "The author argues\n\u{2022} first point")
        // D-7: the counter reads the text, and a list marker is not a word.
        XCTAssertEqual(try h.string("__first('.word-count', __item(3)).textContent"), "5 / 400 words")
        XCTAssertEqual(try h.string("__box().getAttribute('data-empty')"), "false")
    }

    func testLeavingTheBoxPostsAtOnce() throws {
        let h = try harness()
        try h.eval("__typeBox(['Hello']);")
        try h.eval("__box().onblur({});")
        XCTAssertEqual(try lastResponse(h)?["html"] as? String, "<p>Hello</p>")
        // A second blur with nothing changed posts nothing more (AS-1 / D-4).
        try h.eval("__box().onblur({});")
        XCTAssertEqual(try posts(h, item: Self.essay).count, 1)
    }

    /// A formatting-only change is still a change: the autosave compares html.
    func testABoldOnlyChangeIsSaved() throws {
        let h = try harness(extra: """
        __execHook = function (name) {
          if (name !== 'bold') return;
          var p = __box().childNodes[0];
          var b = document.createElement('b');
          while (p.firstChild) b.appendChild(p.firstChild);
          p.appendChild(b);
        };
        """)
        try h.eval("__typeBox(['Hello']); __box().onblur({});")
        try h.eval("__select(__box().childNodes[0].childNodes[0], 0, __box().childNodes[0].childNodes[0], 5);")
        XCTAssertTrue(try h.bool("__key(__box(), { key: 'b', metaKey: true })"))
        try h.eval("__box().onblur({});")
        let posted = try posts(h, item: Self.essay)
        XCTAssertEqual(posted.count, 2)
        let last = posted.last?["response"] as? [String: Any]
        XCTAssertEqual(last?["html"] as? String, "<p><strong>Hello</strong></p>")
        XCTAssertEqual(last?["text"] as? String, "Hello")
    }

    func testAnEmptiedBoxPostsEmptyTextWithoutHtml() throws {
        let h = try harness()
        try h.eval("__typeBox(['Hello']); __box().onblur({});")
        try h.eval("__typeBox([]); __box().onblur({});")
        let last = try XCTUnwrap(lastResponse(h))
        XCTAssertEqual(last["text"] as? String, "")
        XCTAssertNil(last["html"])
    }

    // MARK: - Commands and shortcuts

    func testShortcutsRunWebKitsEditingCommands() throws {
        let h = try harness()
        try h.eval("__exec = [];")
        let cases: [(String, String)] = [
            ("{ key: 'b', metaKey: true }", "bold"),
            ("{ key: 'i', metaKey: true }", "italic"),
            ("{ key: 'u', metaKey: true }", "underline"),
            ("{ key: '*', code: 'Digit8', metaKey: true, shiftKey: true }", "insertUnorderedList"),
            ("{ key: '&', code: 'Digit7', metaKey: true, shiftKey: true }", "insertOrderedList"),
        ]
        for (event, command) in cases {
            try h.eval("__exec = [];")
            XCTAssertTrue(try h.bool("__key(__box(), \(event))"), event)
            XCTAssertEqual(try execNames(h), [command], event)
        }
    }

    /// D-5: Tab is never taken — it moves focus. Nor are chords that are not
    /// ours (Control-B, plain letters).
    func testTabAndOtherKeysAreLeftAlone() throws {
        let h = try harness()
        try h.eval("__exec = [];")
        XCTAssertFalse(try h.bool("__key(__box(), { key: 'Tab' })"))
        XCTAssertFalse(try h.bool("__key(__box(), { key: 'Tab', shiftKey: true })"))
        XCTAssertFalse(try h.bool("__key(__box(), { key: 'b', ctrlKey: true })"))
        XCTAssertFalse(try h.bool("__key(__box(), { key: 'b' })"))
        XCTAssertEqual(try h.string("__exec.length + ''"), "0")
    }

    func testToolbarButtonsRunTheSameCommandsAndKeepTheCaret() throws {
        let h = try harness()
        try h.eval("__exec = [];")
        let button = "__first('.essay-tool-italic', __item(3))"
        // A pointer press does not take focus out of the box (D-3.1's rule).
        try h.eval("var __e = { prevented: false, preventDefault: function () { this.prevented = true; } }; \(button).onpointerdown(__e);")
        XCTAssertTrue(try h.bool("__e.prevented"))
        try h.eval("\(button).onclick({});")
        XCTAssertEqual(try execNames(h), ["italic"])
    }

    func testIndentTogglesTheFirstLineOfTheSelectedParagraphs() throws {
        let h = try harness()
        try h.eval("__typeBox(['One', 'Two', 'Three']);")
        let p = { (n: Int) in "__box().childNodes[\(n)].getAttribute('data-indent')" }
        // Caret in the first paragraph: Cmd-] indents it alone (D-4).
        try h.eval("__select(__box().childNodes[0].childNodes[0], 1);")
        XCTAssertTrue(try h.bool("__key(__box(), { key: ']', metaKey: true })"))
        XCTAssertEqual(try h.string(p(0)), "first")
        XCTAssertNil(try h.string(p(1)))
        XCTAssertEqual(try h.string("__first('.essay-tool-indent', __item(3)).getAttribute('aria-pressed')"), "true")
        // A selection across two paragraphs: the button indents both, then
        // un-indents both (all already on → off).
        try h.eval("__select(__box().childNodes[1].childNodes[0], 0, __box().childNodes[2].childNodes[0], 2);")
        try h.eval("__first('.essay-tool-indent', __item(3)).onclick({});")
        XCTAssertEqual(try h.string(p(1)), "first")
        XCTAssertEqual(try h.string(p(2)), "first")
        try h.eval("__first('.essay-tool-indent', __item(3)).onclick({});")
        XCTAssertNil(try h.string(p(1)))
        XCTAssertNil(try h.string(p(2)))
        // Cmd-[ takes the first one off.
        try h.eval("__select(__box().childNodes[0].childNodes[0], 0);")
        XCTAssertTrue(try h.bool("__key(__box(), { key: '[', metaKey: true })"))
        XCTAssertNil(try h.string(p(0)))
        // And it is posted like any change.
        try h.eval("__box().onblur({});")
        XCTAssertEqual(try lastResponse(h)?["html"] as? String, "<p>One</p><p>Two</p><p>Three</p>")
    }

    /// D-9: if WebKit nests a list, the box is repaired to one level at once.
    func testANestedListIsFlattenedToOneLevel() throws {
        let h = try harness(extra: """
        __execHook = function (name) {
          if (name !== 'insertUnorderedList') return;
          var box = __box();
          while (box.firstChild) box.removeChild(box.firstChild);
          var ul = document.createElement('ul');
          var li = document.createElement('li');
          li.appendChild(document.createTextNode('a'));
          var inner = document.createElement('ul');
          var li2 = document.createElement('li');
          li2.appendChild(document.createTextNode('b'));
          inner.appendChild(li2);
          li.appendChild(inner);
          ul.appendChild(li);
          box.appendChild(ul);
        };
        """)
        try h.eval("__typeBox(['a']);")
        try h.eval("__select(__box().childNodes[0].childNodes[0], 0);")
        try h.eval("__first('.essay-tool-ul', __item(3)).onclick({});")
        XCTAssertEqual(try h.string("__boxHTML(__box())"), "<ul><li>a</li><li>b</li></ul>")
    }

    // MARK: - Paste

    func testPasteInsertsPlainTextOnlyWhenTheClipboardIsOpen() throws {
        let h = try harness(extra: "BUNDLE.allow_clipboard = true;")
        try h.eval("""
        __exec = [];
        var __asked = [];
        var __paste = { prevented: false, preventDefault: function () { this.prevented = true; },
          clipboardData: { getData: function (type) { __asked.push(type);
            return type === 'text/html' ? '<b>bold</b>' : 'one\\r\\ntwo'; } } };
        __box().onpaste(__paste);
        """)
        XCTAssertTrue(try h.bool("__paste.prevented"), "the browser's own paste never runs")
        XCTAssertEqual(try h.string("__asked.join(',')"), "text/plain", "html is never read")
        XCTAssertEqual(
            try h.string("__exec.map(function (c) { return c[0] + (c[1] ? ':' + c[1] : ''); }).join('|')"),
            "insertText:one|insertParagraph|insertText:two"
        )
    }

    func testPasteIsRefusedWhenTheClipboardIsLocked() throws {
        let h = try harness(extra: "BUNDLE.allow_clipboard = false;")
        try h.eval("""
        __exec = [];
        var __paste = { prevented: false, preventDefault: function () { this.prevented = true; },
          clipboardData: { getData: function () { return 'smuggled'; } } };
        __box().onpaste(__paste);
        """)
        XCTAssertTrue(try h.bool("__paste.prevented"))
        XCTAssertEqual(try h.string("__exec.length + ''"), "0")
    }

    // MARK: - Undo in the formatted box

    func testUndoAndRedoInTheBoxRestoreAndPost() throws {
        let h = try harness()
        try h.eval("__typeBox(['One']);")
        try h.eval("__advance(2000);")   // a pause: the next typing is a new step
        let afterPause = try posts(h, item: Self.essay).count
        try h.eval("__typeBox(['One two']);")
        XCTAssertTrue(try h.bool("__key(__box(), { key: 'z', metaKey: true })"))
        XCTAssertEqual(try h.string("__boxHTML(__box())"), "<p>One</p>")
        // Undo saves at once, through the same post.
        XCTAssertEqual(try posts(h, item: Self.essay).count, afterPause + 1)
        XCTAssertEqual(try lastResponse(h)?["html"] as? String, "<p>One</p>")
        XCTAssertTrue(try h.bool("__key(__box(), { key: 'z', metaKey: true, shiftKey: true })"))
        XCTAssertEqual(try h.string("__boxHTML(__box())"), "<p>One two</p>")
        XCTAssertEqual(try lastResponse(h)?["html"] as? String, "<p>One two</p>")
    }

    func testAFormattingCommandIsItsOwnUndoStep() throws {
        let h = try harness(extra: """
        __execHook = function (name) {
          if (name !== 'bold') return;
          var p = __box().childNodes[0];
          var b = document.createElement('b');
          while (p.firstChild) b.appendChild(p.firstChild);
          p.appendChild(b);
        };
        """)
        try h.eval("__typeBox(['Hello']);")
        try h.eval("__select(__box().childNodes[0].childNodes[0], 0, __box().childNodes[0].childNodes[0], 5);")
        try h.eval("__first('.essay-tool-bold', __item(3)).onclick({});")
        XCTAssertEqual(try h.string("__boxHTML(__box())"), "<p><b>Hello</b></p>")
        XCTAssertEqual(try h.string("__first('.essay-tool-undo', __item(3)).getAttribute('aria-disabled')"), "false")
        // The Undo BUTTON takes back the bold, not the typing.
        try h.eval("__first('.essay-tool-undo', __item(3)).onclick({});")
        XCTAssertEqual(try h.string("__boxHTML(__box())"), "<p>Hello</p>")
        XCTAssertEqual(try h.string("__first('.essay-tool-redo', __item(3)).getAttribute('aria-disabled')"), "false")
        try h.eval("__first('.essay-tool-undo', __item(3)).onclick({});")
        XCTAssertEqual(try h.string("__boxHTML(__box())"), "<p><br></br></p>")
        XCTAssertEqual(try h.string("__first('.essay-tool-undo', __item(3)).getAttribute('aria-disabled')"), "true")
    }

    // MARK: - Restore (P-1)

    func testASavedFormattedAnswerIsRestoredWithoutPosting() throws {
        let h = try harness(extra: """
        BUNDLE.saved_responses = {};
        BUNDLE.saved_responses[BUNDLE.items[3].id] = { type: 'essay', text: 'ignored',
          html: '<p data-indent="first"><strong>Hi</strong> there</p><ul><li>a</li></ul><script>x</script>' };
        """)
        XCTAssertEqual(
            try h.string("__boxHTML(__box())"),
            "<p data-indent=\"first\"><strong>Hi</strong> there</p><ul><li>a</li></ul>"
        )
        XCTAssertEqual(try h.postedMessages().count, 0, "a restore posts nothing (P-1 D-3)")
        XCTAssertEqual(try h.string("__first('.word-count', __item(3)).textContent"), "3 / 400 words")
        // The restore is the baseline: a blur with nothing changed posts nothing,
        // and there is nothing to undo.
        try h.eval("__box().onblur({});")
        XCTAssertEqual(try h.postedMessages().count, 0)
        XCTAssertEqual(try h.string("__first('.essay-tool-undo', __item(3)).getAttribute('aria-disabled')"), "true")
    }

    func testASavedPlainAnswerFillsOneParagraphPerLine() throws {
        let h = try harness(extra: """
        BUNDLE.saved_responses = {};
        BUNDLE.saved_responses[BUNDLE.items[3].id] = { type: 'essay', text: 'First line\\n\\nThird <b>line</b>' };
        """)
        XCTAssertEqual(try h.string("__boxHTML(__box())"), "<p>First line</p><p><br></br></p><p>Third <b>line</b></p>")
        XCTAssertEqual(try h.int("__count('b', __box())"), 0, "saved text is text, never markup")
    }

    // MARK: - Slice 4: pure functions (read aloud, dictation, RT-1, RT-2)

    /// Builds `__sb` in the pure harness:
    /// <p>The <b>cat</b> sat.</p><p></p><ul><li>one</li><li><br></li><li>two</li></ul><ol><li>x \$5</li></ol>
    /// — the empty <p> is what WebKit's list command can leave behind (RT-1).
    private static let speechBox = #"""
    var __sb = document.createElement('div');
    (function () {
      function el(tag, kids) {
        var n = document.createElement(tag);
        kids.forEach(function (k) { n.appendChild(typeof k === 'string' ? document.createTextNode(k) : k); });
        return n;
      }
      __sb.appendChild(el('p', ['The ', el('b', ['cat']), ' sat.']));
      __sb.appendChild(el('p', []));
      __sb.appendChild(el('ul', [el('li', ['one']), el('li', [el('br', [])]), el('li', ['two'])]));
      __sb.appendChild(el('ol', [el('li', ['x \\$5'])]));
    })();
    var __segs = richSpeechSegments(__sb);
    function __segText() { return __segs.map(function (s) { return s.text; }).join(''); }
    """#

    func testSpeechSegmentsReadTheBoxAsTheDerivedTextLines() throws {
        let h = try pure()
        try h.eval(Self.speechBox)
        XCTAssertEqual(try h.string("__segText()"), "The cat sat.\n\u{2022} one\n\u{2022} two\n1. x $5")
        // The same lines as the D-7 text the server derives (the `\$` is
        // spoken as `$`).
        XCTAssertEqual(try h.string("richText(richBlocksFromDom(__sb))"), "The cat sat.\n\u{2022} one\n\u{2022} two\n1. x \\$5")
        // Markers and line breaks are said, never on a node; every other
        // segment is a text node of the box.
        XCTAssertEqual(
            try h.string("__segs.map(function (s) { return s.said ? 'said' : (s.node ? 'node' : '?'); }).join(',')"),
            "node,node,node,said,said,node,said,said,node,said,said,node"
        )
    }

    func testASpokenWordMapsOntoTheBoxsTextNode() throws {
        let h = try pure()
        try h.eval(Self.speechBox)
        // "cat" is segment 1, the <b>'s own text node.
        try h.eval("var __r = richSpeechRange(__segs[1], 0, 3);")
        XCTAssertTrue(try h.bool("__r.node === __sb.childNodes[0].childNodes[1].childNodes[0]"))
        XCTAssertEqual(try h.string("__r.node.textContent.slice(__r.start, __r.end)"), "cat")
        // " sat." is segment 2: the word at spoken offset 1.
        try h.eval("__r = richSpeechRange(__segs[2], 1, 3);")
        XCTAssertEqual(try h.string("__r.node.textContent.slice(__r.start, __r.end)"), "sat")
        // A list marker and a line break mark nothing.
        XCTAssertTrue(try h.bool("richSpeechRange(__segs[4], 0, 1) === null"))
        XCTAssertTrue(try h.bool("richSpeechRange(__segs[3], 0, 1) === null"))
        // After a spoken `$` (written `\$`), offsets map past the backslash.
        try h.eval("__r = richSpeechRange(__segs[11], 2, 2);")
        XCTAssertEqual(try h.string("__r.node.textContent.slice(__r.start, __r.end)"), "\\$5")
        // A word running past the node is clamped to it.
        try h.eval("__r = richSpeechRange(__segs[0], 0, 99);")
        XCTAssertEqual(try h.string("__r.node.textContent.slice(__r.start, __r.end)"), "The ")
    }

    func testAFormulaInTheBoxIsOneSegmentMarkedWhole() throws {
        let h = try pure()
        try h.eval("""
        var __b = document.createElement('div');
        var __p = document.createElement('p');
        __p.appendChild(document.createTextNode('So $x^2$ grows'));
        __b.appendChild(__p);
        // A stand-in for the page's mathSegments.
        var __s = richSpeechSegments(__b, function (raw) {
          return [{ text: 'So ', math: false }, { text: '$x^2$', math: true }, { text: ' grows', math: false }];
        });
        """)
        XCTAssertEqual(try h.string("__s.map(function (s) { return s.kind; }).join(',')"), "text,math,text")
        XCTAssertEqual(try h.string("__s[1].tex"), "x^2")
        try h.eval("var __r = richSpeechRange(__s[1], 0, 0);")
        XCTAssertEqual(try h.string("__r.node.textContent.slice(__r.start, __r.end)"), "$x^2$")
        try h.eval("__r = richSpeechRange(__s[2], 1, 5);")
        XCTAssertEqual(try h.string("__r.node.textContent.slice(__r.start, __r.end)"), "grows")
    }

    /// Dictation spacing: the context is read at the caret, not at the end.
    func testTheCaretContextIsTheTextAroundTheCaret() throws {
        let h = try pure()
        try h.eval("""
        var __cb = document.createElement('div');
        ['First line.', 'The cat sat'].forEach(function (t) {
          var p = document.createElement('p');
          p.appendChild(document.createTextNode(t));
          __cb.appendChild(p);
        });
        var __t2 = __cb.childNodes[1].childNodes[0];
        function __ctx(node, offset, endNode, endOffset) {
          return JSON.stringify(richCaretContext(__cb, node, offset,
            endNode === undefined ? node : endNode, endOffset === undefined ? offset : endOffset));
        }
        """)
        // Mid-paragraph: "The |cat" — the word before, the letter after.
        XCTAssertEqual(try h.string("__ctx(__t2, 4)"), #"{"before":"First line.\nThe ","after":"c"}"#)
        // The start of a paragraph: the boundary reads as a newline.
        XCTAssertEqual(try h.string("__ctx(__t2, 0)"), #"{"before":"First line.\n","after":"T"}"#)
        // Mid-word: a letter on both sides.
        XCTAssertEqual(try h.string("__ctx(__t2, 6)"), #"{"before":"rst line.\nThe ca","after":"t"}"#)
        // A selection: before its start, after its end.
        XCTAssertEqual(try h.string("__ctx(__t2, 4, __t2, 7)"), #"{"before":"First line.\nThe ","after":" "}"#)
        // No caret: the end of the answer.
        XCTAssertEqual(try h.string("JSON.stringify(richCaretContext(__cb, null))"), #"{"before":"ine.\nThe cat sat","after":""}"#)
    }

    /// RT-1: an empty <p> (no <br>, no text) renders nothing, so it is neither
    /// saved nor counted in a caret position.
    func testAnInvisibleEmptyParagraphIsSkipped() throws {
        let h = try pure()
        try h.eval(Self.speechBox)
        XCTAssertEqual(
            try h.string("richSerialize(richBlocksFromDom(__sb))"),
            "<p>The <strong>cat</strong> sat.</p><ul><li>one</li><li>two</li></ul><ol><li>x \\$5</li></ol>"
        )
        // "one": "The cat sat." is 12, the item boundary 1 — no extra 1 for
        // the empty paragraph — so "one" starts at 13.
        XCTAssertEqual(try h.int("richPositionOf(__sb, __sb.childNodes[2].childNodes[0].childNodes[0], 0)"), 13)
        // A paragraph holding only a <br> (a visible empty line) is kept.
        XCTAssertEqual(try h.string("""
        (function () {
          var b = document.createElement('div');
          ['a', null, 'b'].forEach(function (t) {
            var p = document.createElement('p');
            p.appendChild(t === null ? document.createElement('br') : document.createTextNode(t));
            b.appendChild(p);
          });
          return richSerialize(richBlocksFromDom(b));
        })()
        """), "<p>a</p><p><br></p><p>b</p>")
    }

    /// RT-2: a caret move updates the current state's caret and closes the step.
    func testACaretMoveIsKeptForTheNextUndo() throws {
        let h = try pure()
        try h.eval("""
        var __now = 0;
        undoNow = function () { return __now; };
        var __val = 'abc', __sel = [3, 3], __applied = null;
        var __hist = undoHistory(function () { return { key: __val, sel: __sel.slice() }; },
          function (s) { __applied = s; __val = s.key; __sel = s.sel; });
        __val = 'abc def'; __sel = [7, 7]; __hist.record(false);
        __sel = [1, 1]; __hist.moved();            // the student clicks after "a"
        __val = 'aXbc def'; __sel = [2, 2]; __hist.record(false);
        """)
        XCTAssertEqual(try h.int("__hist.depth()"), 3, "the move closed the typing step")
        try h.eval("__hist.undo();")
        XCTAssertEqual(try h.string("__val"), "abc def")
        XCTAssertEqual(try h.string("__sel.join(',')"), "1,1", "the caret goes back where the change was made")
        // A "move" to the caret typing left is no move: the step stays open.
        try h.eval("""
        __val = 'a'; __sel = [1, 1];
        var __h2 = undoHistory(function () { return { key: __val, sel: __sel.slice() }; }, function () {});
        __val = 'ab'; __sel = [2, 2]; __h2.record(false);
        __h2.moved();
        __val = 'abc'; __sel = [3, 3]; __h2.record(false);
        """)
        XCTAssertEqual(try h.int("__h2.depth()"), 2, "still coalesced into the open step")
    }

    // MARK: - Read aloud over the box (slice 4)

    private static let highlightStub = """
    var TTS_SCOPE = { items: false, stimuli: false, responses: true };
    var __hl = [];
    var __hlCleared = 0;
    function Highlight(range) { this.range = range; }
    var CSS = { highlights: {
      set: function (name, h) { __hl.push(h.range); },
      delete: function () { __hlCleared += 1; }
    } };
    """

    func testReadMyAnswerReadsTheLinesWithoutAMirror() throws {
        let h = try harness(extra: Self.highlightStub)
        try h.eval("__typeBox(['Hello', 'World']);")
        let bar = "__first('.tts-play', __item(3))"
        XCTAssertEqual(try h.string("\(bar).textContent"), "Read my answer")
        try h.eval("\(bar).onclick({});")
        let speak = try XCTUnwrap(h.postedSpeech().last)
        XCTAssertEqual(speak["action"] as? String, "speak")
        let segments = speak["segments"] as? [[String: Any]]
        XCTAssertEqual(segments?.compactMap { $0["text"] as? String }.joined(), "Hello\nWorld")
        XCTAssertEqual(try h.int("__count('.tts-mirror', document.body)"), 0, "no mirror over a formatted box")
        XCTAssertTrue(try h.bool("(' ' + __box().className + ' ').indexOf(' tts-reading ') !== -1"))
    }

    func testASpokenWordIsHighlightedInTheBoxAndTheMarkerIsNot() throws {
        let h = try harness(extra: Self.highlightStub)
        try h.eval("""
        (function () {
          var box = __box();
          while (box.firstChild) box.removeChild(box.firstChild);
          var p = __para('Some ');
          var b = document.createElement('strong');
          b.appendChild(document.createTextNode('bold'));
          p.appendChild(b);
          p.appendChild(document.createTextNode(' part'));
          box.appendChild(p);
          var ul = document.createElement('ul');
          var li = document.createElement('li');
          li.appendChild(document.createTextNode('item'));
          ul.appendChild(li);
          box.appendChild(ul);
          box.oninput({ type: 'input' });
        })()
        """)
        try h.eval("__first('.tts-play', __item(3)).onclick({});")
        let speak = try XCTUnwrap(h.postedSpeech().last)
        let id = try XCTUnwrap(speak["id"] as? String)
        let segments = try XCTUnwrap(speak["segments"] as? [[String: Any]])
        XCTAssertEqual(segments.compactMap { $0["text"] as? String }, ["Some ", "bold", " part", "\n", "\u{2022} ", "item"])
        // "bold" — segment 1 — is a range on the <strong>'s text node.
        try h.eval("window.__secureTestSpeech.word('\(id)', 1, 0, 4)")
        XCTAssertTrue(try h.bool("__hl[0].startContainer === __box().childNodes[0].childNodes[1].childNodes[0]"))
        XCTAssertEqual(try h.string("__hl[0].startOffset + '-' + __hl[0].endOffset"), "0-4")
        // "part" in " part".
        try h.eval("window.__secureTestSpeech.word('\(id)', 2, 1, 4)")
        XCTAssertEqual(try h.string("__hl[1].startContainer.textContent.slice(__hl[1].startOffset, __hl[1].endOffset)"), "part")
        // The bullet is said with nothing marked: the previous word clears.
        let cleared = try h.int("__hlCleared")
        try h.eval("window.__secureTestSpeech.word('\(id)', 4, 0, 1)")
        XCTAssertEqual(try h.int("__hl.length"), 2)
        XCTAssertEqual(try h.int("__hlCleared"), cleared + 1)
        // The item's own word is marked in the <li>.
        try h.eval("window.__secureTestSpeech.word('\(id)', 5, 0, 4)")
        XCTAssertTrue(try h.bool("__hl[2].startContainer === __box().childNodes[1].childNodes[0].childNodes[0]"))
        // The highlight clears at the end.
        let before = try h.int("__hlCleared")
        try h.eval("window.__secureTestSpeech.finished('\(id)')")
        XCTAssertEqual(try h.int("__hlCleared"), before + 1)
        XCTAssertFalse(try h.bool("(' ' + __box().className + ' ').indexOf(' tts-reading ') !== -1"))
    }

    func testTypingInTheBoxStopsTheReading() throws {
        let h = try harness(extra: Self.highlightStub)
        try h.eval("__typeBox(['Hello there']);")
        try h.eval("__first('.tts-play', __item(3)).onclick({});")
        let id = try XCTUnwrap(h.postedSpeech().last?["id"] as? String)
        try h.eval("window.__secureTestSpeech.word('\(id)', 0, 0, 5)")
        let cleared = try h.int("__hlCleared")
        try h.eval("__typeBox(['Hello there!']);")
        XCTAssertEqual(try h.postedSpeech().last?["action"] as? String, "stop")
        XCTAssertGreaterThan(try h.int("__hlCleared"), cleared)
        XCTAssertEqual(try h.string("__first('.tts-play', __item(3)).textContent"), "Read my answer")
    }

    func testAnEmptyBoxSaysNoAnswerYet() throws {
        let h = try harness(extra: Self.highlightStub)
        try h.eval("__first('.tts-play', __item(3)).onclick({});")
        let segments = try XCTUnwrap(h.postedSpeech().last?["segments"] as? [[String: Any]])
        XCTAssertEqual(segments.compactMap { $0["text"] as? String }.joined(), "No answer yet.")
    }

    // MARK: - Speak my answer into the box (slice 4)

    func testDictationIsSpacedForTheCaretNotTheEnd() throws {
        let h = try harness(extra: "var STT_STATE = 'ready';")
        try h.eval("__typeBox(['First line.', 'The cat sat']);")
        try h.eval("__select(__box().childNodes[1].childNodes[0], 4);")
        try h.eval("__first('.stt-toggle', __item(3)).onclick({});")
        let listen = try XCTUnwrap(h.postedDictation().last)
        XCTAssertEqual(listen["action"] as? String, "listen")
        XCTAssertEqual(listen["before"] as? String, "First line.\nThe ")
        XCTAssertEqual(listen["after"] as? String, "c")
        XCTAssertEqual(listen["single_line"] as? Bool, false)
    }

    func testDictationIntoAnUnfocusedBoxGoesToTheEnd() throws {
        let h = try harness(extra: "var STT_STATE = 'ready';")
        try h.eval("__typeBox(['First line.', 'The cat sat']); __range = null;")
        try h.eval("__first('.stt-toggle', __item(3)).onclick({});")
        let listen = try XCTUnwrap(h.postedDictation().last)
        XCTAssertEqual(listen["before"] as? String, "ine.\nThe cat sat")
        XCTAssertEqual(listen["after"] as? String, "")
        // The phrase goes in at the end: the caret is put there first.
        let id = try XCTUnwrap(listen["id"] as? String)
        try h.eval("__exec = []; window.__secureTestDictation.insert('\(id)', ' today');")
        XCTAssertEqual(try execNames(h), ["insertText"])
        XCTAssertTrue(try h.bool("__range.startContainer === __box().childNodes[1].childNodes[0]"))
        XCTAssertEqual(try h.int("__range.startOffset"), 11)
    }

    // MARK: - Accessibility (slice 4)

    func testTheToolbarAndBoxAreNamedAndLinked() throws {
        let h = try harness()
        let item = "__item(\(Self.essay))"
        let toolbar = "__first('.essay-toolbar', \(item))"
        XCTAssertEqual(try h.string("\(toolbar).getAttribute('aria-label')"), "Formatting")
        XCTAssertEqual(try h.string("\(toolbar).getAttribute('aria-controls')"), try h.string("__box().id"))
        XCTAssertEqual(
            try h.string("__all('button', \(toolbar)).map(function (b) { return b.getAttribute('aria-label'); }).join('|')"),
            "Bold|Italic|Underline|Bulleted list|Numbered list|Indent first line|Undo|Redo"
        )
        // The word count describes the box.
        let counter = try XCTUnwrap(h.string("__first('.word-count', \(item)).id"))
        XCTAssertFalse(counter.isEmpty)
        XCTAssertEqual(try h.string("__box().getAttribute('aria-describedby')"), counter)
        // No limit, no description.
        let none = try harness(extra: "delete BUNDLE.items[3].max_word_count;")
        XCTAssertNil(try none.string("__box().getAttribute('aria-describedby')"))
    }

    /// RT-2 through the page: an undo after a click puts the caret at the click.
    func testUndoPutsTheCaretWhereTheUndoneChangeWasMade() throws {
        let h = try harness(extra: """
        __execHook = function (name) {
          if (name !== 'bold') return;
          var p = __box().childNodes[0];
          var t = p.childNodes[0];
          var text = t.textContent;
          while (p.firstChild) p.removeChild(p.firstChild);
          p.appendChild(document.createTextNode(text.slice(0, 5)));
          var b = document.createElement('b');
          b.appendChild(document.createTextNode(text.slice(5, 9)));
          p.appendChild(b);
          p.appendChild(document.createTextNode(text.slice(9)));
        };
        """)
        // Typing ends with the caret after "part" (recorded with the typing).
        try h.eval("__typeBox(['Some bold part']); __select(__box().childNodes[0].childNodes[0], 14); __box().oninput({ type: 'input' });")
        try h.eval("__advance(2000);")
        // The student selects "bold" and makes it bold.
        try h.eval("__select(__box().childNodes[0].childNodes[0], 5, __box().childNodes[0].childNodes[0], 9); __box().__selectionMoved();")
        try h.eval("__first('.essay-tool-bold', __item(3)).onclick({});")
        // The caret is somewhere else when Undo is pressed.
        try h.eval("__select(__box().childNodes[0].childNodes[0], 0);")
        try h.eval("__first('.essay-tool-undo', __item(3)).onclick({});")
        XCTAssertEqual(try h.string("__boxHTML(__box())"), "<p>Some bold part</p>")
        XCTAssertTrue(try h.bool("__range.startContainer === __box().childNodes[0].childNodes[0]"))
        XCTAssertEqual(try h.string("__range.startOffset + '-' + __range.endOffset"), "5-9")
    }

    // MARK: - Undo in plain fields (D-6)

    func testUndoInAShortTextFieldCoalescesTypingAndSavesAtOnce() throws {
        let h = try harness()
        let input = "__first('.short-text', __item(\(Self.shortText)))"
        try h.eval("__type(\(input), 'H'); __type(\(input), 'He'); __type(\(input), 'Hel');")
        try h.eval("__advance(2000);")
        try h.eval("__type(\(input), 'Help');")
        XCTAssertTrue(try h.bool("__key(\(input), { key: 'z', metaKey: true })"))
        XCTAssertEqual(try h.string("\(input).value"), "Hel", "a pause starts a new step")
        XCTAssertEqual(try lastResponse(h, item: Self.shortText)?["text"] as? String, "Hel")
        XCTAssertTrue(try h.bool("__key(\(input), { key: 'z', metaKey: true })"))
        XCTAssertEqual(try h.string("\(input).value"), "", "quick keystrokes were one step")
        XCTAssertEqual(try lastResponse(h, item: Self.shortText)?["text"] as? String, "")
        XCTAssertTrue(try h.bool("__key(\(input), { key: 'Z', metaKey: true, shiftKey: true })"))
        XCTAssertEqual(try h.string("\(input).value"), "Hel")
        // Nothing left to redo past the end; the chord is still swallowed.
        try h.eval("__key(\(input), { key: 'z', metaKey: true, shiftKey: true });")
        XCTAssertTrue(try h.bool("__key(\(input), { key: 'z', metaKey: true, shiftKey: true })"))
        XCTAssertEqual(try h.string("\(input).value"), "Help")
    }

    func testAWordBoundaryClosesTheStep() throws {
        let h = try harness()
        let input = "__first('.short-text', __item(\(Self.shortText)))"
        try h.eval("__type(\(input), 'one', 'e'); __type(\(input), 'one ', ' '); __type(\(input), 'one t', 't');")
        try h.eval("__key(\(input), { key: 'z', metaKey: true });")
        XCTAssertEqual(try h.string("\(input).value"), "one ")
    }

    func testTheHistoryIsCappedAt200Steps() throws {
        let h = try harness()
        let input = "__first('.short-text', __item(\(Self.shortText)))"
        try h.eval("for (var n = 0; n < 250; n++) { __advance(2000); __type(\(input), 'v' + n); }")
        XCTAssertEqual(try h.int("\(input).__undo.depth()"), 200)
    }

    func testAMathKeyIsOneUndoStepAndItsUndoIsSaved() throws {
        let h = try harness()
        let input = "__first('.short-text', __item(\(Self.shortText)))"
        try h.eval("__type(\(input), 'x');")
        try h.eval("\(input).setSelectionRange(1, 1);")
        try h.eval("""
        __all('button', __item(\(Self.shortText))).filter(function (b) {
          return b.getAttribute('data-key') === 'pi'; })[0].onclick({ detail: 1 });
        """)
        XCTAssertEqual(try h.string("\(input).value"), "xπ")
        XCTAssertEqual(try lastResponse(h, item: Self.shortText)?["text"] as? String, "xπ")
        try h.eval("__key(\(input), { key: 'z', metaKey: true });")
        XCTAssertEqual(try h.string("\(input).value"), "x", "the key alone is taken back")
        XCTAssertEqual(try lastResponse(h, item: Self.shortText)?["text"] as? String, "x", "and the undo is posted")
    }

    func testUndoInATableCellPostsTheWholeGrid() throws {
        let h = try harness()
        let cell = "__first('.table-cell', __item(\(Self.table)))"
        try h.eval("__type(\(cell), 'left');")
        try h.eval("__advance(6000);")
        try h.eval("__type(\(cell), 'left ventricle');")
        try h.eval("__key(\(cell), { key: 'z', metaKey: true });")
        XCTAssertEqual(try h.string("\(cell).value"), "left")
        let response = try XCTUnwrap(lastResponse(h, item: Self.table))
        XCTAssertEqual(response["type"] as? String, "table")
        let cells = response["cells"] as? [String: [String: String]]
        XCTAssertEqual(cells?.values.flatMap { $0.values }, ["left"])
    }

    func testUndoInAPlainEssayRefreshesTheWordCount() throws {
        let h = try harness(extra: "BUNDLE.items[3].rich_text = false;")
        let area = "__first('textarea', __item(3))"
        try h.eval("__type(\(area), 'one two');")
        try h.eval("__advance(2000);")
        try h.eval("__type(\(area), 'one two three');")
        try h.eval("__key(\(area), { key: 'z', metaKey: true });")
        XCTAssertEqual(try h.string("\(area).value"), "one two")
        XCTAssertEqual(try h.string("__first('.word-count', __item(3)).textContent"), "2 / 400 words")
    }

    func testUndoInATypedBlank() throws {
        let h = try harness()
        let blank = "__first('input', __item(9))"
        try h.eval("__type(\(blank), 'lee');")
        try h.eval("__advance(2000);")
        try h.eval("__type(\(blank), 'leeward');")
        try h.eval("__key(\(blank), { key: 'z', metaKey: true });")
        XCTAssertEqual(try h.string("\(blank).value"), "lee")
    }
}
