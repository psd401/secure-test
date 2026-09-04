import XCTest
@testable import SecureTestCore

/// Slice 68. The drawing item is fixture index 7, with an authored canvas of
/// 1000x700 and no prompt image.
final class RendererDrawingTests: XCTestCase {
    private let item = "__item(7)"

    private func harness(offline: Bool = false) throws -> RendererHarness {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/delivery-bundle.json")
        return try RendererHarness(
            bundleJSON: try String(contentsOf: url, encoding: .utf8),
            offline: offline
        )
    }

    /// The fixture now asks for an `axes` background, whose paint fills the op
    /// stream with grid strokes. The two tests below are about the PEN, so they
    /// run on a variant with the background removed — exactly what they tested
    /// before the background slice. The paint itself is
    /// `RendererDrawingBackgroundTests`.
    private func blankHarness() throws -> RendererHarness {
        try RendererHarness(bundleJSON: try DrawingFixture.bundleJSON(background: nil))
    }

    private func drawAndSave(_ h: RendererHarness) throws {
        try h.eval("""
        var c = __first('canvas', \(item));
        c.onpointerdown({ clientX: 1, clientY: 1 });
        c.onpointerup();
        __all('button', \(item))[1].onclick();
        """)
    }

    func testRendersACanvasAtTheAuthoredSize() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('canvas', \(item))"), 1)
        // A student handed a box of a different shape than the teacher drew for
        // would be answering a different question.
        XCTAssertEqual(try h.int("__first('canvas', \(item)).width"), 1000)
        XCTAssertEqual(try h.int("__first('canvas', \(item)).height"), 700)
    }

    func testFallsBackToADefaultSizeWhenNoCanvasIsAuthored() throws {
        let h = try RendererHarness(bundleJSON: """
        {"test_id":"t","title":"T","items":[{"type":"drawing_upload","id":"i","stem":"s"}]}
        """)
        XCTAssertEqual(try h.int("__first('canvas').width"), 800)
        XCTAssertEqual(try h.int("__first('canvas').height"), 600)
    }

    func testOffersClearAndSave() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('button', \(item))"), 2)
        XCTAssertEqual(try h.string("__all('button', \(item))[0].textContent"), "Clear")
        XCTAssertEqual(try h.string("__all('button', \(item))[1].textContent"), "Save drawing")
    }

    func testPointerStrokesReachTheDrawingContext() throws {
        let h = try blankHarness()
        try h.eval("""
        var c = __first('canvas', \(item));
        c.onpointerdown({ clientX: 10, clientY: 20 });
        c.onpointermove({ clientX: 30, clientY: 40 });
        c.onpointerup();
        """)
        let ops = try h.string("JSON.stringify(__first('canvas', \(item)).__ops)") ?? ""
        XCTAssertTrue(ops.contains("beginPath"))
        XCTAssertTrue(ops.contains("moveTo"))
        XCTAssertTrue(ops.contains("lineTo"))
        XCTAssertTrue(ops.contains("stroke"))
    }

    func testMovingWithoutPressingDrawsNothing() throws {
        let h = try blankHarness()
        try h.eval("__first('canvas', \(item)).onpointermove({ clientX: 5, clientY: 5 });")
        let ops = try h.string("JSON.stringify(__first('canvas', \(item)).__ops)") ?? ""
        XCTAssertFalse(ops.contains("lineTo"))
    }

    /// Handing in a blank canvas looks identical to not answering, and would
    /// cost the student an upload slot to say nothing.
    func testSavingAnUntouchedCanvasIsRefusedWithAnExplanation() throws {
        let h = try harness()
        try h.eval("__all('button', \(item))[1].onclick();")
        XCTAssertEqual(try h.postedUploads().count, 0)
        XCTAssertEqual(
            try h.string("__first('.drawing-status', \(item)).textContent"),
            "Draw something first."
        )
    }

    /// The page's CSP forbids it from making any network request, so the bytes
    /// go to the host on a second channel and the host does the upload.
    func testSavingHandsTheImageToTheHostRatherThanUploadingIt() throws {
        let h = try harness()
        try h.eval("""
        var c = __first('canvas', \(item));
        c.onpointerdown({ clientX: 1, clientY: 1 });
        c.onpointerup();
        __all('button', \(item))[1].onclick();
        """)
        let uploads = try h.postedUploads()
        XCTAssertEqual(uploads.count, 1)
        XCTAssertTrue((uploads[0]["data_url"] as? String)?.hasPrefix("data:image/png;base64,") == true)
        // Nothing went on the ordinary response channel — the response is only
        // written once the host knows the bytes are stored.
        XCTAssertEqual(try h.postedMessages().count, 0)
    }

    func testClearingResetsBothTheCanvasAndTheAnswer() throws {
        let h = try harness()
        try h.eval("""
        var c = __first('canvas', \(item));
        c.onpointerdown({ clientX: 1, clientY: 1 });
        c.onpointerup();
        __all('button', \(item))[0].onclick();
        __all('button', \(item))[1].onclick();
        """)
        // After clearing, the canvas counts as untouched again.
        XCTAssertEqual(try h.postedUploads().count, 0)
        let ops = try h.string("JSON.stringify(__first('canvas', \(item)).__ops)") ?? ""
        XCTAssertTrue(ops.contains("clearRect"))
    }

    /// The student is told their work is saved only once it actually is.
    func testTheHostReportsTheOutcomeBackToTheRightItem() throws {
        let h = try harness()
        let itemID = try h.string("BUNDLE.items[7].id") ?? ""

        try h.eval("window.__secureTestDrawingResult('\(itemID)', true);")
        XCTAssertEqual(try h.string("__first('.drawing-status', \(item)).textContent"), "Saved.")
        XCTAssertEqual(
            try h.string("__first('.drawing-status', \(item)).className"),
            "drawing-status saved"
        )

        try h.eval("window.__secureTestDrawingResult('\(itemID)', false);")
        XCTAssertEqual(
            try h.string("__first('.drawing-status', \(item)).textContent"),
            "Could not save. Tell your teacher."
        )
    }

    /// On the server path the label waits on the host: "Saving…" until
    /// `__secureTestDrawingResult` says otherwise. Pinned so finding 8.5's
    /// offline label cannot leak into the real path.
    func testSavingOnTheServerPathWaitsOnTheHost() throws {
        let h = try harness()
        try drawAndSave(h)
        XCTAssertEqual(try h.string("__first('.drawing-status', \(item)).textContent"), "Saving…")
    }

    /// Finding 8.5: offline the host ignores the upload on purpose, so no
    /// result callback ever arrives. The label states that outcome at once —
    /// and the bytes still go to the host, so its `drawing ignored` log line
    /// (the hand-run evidence in MANUAL-CHECKS) is unchanged.
    func testSavingOfflineSaysSoInsteadOfWaitingForever() throws {
        let h = try harness(offline: true)
        try drawAndSave(h)
        XCTAssertEqual(
            try h.string("__first('.drawing-status', \(item)).textContent"),
            "Offline mode: not saved to a server."
        )
        XCTAssertEqual(try h.string("__first('.drawing-status', \(item)).className"), "drawing-status")
        XCTAssertEqual(try h.postedUploads().count, 1)
    }

    /// A blank canvas is refused the same way offline; the offline label is
    /// for a drawing that would otherwise have been uploaded.
    func testSavingAnUntouchedCanvasOfflineIsStillRefused() throws {
        let h = try harness(offline: true)
        try h.eval("__all('button', \(item))[1].onclick();")
        XCTAssertEqual(try h.postedUploads().count, 0)
        XCTAssertEqual(
            try h.string("__first('.drawing-status', \(item)).textContent"),
            "Draw something first."
        )
    }

    func testAResultForAnUnknownItemIsIgnoredRatherThanThrowing() throws {
        let h = try harness()
        try h.eval("window.__secureTestDrawingResult('no-such-item', true);")
    }

    func testEveryItemTypeNowRenders() throws {
        // The unsupported notice has no remaining users.
        let h = try harness()
        XCTAssertEqual(try h.int("__count('.unsupported')"), 0)
    }
}

