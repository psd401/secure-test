import XCTest
@testable import SecureTestCore

/// Corrections mode, the page half (U-25 slice 3c,
/// `docs/bulk-pass-back-and-corrections-design.md`, D-8 / D-21…D-27): on a
/// test passed back for another try, each question can show how it went last
/// time, and full-credit answers can be locked. The server decides what rides
/// (`corrections` on the bundle); the page draws it, never sends a write for a
/// locked item, and is unchanged when the field is absent or malformed.
///
/// What this cannot prove: how the note looks in WebKit, that a locked field
/// really refuses the pointer (`pointer-events`), or what VoiceOver says —
/// the hand-run rows in `client/MANUAL-CHECKS.md`.
final class RendererCorrectionsTests: XCTestCase {
    private static let mc = "c15585ea-aee6-4c1c-b781-f0c304166720"
    private static let shortText = "16114532-42f8-4c01-b806-ea2bb883694c"
    private static let essay = "7a4b99ad-a4e3-48c1-a950-9e3cc9b61f0f"
    private static let fillBlank = "f770cdcf-7038-421a-a9fd-d398549154ad"

    private func harness(corrections: String?) throws -> RendererHarness {
        var json = try RendererHarness.fixtureJSON()
        if let corrections, let brace = json.firstIndex(of: "{") {
            json.replaceSubrange(brace...brace, with: "{\"corrections\": \(corrections), ")
        }
        return try RendererHarness(bundleJSON: json)
    }

    private func itemIndex(_ id: String) throws -> Int {
        let json = try RendererHarness.fixtureJSON()
        let data = try XCTUnwrap(json.data(using: .utf8))
        let bundle = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let items = try XCTUnwrap(bundle["items"] as? [[String: Any]])
        return try XCTUnwrap(items.firstIndex { ($0["id"] as? String) == id })
    }

    private func note(_ h: RendererHarness, _ id: String) throws -> String? {
        let n = try itemIndex(id)
        return try h.string("(function () { var x = __first('.correction-note', __item(\(n))); return x ? x.textContent : null; })()")
    }

    // MARK: - Absent or malformed

    func testAbsentFieldChangesNothing() throws {
        let h = try harness(corrections: nil)
        XCTAssertEqual(try h.int("__count('.correction-note')"), 0)
        XCTAssertEqual(try h.int("__count('.locked-answer')"), 0)
        let n = try itemIndex(Self.mc)
        try h.eval("var b = __all('input', __item(\(n)))[0]; b.checked = true; b.onchange();")
        XCTAssertEqual(try h.postedMessages().count, 1)
    }

    func testUnknownWordsAndNonStringIdsAreIgnored() throws {
        let h = try harness(corrections: """
            { "marks": { "\(Self.mc)": "great", "\(Self.shortText)": 1 }, "locked": [5, null] }
            """)
        XCTAssertEqual(try h.int("__count('.correction-note')"), 0)
        XCTAssertEqual(try h.int("__count('.locked-answer')"), 0)
    }

    // MARK: - Marks

    func testMarksAreGlyphAndWordsAndNothingIsLocked() throws {
        let h = try harness(corrections: """
            { "marks": { "\(Self.mc)": "correct", "\(Self.shortText)": "incorrect", "\(Self.essay)": "partial" } }
            """)
        XCTAssertEqual(try note(h, Self.mc), "\u{2713} Correct last time")
        XCTAssertEqual(try note(h, Self.shortText), "\u{2717} Not correct last time")
        XCTAssertEqual(try note(h, Self.essay), "\u{25D0} Partly correct last time")
        XCTAssertEqual(try h.int("__count('.correction-note')"), 3)
        XCTAssertEqual(try h.int("__count('.locked-answer')"), 0)
        // VoiceOver hears the words without the glyph, as a note.
        let n = try itemIndex(Self.shortText)
        XCTAssertEqual(try h.string("__first('.correction-note', __item(\(n))).getAttribute('aria-label')"), "Not correct last time")
        XCTAssertEqual(try h.string("__first('.correction-note', __item(\(n))).getAttribute('role')"), "note")
        // The note sits above the stem.
        XCTAssertTrue(try h.bool("""
            (function () {
              var kids = __item(\(n)).children;
              return kids.indexOf(__first('.correction-note', __item(\(n)))) < kids.indexOf(__first('.stem', __item(\(n))));
            })()
            """))
        // An answer can still be changed and posted.
        try h.eval("var t = __all('input', __item(\(n)))[0]; t.value = 'mitosis'; t.onchange();")
        XCTAssertEqual(try h.postedMessages().count, 1)
    }

