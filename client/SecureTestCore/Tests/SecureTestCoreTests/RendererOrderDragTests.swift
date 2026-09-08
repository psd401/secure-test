import XCTest
@testable import SecureTestCore

/// Client UI pass slice E (D-D2), rebuilt by fix slice S-1 (2026-09-08): the
/// order item is draggable as well as button-operable, and the drag is POINTER
/// tracking rather than HTML5 drag-and-drop.
///
/// The 2026-09-08 sitting found the HTML5 drop never landing inside a real AAC
/// session — `LockedDownWebView` refuses the drag session's destination, so the
/// row lifted and snapped back with nothing moved. Pointer events never become
/// an `NSDraggingSession`, so nothing in that view had to change. There is only
/// one drag path now: a leftover HTML5 handler would be a second chance to
/// reorder differently, and `testNoHTML5DragPathRemains` pins that.
///
/// The point of the rest is that the pointer path and the button path cannot
/// drift: a drop and the equivalent run of Move presses must leave the same
/// ordered ids, and a drag must post exactly once, on its pointerup, never on
/// the pointermove stream.
///
/// What this still cannot prove is what WebKit does with a real pointer inside
/// a locked session — there is no window server here (ADR 0013). That is the
/// first row of "Fix slice S-1…S-5" in `client/MANUAL-CHECKS.md`.
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
        // A whole pointer drag: press on `from`, move to the top or bottom half
        // of `over`, release there. pointermove / pointerup arrive on the row
        // that started the drag, which is what setPointerCapture guarantees in
        // the browser.
        function __drag(from, over, before) {
          var top = __rows[over].getBoundingClientRect().top;
          var y = before ? top + 5 : top + 35;
          var start = __rows[from].getBoundingClientRect();
          __rows[from].onpointerdown({
            clientY: start.top + 20, button: 0, pointerId: 7, target: __rows[from]
          });
          __rows[from].onpointermove({ clientY: y, pointerId: 7 });
          __rows[from].onpointerup({ clientY: y, pointerId: 7 });
        }
        function __press(from) {
          var start = __rows[from].getBoundingClientRect();
          __rows[from].onpointerdown({
            clientY: start.top + 20, button: 0, pointerId: 7, target: __rows[from]
          });
        }
        function __moveTo(from, over, before) {
          var top = __rows[over].getBoundingClientRect().top;
          __rows[from].onpointermove({ clientY: before ? top + 5 : top + 35, pointerId: 7 });
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

    /// No `draggable`, no HTML5 handlers: one path only, and the browser's own
    /// drag machinery is never started.
    func testNoHTML5DragPathRemains() throws {
        let h = try harness()
        XCTAssertEqual(
            try h.string("__all('.order-row', \(item)).map(function (r) { return String(r.getAttribute('draggable')); }).join(',')"),
            "null,null,null,null"
        )
        for handler in ["ondragstart", "ondragover", "ondragleave", "ondrop", "ondragend"] {
            XCTAssertEqual(
                try h.string("typeof __all('.order-row', \(item))[0].\(handler)"),
                "undefined",
                "\(handler) must be gone — no dual path"
            )
        }
        let script = AssessmentPage.rendererScript
        XCTAssertFalse(script.contains("ondragstart"))
        XCTAssertFalse(script.contains("dataTransfer"))
        XCTAssertFalse(AssessmentPage.itemStyles.contains("-webkit-user-drag"))
    }

    func testRowsCarryThePointerHandlersAndTheHint() throws {
        let h = try harness()
        for handler in ["onpointerdown", "onpointermove", "onpointerup", "onpointercancel"] {
            XCTAssertEqual(
                try h.string("typeof __all('.order-row', \(item))[0].\(handler)"),
                "function"
            )
        }
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

    /// A pointer released above the first row, or below the last, still lands
    /// the move it aimed at rather than being discarded.
    func testReleasingPastTheEndsOfTheListClampsToTheEnds() throws {
        let h = try harness()
        let before = try labels(h)
        try h.eval("""
        __press(3);
        __rows[3].onpointermove({ clientY: -50, pointerId: 7 });
        __rows[3].onpointerup({ clientY: -50, pointerId: 7 });
        """)
        XCTAssertEqual(try labels(h).first, before[3])
        XCTAssertEqual(try h.postedMessages().count, 1)
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

    // MARK: - the indicator, cancellation, and the buttons

    func testPointerMoveMarksOneRowAndPostsNothing() throws {
        let h = try harness()
        try h.eval("__press(2);")
        XCTAssertEqual(try h.string("__rows[2].className"), "order-row dragging")

        try h.eval("__moveTo(2, 0, true);")
        XCTAssertEqual(try h.string("__rows[0].className"), "order-row drop-before")
        XCTAssertEqual(try h.string("__rows[2].className"), "order-row dragging")

        try h.eval("__moveTo(2, 0, false);")
        XCTAssertEqual(try h.string("__rows[0].className"), "order-row drop-after",
                       "the bottom half of a row means below it")

        // Only one row is ever marked: moving on clears the previous one.
        try h.eval("__moveTo(2, 1, true);")
        XCTAssertEqual(try h.string("__rows[0].className"), "order-row")
        XCTAssertEqual(try h.string("__rows[1].className"), "order-row drop-before")
        XCTAssertEqual(
            try h.int("__rows.filter(function (r) { return r.className !== 'order-row' && r.className !== 'order-row dragging'; }).length"),
            1
        )

        XCTAssertEqual(try h.postedMessages().count, 0, "pointermove never posts")
    }

    /// The dragged row follows the pointer with a transform; the rows
    /// themselves stay put, so focus and the hit-test geometry do not move.
    func testTheDraggedRowFollowsThePointer() throws {
        let h = try harness()
        try h.eval("__press(0);")
        try h.eval("__rows[0].onpointermove({ clientY: 95, pointerId: 7 });")
        XCTAssertEqual(try h.string("__rows[0].style.transform"), "translateY(75px)")
        try h.eval("__rows[0].onpointerup({ clientY: 95, pointerId: 7 });")
        XCTAssertEqual(try h.string("__rows[0].style.transform"), "")
    }

    func testEscapeMidDragCancels() throws {
        let h = try harness()
        let before = try labels(h)
        try h.eval("""
        __press(2);
        __moveTo(2, 0, true);
        document.onkeydown({ key: 'Escape' });
        """)
        XCTAssertEqual(try labels(h), before, "a cancelled drag moves nothing")
        XCTAssertEqual(try h.postedMessages().count, 0)
        XCTAssertEqual(try h.string("__rows[0].className"), "order-row")
        XCTAssertEqual(try h.string("__rows[2].className"), "order-row")
        XCTAssertEqual(try h.string("__rows[2].style.transform"), "")

        // And a stray release afterwards is ignored rather than replaying the drag.
        try h.eval("__rows[2].onpointerup({ clientY: 5, pointerId: 7 });")
        XCTAssertEqual(try labels(h), before)
        XCTAssertEqual(try h.postedMessages().count, 0)
    }

    func testPointerCancelRestoresAndPostsNothing() throws {
        let h = try harness()
        let before = try labels(h)
        try h.eval("""
        __press(2);
        __moveTo(2, 0, true);
        __rows[2].onpointercancel({ pointerId: 7 });
        """)
        XCTAssertEqual(try labels(h), before)
        XCTAssertEqual(try h.postedMessages().count, 0)
        XCTAssertEqual(try h.string("__rows[0].className"), "order-row")
        XCTAssertEqual(try h.string("__rows[2].className"), "order-row")
    }

    /// A press that starts on a Move button is a button press. If it started a
    /// drag as well, the keyboard path would be unusable with a mouse.
    func testAPressOnAMoveButtonDoesNotStartADrag() throws {
        let h = try harness()
        let before = try labels(h)
        try h.eval("""
        var __btn = __all('button', __rows[2])[0];
        __rows[2].onpointerdown({ clientY: 100, button: 0, pointerId: 7, target: __btn });
        """)
        XCTAssertEqual(try h.string("__rows[2].className"), "order-row", "no drag started")
        try h.eval("__rows[2].onpointermove({ clientY: 5, pointerId: 7 });")
        try h.eval("__rows[2].onpointerup({ clientY: 5, pointerId: 7 });")
        XCTAssertEqual(try labels(h), before)
        XCTAssertEqual(try h.postedMessages().count, 0)

        // The button itself still works.
        try h.eval("__btn.onclick();")
        XCTAssertEqual(try h.postedMessages().count, 1)
    }

    func testARightButtonPressDoesNotStartADrag() throws {
        let h = try harness()
        try h.eval("""
        __rows[2].onpointerdown({ clientY: 100, button: 2, pointerId: 7, target: __rows[2] });
        """)
        XCTAssertEqual(try h.string("__rows[2].className"), "order-row")
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