/// Slice 69: the per-assessment clipboard policy.
final class ClipboardPolicyTests: XCTestCase {
    private func harness(_ json: String) throws -> RendererHarness {
        try RendererHarness(bundleJSON: json)
    }

    private let locked = """
    {"test_id":"t","title":"T","items":[{"type":"short_text","id":"i","stem":"s"}]}
    """
    private let open = """
    {"test_id":"t","title":"T","allow_clipboard":true,
     "items":[{"type":"short_text","id":"i","stem":"s"}]}
    """

    /// A client that has not heard of this flag — or a server that does not send
    /// it — must stay CLOSED. A secure-testing browser whose default is "open
    /// unless told otherwise" has its default backwards.
    func testAbsenceOfTheFlagMeansLocked() throws {
        let h = try harness(locked)
        XCTAssertTrue(try h.bool("typeof document.oncopy === 'function'"))
        XCTAssertTrue(try h.bool("typeof document.oncut === 'function'"))
        XCTAssertTrue(try h.bool("typeof document.onpaste === 'function'"))
    }

    func testTheHandlersRefuseTheEvent() throws {
        let h = try harness(locked)
        let prevented = try h.bool("""
        (function () {
          var called = false;
          var event = { preventDefault: function () { called = true; } };
          var result = document.oncopy(event);
          return called && result === false;
        })()
        """)
        XCTAssertTrue(prevented)
    }

