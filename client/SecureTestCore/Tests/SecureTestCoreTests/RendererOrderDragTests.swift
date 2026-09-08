import XCTest
@testable import SecureTestCore

/// Client UI pass slice E (D-D2): the order item is draggable as well as
/// button-operable.
///
/// The point of these tests is that the two paths cannot drift. A drag is not
/// allowed to be a second, parallel implementation of reordering — a drop and
/// the equivalent run of Move presses must leave the same ordered ids, and a
/// drag must post exactly once, on its drop, never on the dragover stream.
///
/// What this cannot prove is that WebKit inside `LockedDownWebView` delivers
/// the drop at all: that view unregisters its dragged types, which is aimed at
/// drags in from other apps but may also swallow an in-page drag, and there is
/// no window server here to find out (ADR 0013). That is the AAC row in
/// `client/MANUAL-CHECKS.md`.
final class RendererOrderDragTests: XCTestCase {
    private let item = "__item(5)"

    private func harness() throws -> RendererHarness {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/delivery-bundle.json")
        let h = try RendererHarness(bundleJSON: try String(contentsOf: url, encoding: .utf8))
        // The shim's nodes have no geometry, so the rows are given some: each
        // row is 40 tall, stacked, which is what the top-half / bottom-half
        // reading of the pointer needs to mean anything.
        try h.eval("""
        var __rows = __all('.order-row', \(item));
        __rows.forEach(function (row, i) {
          row.getBoundingClientRect = function () {
            return { top: i * 40, height: 40, left: 0, width: 200 };
          };
        });
        function __drag(from, over, before) {
          var top = __rows[over].getBoundingClientRect().top;
          var y = before ? top + 5 : top + 35;
          var transfer = { data: {}, setData: function (k, v) { this.data[k] = v; } };
          var event = { clientY: y, dataTransfer: transfer, preventDefault: function () {} };
          __rows[from].ondragstart(event);
          __rows[over].ondragover(event);
          __rows[over].ondrop(event);
        }
        """)
        return h
    }

    private func labels(_ h: RendererHarness) throws -> [String] {
        let joined = try h.string(
            "__all('.order-label', \(item)).map(function (n) { return n.textContent; }).join('|')"
        )
        return joined?.components(separatedBy: "|") ?? []
    }

    private func orderedIDs(_ h: RendererHarness) throws -> [String]? {
        (try h.postedMessages().last?["response"] as? [String: Any])?["ordered_ids"] as? [String]
    }

    // MARK: - markup

    func testRowsAreDraggableAndCarryTheHint() throws {
        let h = try harness()
        let flags = try h.string(
            "__all('.order-row', \(item)).map(function (r) { return r.getAttribute('draggable'); }).join(',')"
        )
        XCTAssertEqual(flags, "true,true,true,true")

        XCTAssertEqual(
            try h.string("__first('.order-hint', \(item)).textContent"),
            "Drag to reorder, or use the Move buttons."
        )
        // The hint is the list's accessible description, so the drag affordance
        // is announced without the Move buttons losing their labels.
        XCTAssertEqual(
            try h.string("__first('.order', \(item)).getAttribute('aria-describedby')"),
            try h.string("__first('.order-hint', \(item)).getAttribute('id')")
        )
    }

    func testStatusLineIsPolitelyLiveAndStartsEmpty() throws {
        let h = try harness()
        XCTAssertEqual(
            try h.string("__first('.order-status', \(item)).getAttribute('aria-live')"),
            "polite"
        )
        XCTAssertEqual(try h.string("__first('.order-status', \(item)).textContent"), "")
    }

