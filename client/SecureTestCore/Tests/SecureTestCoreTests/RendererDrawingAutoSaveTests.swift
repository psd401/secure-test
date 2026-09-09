import XCTest
@testable import SecureTestCore

/// Drawing auto-save (`docs/drawing-tools-design.md` §Auto-save, D-8, slice 2).
///
/// The debounce is a `setTimeout` in the page, and JavaScriptCore has no timers
/// at all, so the harness records what was scheduled and fires it on demand
/// (`__fireTimers` / `__pendingTimers`). That is what makes "nothing is posted
/// before the idle period" and "exactly one timer is pending" assertable here;
/// what five seconds FEELS like to a student is a hand-run row (slice 3).
final class RendererDrawingAutoSaveTests: XCTestCase {
    private let item = "__item(\(DrawingFixture.index))"
    private let tools = "__first('.drawing-tools', __item(\(DrawingFixture.index)))"
    private let controls = "__first('.drawing-controls', __item(\(DrawingFixture.index)))"

    // MARK: - harnesses and helpers

    private func harness(background: String? = "axes", saved: Bool = false, offline: Bool = false) throws -> RendererHarness {
        try RendererHarness(
            bundleJSON: try DrawingFixture.bundleJSON(background: background, saved: saved),
            offline: offline
        )
    }

    /// A press-move-release on the canvas, as `RendererDrawingToolsTests` does
    /// it — the shim's bounding box is the canvas's own size, so client
    /// coordinates map 1:1.
    private func draw(_ h: RendererHarness, from: (Int, Int) = (10, 20), to: (Int, Int) = (30, 40)) throws {
        try h.eval("""
        var c = __first('canvas', \(item));
        c.onpointerdown({ clientX: \(from.0), clientY: \(from.1) });
        c.onpointermove({ clientX: \(to.0), clientY: \(to.1) });
        c.onpointerup();
        """)
    }

    private func press(_ h: RendererHarness, _ label: String) throws {
        try h.eval("""
        __all('button', \(tools)).filter(function (b) {
          return b.textContent === '\(label)';
        })[0].onclick();
        """)
    }

    private func pressSave(_ h: RendererHarness) throws {
        try h.eval("__all('button', \(controls))[1].onclick();")
    }

    private func pressClear(_ h: RendererHarness) throws {
        try h.eval("__all('button', \(controls))[0].onclick();")
    }

    private func fire(_ h: RendererHarness) throws {
        try h.eval("__fireTimers();")
    }

    private func pending(_ h: RendererHarness) throws -> Int {
        try h.int("__pendingTimers()")
    }

    private func status(_ h: RendererHarness) throws -> String? {
        try h.string("__first('.drawing-status', \(item)).textContent")
    }

    /// The host's callback, as `reportDrawing` evaluates it.
    private func result(_ h: RendererHarness, ok: Bool) throws {
        let id = try XCTUnwrap(h.string("BUNDLE.items[\(DrawingFixture.index)].id"))
        try h.eval("window.__secureTestDrawingResult('\(id)', \(ok));")
    }

    // MARK: - the idle debounce

    /// Every save is a full upload — a new slot, a new S3 object — so a stroke
    /// must not post one. Nothing goes until the student has stopped.
    func testAStrokeSchedulesOneSaveAndPostsNothingYet() throws {
        let h = try harness()
        XCTAssertEqual(try pending(h), 0, "an untouched canvas schedules nothing")
        try draw(h)
        XCTAssertEqual(try pending(h), 1)
        XCTAssertEqual(try h.postedUploads().count, 0)
        XCTAssertEqual(try status(h), "")
    }

    /// The timer restarts from zero on every change, so a student still drawing
    /// is never interrupted by an upload — and only ever has one pending.
    func testASecondStrokeReplacesThePendingTimerRatherThanAddingOne() throws {
        let h = try harness()
        try draw(h)
        try draw(h, from: (50, 60), to: (70, 80))
        XCTAssertEqual(try pending(h), 1)
        try fire(h)
        XCTAssertEqual(try h.postedUploads().count, 1)
    }

    func testFiringTheTimerPostsTheDrawingAndSaysSaving() throws {
        let h = try harness()
        try draw(h)
        try fire(h)
        let uploads = try h.postedUploads()
        XCTAssertEqual(uploads.count, 1)
        XCTAssertEqual(
            uploads[0]["item_id"] as? String,
            try h.string("BUNDLE.items[\(DrawingFixture.index)].id")
        )
        XCTAssertEqual(uploads[0]["data_url"] as? String, "data:image/png;base64,SEVMTE8=")
        // The same label the manual path shows, so a save the student did not
        // ask for still reads as one they did.
        XCTAssertEqual(try status(h), "Saving…")
    }

