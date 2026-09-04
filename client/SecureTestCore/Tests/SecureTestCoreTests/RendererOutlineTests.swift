import XCTest
@testable import SecureTestCore

/// E12 slice 3: a source-backed stimulus whose answer did not come from the
/// source assessment carries a writing area; the outline posts under the
/// source question's id on the ordinary response channel.
final class RendererOutlineTests: XCTestCase {
    private func harness(_ set: String) throws -> RendererHarness {
        try RendererHarness(bundleJSON: """
        {"test_id":"e12","title":"Essay",
         "items":[{"type":"essay","id":"e1","stem":"Write the essay"}],
         "item_sets":[\(set)],
         "accommodations":{"spell_check":true}}
        """)
    }

    func testMissingAnswerRendersAnEmptyWritingAreaThatPostsUnderTheSourceItem() throws {
        let h = try harness(#"{"id":"s1","stimulus":"Your outline:","item_ids":["e1"],"inline_item_id":"outline-q","source_missing":true}"#)
        XCTAssertEqual(try h.int("__count('textarea', __first('.stimulus'))"), 1)
        XCTAssertEqual(try h.string("__first('.outline-hint').textContent"),
                       "You have not written your outline yet. Write it here first \u{2014} the questions below build on it.")
        XCTAssertEqual(try h.string("__first('.outline-text').value"), "")
        XCTAssertTrue(try h.bool("__first('.outline-text').spellcheck"))
        try h.eval("""
        var ta = __first('.outline-text');
        ta.value = 'Cars should yield to pedestrians because...';
        ta.onchange();
        """)
        let last = try h.postedMessages().last
        XCTAssertEqual(last?["item_id"] as? String, "outline-q")
        let response = last?["response"] as? [String: Any]
        XCTAssertEqual(response?["type"] as? String, "essay")
        XCTAssertEqual(response?["text"] as? String, "Cars should yield to pedestrians because...")
        XCTAssertEqual(try h.string("__first('.outline-status').textContent"), "Saved.")
    }

    func testInlineAnswerIsPrefilledAndStillEditable() throws {
        let h = try harness(#"{"id":"s1","stimulus":"Your outline:","item_ids":["e1"],"inline_item_id":"outline-q","inline_text":"Three reasons"}"#)
        XCTAssertEqual(try h.string("__first('.outline-text').value"), "Three reasons")
        XCTAssertEqual(try h.string("__first('.outline-hint').textContent"), "Your outline. You can still change it here.")
    }

    func testAResolvedOrPlainStimulusHasNoWritingArea() throws {
        let h = try harness(#"{"id":"s1","stimulus":"Your outline:\n\nReal outline","item_ids":["e1"]}"#)
        XCTAssertEqual(try h.int("__count('textarea', __first('.stimulus'))"), 0)
        XCTAssertEqual(try h.int("__count('.outline-inline')"), 0)
    }
}
