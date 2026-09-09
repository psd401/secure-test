import XCTest
@testable import SecureTestCore

/// E5 slice 2: a set's stimulus renders once, above the first of its items,
/// through the same text-and-assets path a stem uses; its items are marked.
/// Runs the real renderer in JavaScriptCore (RendererHarness) against the
/// fixture the design tool's delivery route produced, which carries one set
/// over positions 2–3 (indices 1–2) with an image ref and layout own_page.
final class RendererStimulusTests: XCTestCase {
    private func harness() throws -> RendererHarness {
        try RendererHarness(bundleJSON: try RendererHarness.fixtureJSON())
    }

    /// A bundle with the fixture's items and the given `item_sets` value.
    private func harness(itemSets: String) throws -> RendererHarness {
        try RendererHarness(bundleJSON: try RendererHarness.fixtureJSON(replacingItemSets: itemSets))
    }

    func testRendersTheStimulusOnceBeforeTheFirstMember() throws {
        let h = try harness()
        // Two sets since the multi-source slice: own_page over items 1–2 and
        // side_by_side over item 3 (which renders inline on the scroll path).
        XCTAssertEqual(try h.int("__count('.stimulus')"), 2)
        // Root order: item 0, stimulus, item 1, item 2, stimulus, item 3, …
        XCTAssertEqual(try h.string("__root.children[0].className"), "item")
        XCTAssertEqual(try h.string("__root.children[1].className"), "stimulus stimulus-own_page")
        XCTAssertEqual(try h.string("__root.children[2].className"), "item in-set")
        XCTAssertEqual(try h.string("__root.children[3].className"), "item in-set")
        XCTAssertEqual(try h.string("__root.children[4].className"), "stimulus stimulus-inline")
        XCTAssertEqual(try h.string("__root.children[5].className"), "item in-set")
    }

    func testLabelsTheQuestionRangeAndRendersTextAndImage() throws {
        let h = try harness()
        XCTAssertEqual(try h.string("__first('.stimulus-label').textContent"), "Questions 2\u{2013}3")
        let body = "__first('.stimulus-body')"
        XCTAssertEqual(try h.int("__count('img', \(body))"), 1)
        XCTAssertEqual(
            try h.string("\(body).textContent"),
            "Cells at work:  Use the diagram for the next two questions."
        )
        XCTAssertTrue(try h.string("__first('img', \(body)).src")?.hasPrefix("data:image/") ?? false)
    }

    func testAllItemsStillRenderAndOnlyMembersAreMarked() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('.item')"), 9)
        XCTAssertEqual(try h.int("__count('.in-set')"), 3)
    }

    func testNoSetsMeansNoStimulusMarkup() throws {
        let h = try harness(itemSets: "[]")
        XCTAssertEqual(try h.int("__count('.stimulus')"), 0)
        XCTAssertEqual(try h.int("__count('.in-set')"), 0)
        XCTAssertEqual(try h.int("__count('.item')"), 9)
    }

    func testUnknownLayoutRendersInlineAndUnknownIdsAreIgnored() throws {
        // Build a set over the first item only, with a layout this client has
        // never heard of and an id that is not in the bundle.
        let h = try harness(itemSets: #"[{"id":"s","stimulus":"Read.","layout":"sideways","item_ids":["not-an-item","FIRST"]}]"#
            .replacingOccurrences(of: "FIRST", with: try firstItemId()))
        XCTAssertEqual(try h.int("__count('.stimulus')"), 1)
        XCTAssertEqual(try h.string("__first('.stimulus').className"), "stimulus stimulus-inline")
        XCTAssertEqual(try h.string("__first('.stimulus-label').textContent"), "Question 1")
        XCTAssertEqual(try h.string("__root.children[0].className"), "stimulus stimulus-inline")
        XCTAssertEqual(try h.string("__root.children[1].className"), "item in-set")
        XCTAssertEqual(try h.int("__count('.in-set')"), 1)
    }

    func testASetWhoseIdsAreAllUnknownRendersNothing() throws {
        let h = try harness(itemSets: #"[{"id":"s","stimulus":"Orphan","layout":"inline","item_ids":["nope"]}]"#)
        XCTAssertEqual(try h.int("__count('.stimulus')"), 0)
        XCTAssertEqual(try h.int("__count('.item')"), 9)
    }

    private func firstItemId() throws -> String {
        let data = Data(try RendererHarness.fixtureJSON().utf8)
        let bundle = try DeliveryBundle.decode(from: data)
        return try XCTUnwrap(bundle.items.first?.id)
    }
}
