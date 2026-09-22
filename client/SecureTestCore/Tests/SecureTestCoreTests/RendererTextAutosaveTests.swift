import XCTest
@testable import SecureTestCore

/// Text autosave (`docs/client-autosave-and-deferred-spool-design.md`, slice 1,
/// D-1..D-4).
///
/// Typed text used to reach the server only on `change`, so a student who wrote
/// without ever clicking away had nothing saved. The page now posts five
/// seconds after the last keystroke and, for someone who never pauses, within
/// thirty of the first unsaved one.
///
/// JavaScriptCore has no timers, and the shim's `__fireTimers` fires everything
/// that is pending at once — which cannot tell a 5 s idle timer from a 30 s
/// ceiling. So these tests install a VIRTUAL CLOCK in the harness prelude
/// (`__advance(ms)`), which runs only the timers actually due by then. What
/// five seconds feels like to a student stays a hand-run row.
final class RendererTextAutosaveTests: XCTestCase {
    private static let essay = 3
    private static let shortText = 2
    private static let table = 8

    /// Replaces the shim's timers with a clock the test drives, and adds a
    /// `__type` helper: set the value, fire `oninput`, exactly as a keystroke
    /// does.
    private static let clock = #"""
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
          if (__virtual[i].at <= target && (due === null || __virtual[i].at < due.at)) {
            due = __virtual[i];
          }
        }
        if (due === null) break;
        __virtual.splice(__virtual.indexOf(due), 1);
        __now = due.at;
        due.fn();
      }
      __now = target;
    }
    function __pendingVirtual() { return __virtual.length; }
    function __type(el, text) { el.value = text; el.oninput(); }
    """#

    private func harness(offline: Bool = false) throws -> RendererHarness {
        try RendererHarness(
            bundleJSON: try RendererHarness.fixtureJSON(),
            offline: offline,
            prelude: Self.clock
        )
    }

    private func advance(_ h: RendererHarness, _ ms: Int) throws {
        try h.eval("__advance(\(ms));")
    }

    private func type(_ h: RendererHarness, _ selector: String, _ text: String) throws {
        try h.eval("__type(\(selector), '\(text)');")
    }

    private func posts(_ h: RendererHarness, forItem index: Int) throws -> [[String: Any]] {
        let id = try XCTUnwrap(h.string("BUNDLE.items[\(index)].id"))
        return try h.postedMessages().filter { ($0["item_id"] as? String) == id }
    }

    private var essayArea: String { "__first('textarea', __item(\(Self.essay)))" }
    private var shortInput: String { "__first('.short-text', __item(\(Self.shortText)))" }
    private var firstCell: String { "__first('.table-cell', __item(\(Self.table)))" }

    // MARK: - the idle timer

    func testTheEssayPostsFiveSecondsAfterTheLastKeystroke() throws {
        let h = try harness()
        try type(h, essayArea, "The author begins")
        XCTAssertEqual(try posts(h, forItem: Self.essay).count, 0, "not while typing")

        try advance(h, 4999)
        XCTAssertEqual(try posts(h, forItem: Self.essay).count, 0)

        try advance(h, 1)
        let posted = try posts(h, forItem: Self.essay)
        XCTAssertEqual(posted.count, 1)
        let response = posted[0]["response"] as? [String: Any]
        XCTAssertEqual(response?["type"] as? String, "essay")
        XCTAssertEqual(response?["text"] as? String, "The author begins")
    }

    /// The idle timer restarts from zero on every keystroke, so a student still
    /// writing is not posted mid-sentence — and only one post lands when they
    /// finally stop.
    func testTypingAgainRestartsTheIdleTimer() throws {
        let h = try harness()
        try type(h, essayArea, "One")
        try advance(h, 3000)
        try type(h, essayArea, "One two")
        try advance(h, 3000)
        XCTAssertEqual(try posts(h, forItem: Self.essay).count, 0, "the clock restarted")

        try advance(h, 2000)
        let posted = try posts(h, forItem: Self.essay)
        XCTAssertEqual(posted.count, 1)
        XCTAssertEqual((posted[0]["response"] as? [String: Any])?["text"] as? String, "One two")
    }

    // MARK: - the ceiling

    /// D-2: a student who never pauses long enough for the idle timer is still
    /// saved — twice a minute. Typing every two seconds for forty: the first
    /// save lands at thirty, the ceiling restarts, and nothing has been posted
    /// by the idle timer at all.
    func testContinuousTypingIsSavedByTheThirtySecondCeiling() throws {
        let h = try harness()
        var words = ""
        for tick in 1...15 {
            words += "word\(tick) "
            try type(h, essayArea, words.trimmingCharacters(in: .whitespaces))
            try advance(h, 2000)
            if tick < 15 {
                XCTAssertEqual(
                    try posts(h, forItem: Self.essay).count,
                    tick * 2000 < 30000 ? 0 : 1,
                    "after \(tick * 2000) ms of unbroken typing"
                )
            }
        }
        // 30 s exactly: one ceiling save, carrying everything typed by then.
        let posted = try posts(h, forItem: Self.essay)
        XCTAssertEqual(posted.count, 1)
        XCTAssertEqual(
            (posted[0]["response"] as? [String: Any])?["text"] as? String,
            "word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12 word13 word14 word15"
        )

        // And the ceiling runs again from the next unsaved keystroke rather
        // than never firing a second time.
        for _ in 1...15 {
            words += "more "
            try type(h, essayArea, words.trimmingCharacters(in: .whitespaces))
            try advance(h, 2000)
        }
        XCTAssertEqual(try posts(h, forItem: Self.essay).count, 2)
    }

    // MARK: - nothing unchanged is posted (D-3)

    func testAFieldNobodyTouchedPostsNothing() throws {
        let h = try harness()
        try advance(h, 60000)
        XCTAssertEqual(try h.postedMessages().count, 0)
        XCTAssertEqual(try h.int("__pendingVirtual()"), 0)
    }

    /// Typing and then putting the text back the way it was is not a change:
    /// a no-op save would move the student's "last activity" with nothing
    /// behind it.
    func testTypingBackToTheLastPostedTextPostsNothingAgain() throws {
        let h = try harness()
        try type(h, essayArea, "First draft")
        try advance(h, 5000)
        XCTAssertEqual(try posts(h, forItem: Self.essay).count, 1)

        try type(h, essayArea, "First draf")
        try type(h, essayArea, "First draft")
        try advance(h, 30000)
        XCTAssertEqual(try posts(h, forItem: Self.essay).count, 1, "nothing changed")
    }

    // MARK: - change still wins

    func testChangeCancelsTheTimersAndPostsAtOnce() throws {
        let h = try harness()
        try type(h, essayArea, "Blurred")
        XCTAssertEqual(try h.int("__pendingVirtual()"), 2, "idle and ceiling")

        try h.eval("\(essayArea).onchange();")
        XCTAssertEqual(try posts(h, forItem: Self.essay).count, 1)
        XCTAssertEqual(try h.int("__pendingVirtual()"), 0)

        try advance(h, 60000)
        XCTAssertEqual(try posts(h, forItem: Self.essay).count, 1, "no duplicate autosave")
    }

    /// AS-1 (`docs/client-v1-3-5-design.md`, D-4): leaving a field right after
    /// the idle timer already posted the same text must not post again — the
    /// guard applies to `onchange`, not just the timers, so blurring after an
    /// autosave costs no duplicate POST.
    func testBlurAfterAnAutosaveOfTheSameTextDoesNotPostAgain() throws {
        let h = try harness()
        try type(h, essayArea, "Blurred")
        try advance(h, 5000)
        XCTAssertEqual(try posts(h, forItem: Self.essay).count, 1, "the idle timer's post")

        try h.eval("\(essayArea).onchange();")
        XCTAssertEqual(try posts(h, forItem: Self.essay).count, 1, "nothing changed since the autosave")
    }

    /// The other side of the same guard: a change with NEW text since the
    /// last post still goes through `change` at once, exactly as before.
    func testBlurWithNewTextAfterAnAutosaveStillPosts() throws {
        let h = try harness()
        try type(h, essayArea, "First")
        try advance(h, 5000)
        XCTAssertEqual(try posts(h, forItem: Self.essay).count, 1)

        try type(h, essayArea, "First and more")
        try h.eval("\(essayArea).onchange();")
        let posted = try posts(h, forItem: Self.essay)
        XCTAssertEqual(posted.count, 2)
        XCTAssertEqual((posted[1]["response"] as? [String: Any])?["text"] as? String, "First and more")
    }

    // MARK: - the host's flush hook

    func testFlushInputPostsADirtyFieldThatIsNotFocused() throws {
        let h = try harness()
        try type(h, essayArea, "Half a sentence")
        XCTAssertTrue(try h.bool("window.__secureTestFlushInput()"))
        let posted = try posts(h, forItem: Self.essay)
        XCTAssertEqual(posted.count, 1)
        XCTAssertEqual(
            (posted[0]["response"] as? [String: Any])?["text"] as? String,
            "Half a sentence"
        )
        try advance(h, 60000)
        XCTAssertEqual(try posts(h, forItem: Self.essay).count, 1)
    }

    func testFlushInputPostsNothingWhenNoFieldIsDirty() throws {
        let h = try harness()
        try h.eval("window.__secureTestFlushInput();")
        XCTAssertEqual(try h.postedMessages().count, 0)
    }

    // MARK: - the other text fields

    func testShortTextAutosavesAndKeepsItsFormulaPreview() throws {
        let h = try harness()
        try type(h, shortInput, "photosynthesis")
        XCTAssertEqual(try posts(h, forItem: Self.shortText).count, 0)
        try advance(h, 5000)
        let posted = try posts(h, forItem: Self.shortText)
        XCTAssertEqual(posted.count, 1)
        let response = posted[0]["response"] as? [String: Any]
        XCTAssertEqual(response?["type"] as? String, "short_text")
        XCTAssertEqual(response?["text"] as? String, "photosynthesis")
        // The field's own `oninput` — the live preview — is chained, not
        // replaced by the autosave.
        XCTAssertNotNil(
            try h.string("__first('.formula-preview', __item(\(Self.shortText))).getAttribute('data-tex')")
        )
    }

    /// A table cell's send is the whole grid, exactly as its `change` is.
    func testATableCellAutosavesTheWholeGrid() throws {
        let h = try harness()
        try type(h, firstCell, "12")
        try advance(h, 5000)
        let posted = try posts(h, forItem: Self.table)
        XCTAssertEqual(posted.count, 1)
        let response = posted[0]["response"] as? [String: Any]
        XCTAssertEqual(response?["type"] as? String, "table")
        let cells = response?["cells"] as? [String: Any]
        XCTAssertEqual(cells?.count, 1, "only the cell that has text")
        let row = try XCTUnwrap(cells?.values.first as? [String: Any])
        XCTAssertEqual(row.values.first as? String, "12")
    }

    func testTheInlineOutlineAutosavesAndSaysSaved() throws {
        let h = try RendererHarness(
            bundleJSON: """
            {"test_id":"e12","title":"Essay",
             "items":[{"type":"essay","id":"e1","stem":"Write the essay"}],
             "item_sets":[{"id":"s1","stimulus":"Your outline:","item_ids":["e1"],
              "inline_item_id":"outline-q","source_missing":true}],
             "accommodations":{"spell_check":true}}
            """,
            prelude: Self.clock
        )
        try h.eval("__type(__first('.outline-text'), 'Three reasons');")
        XCTAssertEqual(try h.postedMessages().count, 0)
        try h.eval("__advance(5000);")
        let posted = try h.postedMessages()
        XCTAssertEqual(posted.count, 1)
        XCTAssertEqual(posted[0]["item_id"] as? String, "outline-q")
        XCTAssertEqual(
            (posted[0]["response"] as? [String: Any])?["text"] as? String,
            "Three reasons"
        )
        XCTAssertEqual(try h.string("__first('.outline-status').textContent"), "Saved.")
    }

    // MARK: - what the autosave does NOT change

    /// D-4: an autosave marks the item answered exactly as the `change` post
    /// does — no new rule — and the word counter is the field's own `oninput`,
    /// which the autosave chains rather than replaces.
    func testTheWordCounterAndTheAnsweredMarkAreUnchanged() throws {
        // Paged, because the answered mark is only VISIBLE there — the strip
        // and the review page are what a student reads it from.
        var json = try RendererHarness.fixtureJSON()
        let range = try XCTUnwrap(json.range(of: "\"test_id\":"))
        json.replaceSubrange(range, with: "\"layout\": \"paged\", \"test_id\":")
        let h = try RendererHarness(bundleJSON: json, prelude: Self.clock)

        let unanswered = "0 of 9 answered. Go back to any question, or hand in."
        XCTAssertEqual(try h.string("__first('.review-count').textContent"), unanswered)

        try type(h, essayArea, "one two three")
        XCTAssertEqual(
            try h.string("__first('.word-count', __item(\(Self.essay))).textContent"),
            "3 / 400 words"
        )
        XCTAssertEqual(
            try h.string("__first('.review-count').textContent"),
            unanswered,
            "not until something is saved"
        )

        try advance(h, 5000)
        XCTAssertEqual(
            try h.string("__first('.review-count').textContent"),
            "1 of 9 answered. Go back to any question, or hand in."
        )
    }

    /// Offline (DECIDED): autosave posts exactly as online does — the host
    /// relabels each post as ignored, as it does the `change` post today.
    func testOfflineAutosaveStillPosts() throws {
        let h = try harness(offline: true)
        try type(h, essayArea, "Offline words")
        try advance(h, 5000)
        XCTAssertEqual(try posts(h, forItem: Self.essay).count, 1)
    }
}