    /// The keyboard path is unchanged: eight buttons, still labelled, still
    /// disabled at the boundaries.
    func testMoveButtonsSurviveTheDragWiring() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('button', \(item))"), 8)
        XCTAssertEqual(
            try h.string("__all('button', \(item))[0].getAttribute('aria-label')"),
            "Move up"
        )
        XCTAssertTrue(try h.bool("__all('button', __all('.order-row', \(item))[0])[0].disabled"))
    }

    // MARK: - the reorder function both paths share

    /// `reorderIDs` lives inside the renderer's IIFE, so it cannot be called
    /// from the harness — its behaviour is proved by the drop/button
    /// equivalence tests below. What is asserted here is structural: there is
    /// exactly one reorder helper and exactly one call site, so a later change
    /// cannot quietly give dragging a second implementation of the move.
    func testThereIsOneReorderHelperAndOneCaller() throws {
        let script = AssessmentPage.rendererScript
        XCTAssertEqual(
            script.components(separatedBy: "function reorderIDs(").count - 1, 1
        )
        XCTAssertEqual(
            script.components(separatedBy: "entries = reorderIDs(entries, from, to);").count - 1, 1
        )
        // The pure shape is the point: it copies before it splices.
        XCTAssertTrue(script.contains("out.splice(to, 0, out.splice(from, 1)[0]);"))
    }

    /// A drag across two places, then the inverse drag, returns the list to
    /// where it started — the same round trip the Move buttons make.
    func testADragAndItsInverseCancelOut() throws {
        let h = try harness()
        let before = try labels(h)
        try h.eval("__drag(2, 0, true);")
        try h.eval("__drag(0, 2, false);")
        XCTAssertEqual(try labels(h), before)
        XCTAssertEqual(try h.postedMessages().count, 2, "one post per drop, two drops")
    }

    // MARK: - a drop equals the button run it stands for

    func testDropFromTwoToZeroMatchesTwoMoveUpPressesAndPostsOnce() throws {
        let byDrag = try harness()
        try byDrag.eval("__drag(2, 0, true);")

        let byButtons = try harness()
        try byButtons.eval("__all('button', __all('.order-row', \(item))[2])[0].onclick()")
        try byButtons.eval("__all('button', __all('.order-row', \(item))[1])[0].onclick()")

        XCTAssertEqual(try labels(byDrag), try labels(byButtons))
        XCTAssertEqual(try orderedIDs(byDrag), try orderedIDs(byButtons))
        XCTAssertEqual(try byDrag.postedMessages().count, 1, "one post per drop")
        XCTAssertEqual(try byButtons.postedMessages().count, 2)
        XCTAssertEqual(
            (try byDrag.postedMessages().last?["response"] as? [String: Any])?["type"] as? String,
            "order"
        )
    }

    func testDroppingBelowTheLastRowMatchesThreeMoveDownPresses() throws {
        let byDrag = try harness()
        try byDrag.eval("__drag(0, 3, false);")

        let byButtons = try harness()
        for index in 0..<3 {
            try byButtons.eval("__all('button', __all('.order-row', \(item))[\(index)])[1].onclick()")
        }

        XCTAssertEqual(try labels(byDrag), try labels(byButtons))
        XCTAssertEqual(try orderedIDs(byDrag), try orderedIDs(byButtons))
        XCTAssertEqual(try byDrag.postedMessages().count, 1)
    }

    func testDroppingOnTheTopHalfOfTheRowAboveIsASingleStep() throws {
        let h = try harness()
        let before = try labels(h)
        try h.eval("__drag(1, 0, true);")
        var expected = before
        expected.swapAt(0, 1)
        XCTAssertEqual(try labels(h), expected)
    }

    func testEveryEntryStillAppearsExactlyOnceAfterADrop() throws {
        let h = try harness()
        try h.eval("__drag(3, 1, true);")
        let ids = try orderedIDs(h)
        XCTAssertEqual(ids?.count, 4)
        XCTAssertEqual(
            Set(ids ?? []),
            Set((try h.string("BUNDLE.items[5].entries.map(function (e) { return e.id; }).join('|')") ?? "")
                .components(separatedBy: "|"))
        )
    }

    func testDroppingARowOnItselfChangesNothingAndPostsNothing() throws {
        let h = try harness()
        let before = try labels(h)
        try h.eval("__drag(2, 2, true);")
        XCTAssertEqual(try labels(h), before)
        XCTAssertEqual(try h.postedMessages().count, 0)
    }

    // MARK: - the indicator, and Escape

    func testDragoverMarksTheHoveredRowAndPostsNothing() throws {
        let h = try harness()
        try h.eval("""
        var transfer = { setData: function () {} };
        __rows[2].ondragstart({ dataTransfer: transfer, preventDefault: function () {} });
        """)
        XCTAssertEqual(try h.string("__rows[2].className"), "order-row dragging")

        try h.eval("__rows[0].ondragover({ clientY: 5, dataTransfer: transfer, preventDefault: function () {} });")
        XCTAssertEqual(try h.string("__rows[0].className"), "order-row drop-before")

        try h.eval("__rows[0].ondragover({ clientY: 35, dataTransfer: transfer, preventDefault: function () {} });")
        XCTAssertEqual(try h.string("__rows[0].className"), "order-row drop-after",
                       "the bottom half of a row means below it")
        XCTAssertEqual(try h.string("transfer.dropEffect"), "move")

        // Only one row is ever marked: moving on clears the previous one.
        try h.eval("__rows[1].ondragover({ clientY: 45, dataTransfer: transfer, preventDefault: function () {} });")
        XCTAssertEqual(try h.string("__rows[0].className"), "order-row")

        XCTAssertEqual(try h.postedMessages().count, 0, "dragover never posts")
    }

    func testEscapeMidDragCancels() throws {
        let h = try harness()
        let before = try labels(h)
        try h.eval("""
        var transfer = { setData: function () {} };
        __rows[2].ondragstart({ dataTransfer: transfer, preventDefault: function () {} });
        __rows[0].ondragover({ clientY: 5, dataTransfer: transfer, preventDefault: function () {} });
        __rows[2].ondragend();
        """)
        XCTAssertEqual(try labels(h), before, "a cancelled drag moves nothing")
        XCTAssertEqual(try h.postedMessages().count, 0)
        XCTAssertEqual(try h.string("__rows[0].className"), "order-row")
        XCTAssertEqual(try h.string("__rows[2].className"), "order-row")

        // And a stray drop afterwards is ignored rather than replaying the drag.
        try h.eval("__rows[0].ondrop({ clientY: 5, preventDefault: function () {} });")
        XCTAssertEqual(try labels(h), before)
        XCTAssertEqual(try h.postedMessages().count, 0)
    }

    func testDragstartCarriesTheSealedIDAndMoveEffect() throws {
        let h = try harness()
        try h.eval("""
        var transfer = { data: {}, setData: function (k, v) { this.data[k] = v; } };
        __rows[1].ondragstart({ dataTransfer: transfer, preventDefault: function () {} });
        """)
        XCTAssertEqual(try h.string("transfer.effectAllowed"), "move")
        XCTAssertEqual(
            try h.string("transfer.data['text/plain']"),
            try h.string("BUNDLE.items[5].entries[1].id")
        )
    }

    // MARK: - the announcement

    func testADropAndAButtonPressAnnounceTheSameWay() throws {
        let byDrag = try harness()
        try byDrag.eval("__drag(1, 0, true);")

        let byButtons = try harness()
        try byButtons.eval("__all('button', __all('.order-row', \(item))[1])[0].onclick()")

        let spoken = try byDrag.string("__first('.order-status', \(item)).textContent")
        XCTAssertEqual(spoken, try byButtons.string("__first('.order-status', \(item)).textContent"))
        XCTAssertEqual(spoken, (try labels(byDrag).first ?? "") + " moved to position 1 of 4.")
    }
}