    /// An unchanged picture is not re-uploaded: the flush points fire this same
    /// path constantly, and each one has to be free.
    func testAnUnchangedDrawingIsNotPostedAgain() throws {
        let h = try harness()
        try draw(h)
        try fire(h)
        try result(h, ok: true)
        try h.eval("__first('.drawing', \(item)).__flushDrawing();")
        XCTAssertEqual(try h.postedUploads().count, 1)
    }

    // MARK: - one upload at a time

    /// Two uploads racing for the same item would make "Saved." a guess about
    /// which one landed. While one is out the change is remembered instead, and
    /// the result callback sends it.
    func testAStrokeWhileAnUploadIsOutIsSentWhenTheResultArrives() throws {
        let h = try harness()
        try draw(h)
        try fire(h)
        XCTAssertEqual(try h.postedUploads().count, 1)

        try draw(h, from: (50, 60), to: (70, 80))
        try fire(h)
        XCTAssertEqual(try h.postedUploads().count, 1, "not while one is in flight")

        try result(h, ok: true)
        XCTAssertEqual(try h.postedUploads().count, 2)
        XCTAssertEqual(try status(h), "Saving…")
    }

    /// A failure does not retry itself: a loop against a broken network would
    /// post forever and relabel the status with it. The next change starts the
    /// idle timer again, which is the retry.
    func testAFailedSaveDoesNotRetryItselfButTheNextChangeDoes() throws {
        let h = try harness()
        try draw(h)
        try fire(h)
        try result(h, ok: false)
        XCTAssertEqual(try h.postedUploads().count, 1)
        XCTAssertEqual(try status(h), "Could not save. Tell your teacher.")

        try draw(h, from: (50, 60), to: (70, 80))
        XCTAssertEqual(try pending(h), 1)
        try fire(h)
        XCTAssertEqual(try h.postedUploads().count, 2)
    }

    // MARK: - what counts as a change

    func testUndoSchedulesASave() throws {
        let h = try harness()
        try draw(h)
        try draw(h, from: (50, 60), to: (70, 80))
        try fire(h)
        try result(h, ok: true)
        XCTAssertEqual(try h.postedUploads().count, 1)

        try press(h, "Undo")
        XCTAssertEqual(try pending(h), 1, "the picture changed, so it is saved again")
        try fire(h)
        XCTAssertEqual(try h.postedUploads().count, 2)
    }

    /// Undoing back to nothing leaves nothing to upload: a blank PNG is not an
    /// answer, and the server keeps the last picture that WAS saved.
    func testUndoingEverythingSchedulesNothingAndPostsNothing() throws {
        let h = try harness()
        try draw(h)
        try press(h, "Undo")
        XCTAssertEqual(try pending(h), 0)
        try fire(h)
        XCTAssertEqual(try h.postedUploads().count, 0)
    }

    /// Same reason, and it also has to cancel the save that the ink scheduled —
    /// otherwise the cleared canvas would be uploaded five seconds later.
    func testClearWithInkCancelsThePendingSaveAndSchedulesNothing() throws {
        let h = try harness()
        try draw(h)
        XCTAssertEqual(try pending(h), 1)
        try pressClear(h)
        XCTAssertEqual(try pending(h), 0)
        try fire(h)
        XCTAssertEqual(try h.postedUploads().count, 0)
    }

    func testClearOnAnUntouchedCanvasSchedulesNothing() throws {
        let h = try harness()
        try pressClear(h)
        XCTAssertEqual(try pending(h), 0)
        try fire(h)
        XCTAssertEqual(try h.postedUploads().count, 0)
    }

    /// Rubbing at a blank canvas is not an answer (slice 1's `marked` rule), so
    /// it is not something to upload either.
    func testEraserOnlyWorkOnABlankCanvasSchedulesNothing() throws {
        let h = try harness()
        try press(h, "Eraser")
        try draw(h)
        XCTAssertEqual(try pending(h), 0)
        try fire(h)
        XCTAssertEqual(try h.postedUploads().count, 0)
    }

    // MARK: - the manual button

    /// The Save drawing button is the student's way to force a save now — and
    /// it goes through the same single flight, so pressing it while an upload is
    /// out queues rather than races.
    func testManualSaveWhileAnUploadIsOutPostsOnceAfterTheCallback() throws {
        let h = try harness()
        try draw(h)
        try fire(h)
        XCTAssertEqual(try h.postedUploads().count, 1)

        try pressSave(h)
        XCTAssertEqual(try h.postedUploads().count, 1, "not two at once")
        XCTAssertEqual(try status(h), "Saving…")

        try result(h, ok: true)
        XCTAssertEqual(try h.postedUploads().count, 2)
    }