    // MARK: - Locks

    func testLockedChoiceIsReadOnlyAndNeverPosts() throws {
        let h = try harness(corrections: "{ \"locked\": [\"\(Self.mc)\"] }")
        let n = try itemIndex(Self.mc)
        XCTAssertEqual(try note(h, Self.mc), "\u{2713} Correct \u{2014} locked")
        XCTAssertTrue(try h.bool("__all('input', __item(\(n))).length > 0 && __all('input', __item(\(n))).every(function (b) { return b.disabled === true; })"))
        XCTAssertEqual(try h.string("__first('.locked-answer', __item(\(n))).getAttribute('aria-disabled')"), "true")
        XCTAssertTrue(try h.bool("(' ' + __item(\(n)).className + ' ').indexOf(' locked ') !== -1"))
        // Even a handler fired by hand posts nothing for a locked item.
        try h.eval("var b = __all('input', __item(\(n)))[1]; b.checked = true; b.onchange();")
        XCTAssertEqual(try h.postedMessages().count, 0)
        // Only that item is locked.
        XCTAssertEqual(try h.int("__count('.locked-answer')"), 1)
    }

    func testLockedFillBlankLocksTheControlsInItsSentence() throws {
        let h = try harness(corrections: "{ \"locked\": [\"\(Self.fillBlank)\"] }")
        let n = try itemIndex(Self.fillBlank)
        XCTAssertEqual(try h.int("__count('.locked-answer', __item(\(n)))"), 1)
        XCTAssertTrue(try h.bool("""
            (function () {
              var stem = __first('.stem', __item(\(n)));
              var controls = __all('select', stem).concat(__all('input', stem));
              return controls.length > 0 && controls.every(function (c) { return c.disabled === true; });
            })()
            """))
    }

    func testLockedEssayStopsEditingButKeepsItsText() throws {
        let h = try harness(corrections: "{ \"locked\": [\"\(Self.essay)\"] }")
        let n = try itemIndex(Self.essay)
        XCTAssertEqual(try h.int("__count('.locked-answer', __item(\(n)))"), 1)
        XCTAssertTrue(try h.bool("""
            (function () {
              var area = __first('.locked-answer', __item(\(n)));
              var fields = __all('textarea', area);
              var editable = [];
              (function walk(x) {
                if (x.getAttribute && x.getAttribute('contenteditable') !== null) editable.push(x);
                (x.children || []).forEach(walk);
              })(area);
              return fields.every(function (f) { return f.disabled === true; }) &&
                editable.every(function (e) { return e.getAttribute('contenteditable') === 'false'; }) &&
                fields.length + editable.length > 0;
            })()
            """))
    }

    func testMarksAndLocksTogether() throws {
        let h = try harness(corrections: """
            { "marks": { "\(Self.mc)": "correct", "\(Self.shortText)": "incorrect" }, "locked": ["\(Self.mc)"] }
            """)
        XCTAssertEqual(try note(h, Self.mc), "\u{2713} Correct \u{2014} locked")
        XCTAssertEqual(try note(h, Self.shortText), "\u{2717} Not correct last time")
        XCTAssertEqual(try h.int("__count('.locked-answer')"), 1)
    }
}
