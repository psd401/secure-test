import XCTest
@testable import SecureTestCore

/// Slice 56. The order item is fixture index 5: the water cycle, entries
/// e1 Evaporation, e2 Condensation, e3 Precipitation, e4 Collection.
///
/// The delivery route shuffles entries, but the fixture generator re-sorts them
/// by id so the committed file has a stable diff. The client cannot tell the
/// difference — it is never given the authored order — so the tests below assert
/// against the order as delivered, whatever that is.
final class RendererOrderTests: XCTestCase {
    private let item = "__item(5)"

    private func harness() throws -> RendererHarness {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/delivery-bundle.json")
        return try RendererHarness(bundleJSON: try String(contentsOf: url, encoding: .utf8))
    }

    /// Slice 64: option ids are sealed per attempt, so the client sees opaque
    /// hex and never the authoring ids. Tests read the delivered ids rather
    /// than hardcoding them — which is also the honest shape, since the client
    /// is not supposed to know or care what an id says.
    private func deliveredIDs(_ h: RendererHarness) throws -> [String] {
        let joined = try h.string(
            "BUNDLE.items[5].entries.map(function (e) { return e.id; }).join('|')"
        )
        return joined?.components(separatedBy: "|") ?? []
    }

    private func labels(_ h: RendererHarness) throws -> [String] {
        let joined = try h.string(
            "__all('.order-label', \(item)).map(function (n) { return n.textContent; }).join('|')"
        )
        return joined?.components(separatedBy: "|") ?? []
    }

    func testRendersOneNumberedRowPerEntry() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('.order-row', \(item))"), 4)
        let positions = try h.string(
            "__all('.order-position', \(item)).map(function (n) { return n.textContent; }).join('')"
        )
        XCTAssertEqual(positions, "1.2.3.4.")
        XCTAssertEqual(try labels(h).count, 4)
    }

    /// Up/down buttons rather than drag-to-reorder, so the item is answerable by
    /// keyboard and with assistive technology.
    func testEachRowHasLabelledMoveButtons() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('button', \(item))"), 8)
        XCTAssertEqual(
            try h.string("__all('button', \(item))[0].getAttribute('aria-label')"),
            "Move up"
        )
        XCTAssertEqual(
            try h.string("__all('button', \(item))[1].getAttribute('aria-label')"),
            "Move down"
        )
    }

    func testBoundaryButtonsAreDisabled() throws {
        let h = try harness()
        let ups = "__all('.order-row', \(item)).map(function (r) { return __all('button', r)[0].disabled; })"
        let downs = "__all('.order-row', \(item)).map(function (r) { return __all('button', r)[1].disabled; })"
        XCTAssertTrue(try h.bool("\(ups)[0]"), "first row cannot move up")
        XCTAssertFalse(try h.bool("\(ups)[1]"))
        XCTAssertTrue(try h.bool("\(downs)[3]"), "last row cannot move down")
        XCTAssertFalse(try h.bool("\(downs)[2]"))
    }

    /// The arrangement the student is handed is the server's shuffle, not an
    /// answer they gave — so nothing is posted until they actually move something.
    func testPostsNothingBeforeTheFirstMove() throws {
        let h = try harness()
        XCTAssertEqual(try h.postedMessages().count, 0)
    }

    func testMovingDownSwapsTheRowContentsAndPostsTheNewOrder() throws {
        let h = try harness()
        let before = try labels(h)
        try h.eval("__all('button', __first('.order-row', \(item)))[1].onclick()")

        var expected = before
        expected.swapAt(0, 1)
        XCTAssertEqual(try labels(h), expected)

        let ids = try deliveredIDs(h)
        var expectedIDs = ids
        expectedIDs.swapAt(0, 1)

        let response = try h.postedMessages().last?["response"] as? [String: Any]
        XCTAssertEqual(response?["type"] as? String, "order")
        XCTAssertEqual(response?["ordered_ids"] as? [String], expectedIDs)
    }

    func testMovingUpIsTheInverseOfMovingDown() throws {
        let h = try harness()
        let before = try labels(h)
        try h.eval("__all('button', __all('.order-row', \(item))[0])[1].onclick()")
        try h.eval("__all('button', __all('.order-row', \(item))[1])[0].onclick()")
        XCTAssertEqual(try labels(h), before)
        XCTAssertEqual(
            (try h.postedMessages().last?["response"] as? [String: Any])?["ordered_ids"] as? [String],
            try deliveredIDs(h)
        )
    }

    /// Rows stay put and their contents move. If the list were rebuilt instead,
    /// focus would be dropped after every press, turning a four-item reorder into
    /// a navigation puzzle for a keyboard-only student.
    func testRowElementsAreReusedAcrossMoves() throws {
        let h = try harness()
        try h.eval("var firstRowBefore = __first('.order-row', \(item));")
        try h.eval("__all('button', __first('.order-row', \(item)))[1].onclick()")
        XCTAssertTrue(
            try h.bool("firstRowBefore === __first('.order-row', \(item))"),
            "the row element must be the same object after a move"
        )
    }

    func testMovingPastTheEndsIsARefusalNotACrash() throws {
        let h = try harness()
        let before = try labels(h)
        // The buttons are disabled at the boundaries, but the guard in move()
        // is what makes that safe rather than merely tidy.
        try h.eval("__all('button', __all('.order-row', \(item))[0])[0].onclick()")
        try h.eval("__all('button', __all('.order-row', \(item))[3])[1].onclick()")
        XCTAssertEqual(try labels(h), before)
        XCTAssertEqual(try h.postedMessages().count, 0)
    }

    func testPostedIDsAlwaysCoverEveryEntry() throws {
        let h = try harness()
        try h.eval("__all('button', __all('.order-row', \(item))[2])[1].onclick()")
        let ids = (try h.postedMessages().last?["response"] as? [String: Any])?["ordered_ids"]
            as? [String]
        XCTAssertEqual(ids?.count, 4)
        XCTAssertEqual(Set(ids ?? []), Set(try deliveredIDs(h)))
    }

    /// The authoring ids must not reach the client at all — e1/e2/e3 are
    /// assigned in authored sequence, so their ordering IS the answer.
    func testDeliveredIDsAreSealedRatherThanAuthoringIDs() throws {
        let h = try harness()
        for id in try deliveredIDs(h) {
            XCTAssertEqual(id.count, 24)
            XCTAssertFalse(["e1", "e2", "e3", "e4"].contains(id))
        }
    }
}