    /// Its copy and its guard are unchanged by the slice.
    func testManualSaveStillGuardsAnUntouchedCanvas() throws {
        let h = try harness()
        try pressSave(h)
        XCTAssertEqual(try h.postedUploads().count, 0)
        XCTAssertEqual(try status(h), "Draw something first.")
    }

    /// Pressing it takes the pending timer with it: the picture it just posted
    /// is the one the timer would have sent.
    func testManualSaveCancelsThePendingTimer() throws {
        let h = try harness()
        try draw(h)
        try pressSave(h)
        XCTAssertEqual(try pending(h), 0)
        XCTAssertEqual(try h.postedUploads().count, 1)
        try fire(h)
        XCTAssertEqual(try h.postedUploads().count, 1)
    }

    // MARK: - offline

    /// Offline every save is ignored by the host and relabelled, so auto-saving
    /// would only lie to the student. The button still posts — the host's
    /// "drawing ignored" line is the hand-run evidence — and still labels the
    /// outcome itself, because no callback will ever arrive.
    func testNothingAutoSavesOfflineButTheButtonStillPosts() throws {
        let h = try harness(offline: true)
        try draw(h)
        try fire(h)
        XCTAssertEqual(try h.postedUploads().count, 0)

        try pressSave(h)
        XCTAssertEqual(try h.postedUploads().count, 1)
        XCTAssertEqual(try status(h), "Offline mode: not saved to a server.")
        // Offline the button keeps working every time: there is no in-flight
        // state to wedge, because nothing ever calls back.
        try pressSave(h)
        XCTAssertEqual(try h.postedUploads().count, 2)
    }

    // MARK: - flush points

    /// Finish flushes BEFORE the submit goes: a drawing changed in the last five
    /// seconds would otherwise be handed in unsaved. The host's upload gate
    /// (`UploadGate`) is the other half of the same rule.
    func testFinishFlushesTheDrawingBeforeItSubmits() throws {
        let h = try harness()
        try draw(h)
        try h.eval("__first('.finish').children[0].onclick();")
        XCTAssertEqual(try h.postedUploads().count, 1, "the drawing went")
        XCTAssertEqual(try h.postedSubmits().count, 1)
        // Ordering: the upload is posted from inside the click handler before
        // the submit message is, so the host sees it first.
        XCTAssertEqual(
            try h.int("__uploads.length"),
            1,
            "the upload channel carries it, not the submit channel"
        )
        XCTAssertEqual(try status(h), "Saving…")
    }

    func testFinishPostsNoUploadWhenNothingIsDirty() throws {
        let h = try harness()
        try h.eval("__first('.finish').children[0].onclick();")
        XCTAssertEqual(try h.postedUploads().count, 0)
        XCTAssertEqual(try h.postedSubmits().count, 1)
    }

    /// Focus leaving the item is a save point; focus moving between the toolbar
    /// and the canvas inside it is not.
    func testFocusLeavingTheItemFlushesAndFocusInsideItDoesNot() throws {
        let inside = try harness()
        try draw(inside)
        try inside.eval("""
        var wrap = __first('.drawing', \(item));
        wrap.onfocusout({ relatedTarget: __first('canvas', \(item)) });
        """)
        XCTAssertEqual(try inside.postedUploads().count, 0)
        XCTAssertEqual(try pending(inside), 1, "still waiting out the idle period")

        let away = try harness()
        try draw(away)
        try away.eval("""
        __first('.drawing', \(item)).onfocusout({ relatedTarget: __first('.finish') });
        """)
        XCTAssertEqual(try away.postedUploads().count, 1)
        XCTAssertEqual(try pending(away), 0)
    }

    // MARK: - paged

    /// A page turn hides the drawing, so it saves at once rather than waiting
    /// out its timer — the student has visibly moved on.
    func testTurningThePageFlushesADirtyDrawing() throws {
        var json = try DrawingFixture.bundleJSON(background: "axes")
        let range = try XCTUnwrap(json.range(of: "\"test_id\":"))
        json.replaceSubrange(range, with: "\"layout\": \"paged\", \"test_id\":")
        let h = try RendererHarness(bundleJSON: json)

        // The drawing is item 7 of nine, which paged is page 8 (Q1, passage,
        // Q2 … Q9, review).
        try h.eval("__all('button', __first('.pager-strip'))[8].onclick()")
        XCTAssertEqual(
            try h.string("__first('.pager-current').textContent"),
            "Question 8 of 9"
        )
        try draw(h)
        XCTAssertEqual(try h.postedUploads().count, 0)

        try h.eval("__first('.pager-next').onclick()")
        XCTAssertEqual(try h.postedUploads().count, 1)
        XCTAssertEqual(try pending(h), 0)
    }
}