    func testAnAssessmentThatPermitsItInstallsNoHandlers() throws {
        let h = try harness(open)
        XCTAssertFalse(try h.bool("typeof document.oncopy === 'function'"))
        XCTAssertFalse(try h.bool("typeof document.onpaste === 'function'"))
    }

    func testTheModelDefaultsToLockedToo() throws {
        let bundle = try DeliveryBundle.decode(from: Data(locked.utf8))
        XCTAssertFalse(bundle.allowClipboard)

        let permitted = try DeliveryBundle.decode(from: Data(open.utf8))
        XCTAssertTrue(permitted.allowClipboard)
    }

    /// An explicit false on the wire must not read as "unspecified, so open".
    func testAnExplicitFalseIsHonoured() throws {
        let json = """
        {"test_id":"t","title":"T","allow_clipboard":false,
         "items":[{"type":"short_text","id":"i","stem":"s"}]}
        """
        XCTAssertFalse(try DeliveryBundle.decode(from: Data(json.utf8)).allowClipboard)
        XCTAssertTrue(try harness(json).bool("typeof document.oncopy === 'function'"))
    }
}

/// Slice 73: handing the test in.
final class RendererFinishTests: XCTestCase {
    private func harness(offline: Bool = false) throws -> RendererHarness {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/delivery-bundle.json")
        return try RendererHarness(
            bundleJSON: try String(contentsOf: url, encoding: .utf8),
            offline: offline
        )
    }

    func testThePageOffersExactlyOneWayToHandIn() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('.finish')"), 1)
        XCTAssertEqual(
            try h.string("__first('button', __first('.finish')).textContent"),
            "Finish and hand in"
        )
    }

    /// Its own channel, like drawings, because the page cannot reach the network
    /// and the host has to make the call and then clear the local queue.
    func testHandingInGoesToTheHostRatherThanTheServer() throws {
        let h = try harness()
        try h.eval("__first('button', __first('.finish')).onclick();")
        XCTAssertEqual(try h.postedSubmits().count, 1)
        XCTAssertEqual(try h.postedMessages().count, 0)
    }

    func testTheButtonIsHeldWhileTheHandInIsInFlight() throws {
        let h = try harness()
        try h.eval("__first('button', __first('.finish')).onclick();")
        XCTAssertTrue(try h.bool("__first('button', __first('.finish')).disabled"))
        XCTAssertEqual(try h.string("__first('.finish-status').textContent"), "Handing in…")
    }

    /// Handing in is not something to undo by pressing the button again.
    func testASuccessfulHandInLeavesTheButtonDisabled() throws {
        let h = try harness()
        try h.eval("__first('button', __first('.finish')).onclick(); window.__secureTestSubmitResult(true);")
        XCTAssertTrue(try h.bool("__first('button', __first('.finish')).disabled"))
        XCTAssertEqual(
            try h.string("__first('.finish-status').textContent"),
            "Handed in. You can close the app."
        )
    }

    /// A failure must give the button back — the student has to be able to try
    /// again, and their answers are still on the machine.
    func testAFailedHandInCanBeRetried() throws {
        let h = try harness()
        try h.eval("__first('button', __first('.finish')).onclick(); window.__secureTestSubmitResult(false);")
        XCTAssertFalse(try h.bool("__first('button', __first('.finish')).disabled"))
        XCTAssertEqual(
            try h.string("__first('.finish-status').textContent"),
            "Could not hand in. Tell your teacher."
        )
    }

    /// Finding 8.5: offline the host ignores the hand-in on purpose, so
    /// `__secureTestSubmitResult` never fires and "Handing in…" would stand
    /// forever. The hand-in completes locally: the label says so and the
    /// button stays held, as after a confirmed hand-in. The post still goes,
    /// so the host's `submit ignored` log line (MANUAL-CHECKS) is unchanged.
    func testHandingInOfflineFinishesLocally() throws {
        let h = try harness(offline: true)
        try h.eval("__first('button', __first('.finish')).onclick();")
        XCTAssertTrue(try h.bool("__first('button', __first('.finish')).disabled"))
        XCTAssertEqual(
            try h.string("__first('.finish-status').textContent"),
            "Finished. Offline mode: nothing was sent to a server."
        )
        XCTAssertEqual(try h.postedSubmits().count, 1)
    }
}
