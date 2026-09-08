import XCTest
@testable import SecureTestCore

/// Drawing tools — pen size, colour, eraser, undo
/// (`docs/drawing-tools-design.md`, slice 1; decisions D-1…D-7).
///
/// Everything here is asserted on the DOM the renderer builds and on the
/// recorded 2D-context ops: pixels are not testable in this package (ADR 0013),
/// so what an erased-and-under-painted region actually LOOKS like is a hand-run
/// row (slice 3). What is testable is that the right widths, colours and
/// compositing modes reach the context in the right order, and that undo
/// replays the list rather than guessing.
final class RendererDrawingToolsTests: XCTestCase {
    private let item = "__item(\(DrawingFixture.index))"
    private let tools = "__first('.drawing-tools', __item(\(DrawingFixture.index)))"
    private let controls = "__first('.drawing-controls', __item(\(DrawingFixture.index)))"

    // MARK: - harnesses and helpers

    /// The generated fixture untouched — which asks for an `axes` background,
    /// the case the eraser's under-paint has the most to put back.
    private func axesHarness() throws -> RendererHarness {
        try RendererHarness(
            bundleJSON: String(decoding: try DrawingFixture.json(), as: UTF8.self)
        )
    }

    private func harness(background: String?, saved: Bool = false) throws -> RendererHarness {
        try RendererHarness(
            bundleJSON: try DrawingFixture.bundleJSON(background: background, saved: saved)
        )
    }

    private func ops(_ h: RendererHarness) throws -> [String] {
        let json = try XCTUnwrap(h.string("""
        JSON.stringify(__first('canvas', \(item)).__ops.map(function (o) {
          return JSON.stringify(o);
        }))
        """))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String])
    }

    /// A press-move-release on the canvas, in canvas coordinates (the shim's
    /// bounding box is the canvas's own size, so client coordinates map 1:1).
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

    private func labels(_ h: RendererHarness) throws -> [String] {
        let json = try XCTUnwrap(h.string("""
        JSON.stringify(__all('button', \(tools)).map(function (b) { return b.textContent; }))
        """))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String])
    }

    private func pressedStates(_ h: RendererHarness) throws -> [String] {
        let json = try XCTUnwrap(h.string("""
        JSON.stringify(__all('button', \(tools)).map(function (b) {
          var v = b.getAttribute('aria-pressed');
          return v === null ? '-' : v;
        }))
        """))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String])
    }

    // MARK: - the toolbar

    /// Reading order is tab order: tool, size, colour, then Undo at the end
    /// (D-7). The strip sits above the canvas, so it is reached before the
    /// surface it controls and cannot be pushed off screen by a tall canvas.
    func testTheToolbarOffersTenButtonsInReadingOrder() throws {
        let h = try axesHarness()
        XCTAssertEqual(try h.string("\(tools).getAttribute('role')"), "toolbar")
        XCTAssertEqual(try h.string("\(tools).getAttribute('aria-label')"), "Drawing tools")
        XCTAssertEqual(try labels(h), [
            "Pen", "Eraser", "Thin", "Medium", "Thick",
            "Black", "Red", "Blue", "Green", "Undo",
        ])
        // Above the canvas, below any prompt image.
        XCTAssertEqual(
            try h.string("""
            JSON.stringify(__first('.drawing', \(item)).children.map(function (c) {
              return c.className || c.tagName;
            }))
            """),
            #"["drawing-tools","drawing-canvas","drawing-controls"]"#
        )
    }

    /// Pen and Medium and Black are pressed to start — Medium is today's 2.5 px
    /// pen and Black is today's ink, so a student who touches nothing draws
    /// exactly what they drew before this slice.
    func testTheDefaultsArePenMediumBlackAndUndoDisabled() throws {
        let h = try axesHarness()
        XCTAssertEqual(try pressedStates(h), [
            "true", "false",            // Pen
            "false", "true", "false",   // Medium
            "true", "false", "false", "false", // Black
            "-",                        // Undo is not a toggle
        ])
        XCTAssertTrue(try h.bool("__all('button', \(tools))[9].disabled"))
        // Every colour carries its ink as a swatch AND its name in text.
        XCTAssertEqual(try h.int("__count('.drawing-swatch', \(tools))"), 4)
        XCTAssertEqual(
            try h.string("__all('.drawing-swatch', \(tools))[1].style.background"),
            "#c8102e"
        )
    }

    /// The commit-and-destroy row below the canvas is untouched by the slice —
    /// same two buttons, same copy, same place.
    func testTheControlsRowStillHoldsOnlyClearAndSave() throws {
        let h = try axesHarness()
        XCTAssertEqual(try h.int("__count('button', \(controls))"), 2)
        XCTAssertEqual(try h.string("__all('button', \(controls))[0].textContent"), "Clear")
        XCTAssertEqual(try h.string("__all('button', \(controls))[1].textContent"), "Save drawing")
    }

    func testTheCanvasCanHoldFocusAndIsNamed() throws {
        let h = try axesHarness()
        XCTAssertEqual(try h.string("__first('canvas', \(item)).getAttribute('tabindex')"), "0")
        XCTAssertEqual(
            try h.string("__first('canvas', \(item)).getAttribute('aria-label')"),
            "Drawing area"
        )
    }

    // MARK: - size and colour

    func testChoosingThickSetsTheLineWidthBeforeTheStroke() throws {
        let h = try harness(background: nil)
        try press(h, "Thick")
        try draw(h)
        let recorded = try ops(h)
        let down = try XCTUnwrap(recorded.lastIndex(of: #"["beginPath"]"#))
        XCTAssertEqual(recorded[down - 3], #"["lineWidth",5]"#)
        XCTAssertEqual(try pressedStates(h)[4], "true")
        XCTAssertEqual(try pressedStates(h)[3], "false")
    }

    func testChoosingRedSetsTheStrokeStyleBeforeTheStroke() throws {
        let h = try harness(background: nil)
        try press(h, "Red")
        try draw(h)
        let recorded = try ops(h)
        let down = try XCTUnwrap(recorded.lastIndex(of: #"["beginPath"]"#))
        XCTAssertEqual(recorded[down - 2], ##"["strokeStyle","#c8102e"]"##)
        XCTAssertEqual(try pressedStates(h)[6], "true")
        XCTAssertEqual(try pressedStates(h)[5], "false")
    }

    // MARK: - the eraser

    /// D-3. The eraser cuts to transparent: painting the paper colour would
    /// leave white blobs with the grid missing, and would turn a blank canvas's
    /// transparent PNG into a blotched one. Its width is 4x the pen's at the
    /// same size, so Medium is 10.
    func testTheEraserDisablesTheColoursAndCutsToTransparent() throws {
        let h = try harness(background: nil)
        try press(h, "Eraser")
        XCTAssertEqual(try pressedStates(h)[1], "true")
        XCTAssertEqual(try pressedStates(h)[0], "false")
        for index in 5...8 {
            XCTAssertTrue(try h.bool("__all('button', \(tools))[\(index)].disabled"), "colour \(index)")
        }

        let before = try ops(h).count
        try draw(h)
        let recorded = Array(try ops(h)[before...])
        XCTAssertEqual(recorded[0], #"["lineWidth",10]"#)
        XCTAssertEqual(recorded[2], #"["globalCompositeOperation","destination-out"]"#)
        XCTAssertTrue(recorded.contains(#"["stroke"]"#))
        // The normal mode is back by the end of the stroke, so the next pen
        // stroke paints rather than erases.
        XCTAssertEqual(recorded.last, #"["globalCompositeOperation","source-over"]"#)
    }

    /// The paper goes back UNDER the hole the eraser made, with the paint run in
    /// reverse — under `destination-over` the first thing painted wins, so the
    /// axes go down first and the opaque paper last.
    func testTheEraserPutsThePaperBackUnderTheHoleInReverseOrder() throws {
        let h = try axesHarness()
        try press(h, "Eraser")
        let before = try ops(h).count
        try draw(h)
        let recorded = Array(try ops(h)[before...])

        let under = try XCTUnwrap(recorded.firstIndex(of: #"["globalCompositeOperation","destination-over"]"#))
        // The axes are painted in the pen's colour at 1.5 px; the grid lines
        // follow; the paper fills last.
        let axes = try XCTUnwrap(recorded[under...].firstIndex(of: #"["lineWidth",1.5]"#))
        let lines = try XCTUnwrap(recorded[under...].firstIndex(of: ##"["strokeStyle","#b8c0cc"]"##))
        let paper = try XCTUnwrap(recorded[under...].firstIndex(of: #"["fillRect",0,0,1000,700]"#))
        let back = try XCTUnwrap(recorded[under...].firstIndex(of: #"["globalCompositeOperation","source-over"]"#))
        XCTAssertTrue(under < axes, "the axes go under first")
        XCTAssertTrue(axes < lines, "then the grid lines")
        XCTAssertTrue(lines < paper, "then the opaque paper, last of all")
        XCTAssertTrue(paper < back, "and the normal mode comes back after the paint")
        // Mid-stroke, not only at the end: a student on a dark contrast set
        // would otherwise see the page ground through the hole while erasing.
        XCTAssertEqual(recorded.filter { $0 == #"["globalCompositeOperation","destination-over"]"# }.count, 2)
        // The eraser's own path is restarted after each under-paint, so the
        // band stays continuous.
        XCTAssertEqual(
            recorded.filter { $0 == #"["globalCompositeOperation","destination-out"]"# }.count,
            2
        )
    }

    /// A blank canvas has no paper to put back — its blank state IS transparent,
    /// and painting white here would change the PNG's shape for the teacher.
    func testTheEraserOnABlankCanvasPutsNothingBack() throws {
        let h = try harness(background: nil)
        try press(h, "Eraser")
        let before = try ops(h).count
        try draw(h)
        let recorded = Array(try ops(h)[before...])
        XCTAssertFalse(recorded.contains(#"["globalCompositeOperation","destination-over"]"#))
        XCTAssertEqual(recorded.filter { $0.hasPrefix("[\"fillRect\"") }, [])
        XCTAssertEqual(recorded.filter { $0.hasPrefix("[\"fillStyle\"") }, [])
        // The mode still comes back, from the caller rather than from the paint.
        XCTAssertEqual(recorded.last, #"["globalCompositeOperation","source-over"]"#)
    }

    // MARK: - undo

    /// Undo pops the last stroke and replays the rest: clear, the paper, then
    /// what is left. The bitmap alone could not have done this.
    func testUndoReplaysTheStrokesThatAreLeft() throws {
        let paint = Array(try ops(try axesHarness()).dropFirst(4))
        let h = try axesHarness()
        try draw(h, from: (10, 20), to: (30, 40))
        try draw(h, from: (50, 60), to: (70, 80))
        XCTAssertFalse(try h.bool("__all('button', \(tools))[9].disabled"))

        let before = try ops(h).count
        try press(h, "Undo")
        let replay = Array(try ops(h)[before...])
        XCTAssertEqual(replay[0], #"["clearRect"]"#)
        XCTAssertEqual(Array(replay[1..<(1 + paint.count)]), paint)

        let strokes = Array(replay[(1 + paint.count)...])
        // Exactly one stroke replayed: the first one, with its own width,
        // colour and compositing mode, then the under-paint's mode reset.
        XCTAssertEqual(strokes.prefix(7), [
            #"["lineWidth",2.5]"#,
            ##"["strokeStyle","#1c1c1e"]"##,
            #"["globalCompositeOperation","source-over"]"#,
            #"["beginPath"]"#,
            #"["moveTo",10,20]"#,
            #"["lineTo",30,40]"#,
            #"["stroke"]"#,
        ])

        try press(h, "Undo")
        XCTAssertTrue(try h.bool("__all('button', \(tools))[9].disabled"))
    }

    /// Undoing back to nothing makes the item unanswered again — the guard is
    /// "is there any pen stroke", not "was there ever one".
    func testUndoingEverythingMakesTheItemUnansweredAgain() throws {
        let h = try axesHarness()
        try draw(h)
        try press(h, "Undo")
        XCTAssertFalse(try h.bool("__first('canvas', \(item)).__markedForTest()"))
        try h.eval("__all('button', \(controls))[1].onclick();")
        XCTAssertEqual(try h.postedUploads().count, 0)
        XCTAssertEqual(
            try h.string("__first('.drawing-status', \(item)).textContent"),
            "Draw something first."
        )
    }

    /// Rubbing at a blank canvas is not an answer either.
    func testEraserOnlyWorkOnABlankCanvasIsNotAnAnswer() throws {
        let h = try axesHarness()
        try press(h, "Eraser")
        try draw(h)
        XCTAssertFalse(try h.bool("__first('canvas', \(item)).__markedForTest()"))
        try h.eval("__all('button', \(controls))[1].onclick();")
        XCTAssertEqual(try h.postedUploads().count, 0)
        XCTAssertEqual(
            try h.string("__first('.drawing-status', \(item)).textContent"),
            "Draw something first."
        )
    }

    // MARK: - Clear

    /// D-4: Clear is not undoable. It empties the list as well as the pixels,
    /// so Undo has nothing left to take back, and it repaints today's paint —
    /// no under-paint, no compositing change.
    func testClearEmptiesTheStrokeListAndRepaintsAsBefore() throws {
        let paint = Array(try ops(try axesHarness()).dropFirst(4))
        let h = try axesHarness()
        try draw(h)
        try h.eval("__all('button', \(controls))[0].onclick();")
        XCTAssertTrue(try h.bool("__all('button', \(tools))[9].disabled"))

        let recorded = try ops(h)
        let clearAt = try XCTUnwrap(recorded.lastIndex(of: #"["clearRect"]"#))
        XCTAssertEqual(Array(recorded[(clearAt + 1)...]), paint)
        XCTAssertFalse(try h.bool("__first('canvas', \(item)).__markedForTest()"))
    }

    // MARK: - Cmd-Z

    /// D-5: read on the item's own wrap, so two drawing items cannot undo each
    /// other and a Cmd-Z in the essay's textarea is untouched. Nothing is
    /// installed on the document — the order item's Escape handler is the only
    /// page-level key the renderer takes.
    func testCommandZUndoesOnTheItemAndNotOnTheDocument() throws {
        let h = try axesHarness()
        try draw(h)
        XCTAssertFalse(try h.bool("__all('button', \(tools))[9].disabled"))

        let prevented = try h.bool("""
        (function () {
          var called = false;
          __first('.drawing', \(item)).onkeydown({
            key: 'z', metaKey: true, preventDefault: function () { called = true; }
          });
          return called;
        })()
        """)
        XCTAssertTrue(prevented, "the key is consumed, not left to WebKit")
        XCTAssertTrue(try h.bool("__all('button', \(tools))[9].disabled"))
    }

    /// Cmd-Shift-Z is Redo elsewhere and there is no Redo here (D-5), and a
    /// bare `z` is a letter someone may be typing in another field.
    func testOnlyPlainCommandZUndoes() throws {
        let h = try axesHarness()
        try draw(h)
        try h.eval("""
        var wrap = __first('.drawing', \(item));
        wrap.onkeydown({ key: 'z' });
        wrap.onkeydown({ key: 'z', metaKey: true, shiftKey: true });
        wrap.onkeydown({ key: 'a', metaKey: true });
        """)
        XCTAssertFalse(try h.bool("__all('button', \(tools))[9].disabled"))
    }

    // MARK: - the restored picture

    /// P-1: a restored drawing is a baseline, not strokes. Undo stops at it, and
    /// a rebuild has to redraw it under whatever strokes are left — otherwise an
    /// undo would silently delete last session's work.
    func testARestoredDrawingIsRedrawnByARebuild() throws {
        let h = try harness(background: "axes", saved: true)
        try draw(h)
        let before = try ops(h).count
        try press(h, "Undo")
        let replay = Array(try ops(h)[before...])
        let clearAt = try XCTUnwrap(replay.firstIndex(of: #"["clearRect"]"#))
        let drawAt = try XCTUnwrap(replay.firstIndex { $0.hasPrefix("[\"drawImage\"") })
        let paperAt = try XCTUnwrap(replay.firstIndex(of: #"["fillRect",0,0,1000,700]"#))
        XCTAssertTrue(clearAt < paperAt, "the paper is repainted first")
        XCTAssertTrue(paperAt < drawAt, "and the saved picture goes on top of it")
        // Still the answer: undo took the new stroke, not the saved picture.
        XCTAssertTrue(try h.bool("__first('canvas', \(item)).__markedForTest()"))
        XCTAssertTrue(try h.bool("__all('button', \(tools))[9].disabled"))
    }

    // MARK: - D-6, the on-screen ground

    /// A blank canvas is transparent, so on a dark contrast set the student drew
    /// dark ink on a dark ground. `--canvas-paper` is white paper behind the
    /// bitmap — declared on `:root` and, unlike the twelve palette tokens,
    /// deliberately NOT redefined by any contrast set. The PNG is unaffected.
    func testTheCanvasPaperTokenIsDeclaredAndNoContrastSetOverridesIt() throws {
        let css = PageShell.baseStyles
        let close = try XCTUnwrap(css.range(of: "\n}\n"))
        XCTAssertTrue(css[..<close.lowerBound].contains("--canvas-paper: #ffffff;"))
        XCTAssertFalse(PageShell.accommodationStyles.contains("--canvas-paper"))
        XCTAssertTrue(
            AssessmentPage.itemStyles.contains("background: var(--canvas-paper);")
        )
    }
}
