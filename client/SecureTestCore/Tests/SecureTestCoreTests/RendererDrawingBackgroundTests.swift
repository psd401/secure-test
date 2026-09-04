import XCTest
@testable import SecureTestCore

/// The fixture bundle rebuilt with a different drawing background.
///
/// Rebuilt through `JSONSerialization` rather than by editing the file's text,
/// so a variant does not depend on how the generator happens to format the
/// canvas block. Shared with `RendererDrawingTests`, whose pen assertions have
/// to run on a canvas that paints nothing.
enum DrawingFixture {
    /// The drawing item's index in the generated fixture (1000 x 700, no
    /// prompt image), matching `RendererPrefillTests.Index`.
    static let index = 7
    static let uploadID = "11111111-1111-4111-8111-111111111111"
    /// The harness canvas's own `toDataURL` payload, reused as stored bytes.
    static let pngBase64 = "SEVMTE8="

    static func json() throws -> Data {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/delivery-bundle.json")
        return try Data(contentsOf: url)
    }

    /// `background: nil` removes the key entirely — a bundle from a design tool
    /// that has never heard of backgrounds, which is every bundle before this
    /// slice. `saved` injects a restored drawing (the P-1 shape).
    static func bundleJSON(background: String?, saved: Bool = false) throws -> String {
        var root = try XCTUnwrap(
            JSONSerialization.jsonObject(with: try json()) as? [String: Any]
        )
        var items = try XCTUnwrap(root["items"] as? [[String: Any]])
        var drawing = items[index]
        var canvas = try XCTUnwrap(drawing["canvas"] as? [String: Any])
        if let background {
            canvas["background"] = background
        } else {
            canvas.removeValue(forKey: "background")
        }
        drawing["canvas"] = canvas
        items[index] = drawing
        root["items"] = items
        if saved {
            let id = try XCTUnwrap(drawing["id"] as? String)
            root["saved_responses"] = [
                id: ["type": "drawing_upload", "upload_id": uploadID]
            ]
            root["saved_uploads"] = [
                uploadID: ["content_type": "image/png", "base64": pngBase64]
            ]
        }
        let data = try JSONSerialization.data(withJSONObject: root)
        return String(decoding: data, as: UTF8.self)
    }
}

/// Drawing background — grid and axes (docs/drawing-background-design.md,
/// slice 2). The paper is painted INTO the canvas before any stroke, so these
/// assertions are on the recorded 2D-context ops; pixels are not testable here
/// (ADR 0013) and are a hand-run row.
final class RendererDrawingBackgroundTests: XCTestCase {
    private let item = "__item(\(DrawingFixture.index))"
    private let canvasWidth = 1000
    private let canvasHeight = 700

    // MARK: - geometry, from the design page

    /// Cell = 40 canvas px, lines on the half pixel so a 1 px stroke lands on
    /// one pixel row, and a line for every whole cell start still inside the
    /// canvas:
    ///
    ///     lines(span) = #{ n >= 0 : n * 40 + 0.5 < span }
    ///
    /// 1000 -> 25 (0.5 … 960.5) and 700 -> 18 (0.5 … 680.5); the 700 px canvas
    /// therefore ends on a half cell, which the design page accepts rather than
    /// varying the cell size per canvas. Every fifth line (indexes 0, 5, 10 …)
    /// is the darker one, so majors(n) = ceil(n / 5).
    private func lines(_ span: Int) -> Int {
        var n = 0
        while Double(n) * 40 + 0.5 < Double(span) { n += 1 }
        return n
    }

    private func majors(_ lines: Int) -> Int { (lines + 4) / 5 }

    // MARK: - harnesses

    private func harness(background: String?, saved: Bool = false) throws -> RendererHarness {
        try RendererHarness(
            bundleJSON: try DrawingFixture.bundleJSON(background: background, saved: saved)
        )
    }

    /// The fixture exactly as generated — which asks for `axes`.
    private func fixtureHarness() throws -> RendererHarness {
        try RendererHarness(
            bundleJSON: String(decoding: try DrawingFixture.json(), as: UTF8.self)
        )
    }

    /// Every recorded context call, each as its own JSON string, so a test can
    /// compare ops literally instead of by substring.
    private func ops(_ h: RendererHarness) throws -> [String] {
        let json = try XCTUnwrap(h.string("""
        JSON.stringify(__first('canvas', \(item)).__ops.map(function (o) {
          return JSON.stringify(o);
        }))
        """))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String])
    }

    private func count(_ ops: [String], _ op: String) -> Int {
        ops.filter { $0.hasPrefix("[\"\(op)\"") }.count
    }

    private func background(_ h: RendererHarness) throws -> String? {
        try h.string("__first('canvas', \(item)).getAttribute('data-background')")
    }

    /// The four ops the pen setup has always recorded, and all a blank canvas
    /// may ever record at build time.
    private let penSetup = [
        #"["lineWidth",2.5]"#,
        #"["lineCap","round"]"#,
        #"["lineJoin","round"]"#,
        ##"["strokeStyle","#1c1c1e"]"##
    ]

    // MARK: - blank stays exactly as it was

    /// No background, and a value this build has not heard of, both paint
    /// NOTHING — not even white paper. Asserted as the literal op list so a
    /// bundle from before this slice is provably unchanged, byte for byte.
    func testABlankCanvasPaintsNothingAtAll() throws {
        for background in [nil, "dots"] as [String?] {
            let h = try harness(background: background)
            XCTAssertNil(try self.background(h), "asked for \(background ?? "nothing")")
            XCTAssertEqual(try ops(h), penSetup, "asked for \(background ?? "nothing")")
        }
    }

    // MARK: - grid

    func testGridPaintsPaperThenTheDerivedNumberOfLines() throws {
        let h = try harness(background: "grid")
        XCTAssertEqual(try background(h), "grid")

        let recorded = try ops(h)
        // The pen setup still comes first; the paint follows it.
        XCTAssertEqual(Array(recorded.prefix(4)), penSetup)
        XCTAssertEqual(recorded[4], ##"["fillStyle","#ffffff"]"##)
        XCTAssertEqual(recorded[5], #"["fillRect",0,0,1000,700]"#)

        let columns = lines(canvasWidth)
        let rows = lines(canvasHeight)
        XCTAssertEqual(columns, 25)
        XCTAssertEqual(rows, 18)
        let total = columns + rows
        let major = majors(columns) + majors(rows)
        XCTAssertEqual(major, 9)

        XCTAssertEqual(count(recorded, "moveTo"), total)
        XCTAssertEqual(count(recorded, "lineTo"), total)

        // Two passes, one per colour: the minor lines, then every fifth line
        // darker. Grouping by colour is what makes the colour change assertable
        // without reading pixels.
        let majorAt = try XCTUnwrap(recorded.firstIndex(of: ##"["strokeStyle","#b8c0cc"]"##))
        XCTAssertEqual(count(Array(recorded[..<majorAt]), "moveTo"), total - major)
        XCTAssertEqual(count(Array(recorded[majorAt...]), "moveTo"), major)
        XCTAssertEqual(recorded.filter { $0.hasPrefix("[\"strokeStyle\"") }, [
            ##"["strokeStyle","#1c1c1e"]"##,  // pen setup
            ##"["strokeStyle","#dfe3ea"]"##,  // minor lines
            ##"["strokeStyle","#b8c0cc"]"##,  // every fifth
            ##"["strokeStyle","#1c1c1e"]"##   // pen handed back
        ])
        XCTAssertEqual(count(recorded, "beginPath"), 2)
        XCTAssertEqual(count(recorded, "stroke"), 2)

        // Nothing else is recorded: 4 setup + paper + a 1 px line width +
        // (strokeStyle, beginPath, stroke) twice + a moveTo/lineTo per line +
        // the pen handed back.
        XCTAssertEqual(recorded.count, 4 + 2 + 1 + 2 * 3 + 2 * total + 2)
        XCTAssertEqual(recorded.count, 101)
    }

    /// The first stroke after a paint must be the student's pen, not a 1 px
    /// grid line in grid grey.
    func testThePenIsHandedBackAfterAGridPaint() throws {
        let recorded = try ops(try harness(background: "grid"))
        XCTAssertEqual(recorded.last(where: { $0.hasPrefix("[\"lineWidth\"") }), #"["lineWidth",2.5]"#)
        XCTAssertEqual(
            recorded.last(where: { $0.hasPrefix("[\"strokeStyle\"") }),
            ##"["strokeStyle","#1c1c1e"]"##
        )
        XCTAssertEqual(Array(recorded.suffix(2)), [#"["lineWidth",2.5]"#, ##"["strokeStyle","#1c1c1e"]"##])
    }

    // MARK: - axes

    /// The generated fixture asks for `axes`, so this runs on it untouched.
    func testAxesAddsCentredAxesArrowheadsAndTicksOnTopOfTheGrid() throws {
        let h = try fixtureHarness()
        XCTAssertEqual(try background(h), "axes")
        let recorded = try ops(h)

        // Everything grid paints.
        XCTAssertEqual(recorded[4], ##"["fillStyle","#ffffff"]"##)
        XCTAssertEqual(recorded[5], #"["fillRect",0,0,1000,700]"#)
        XCTAssertTrue(recorded.contains(##"["strokeStyle","#dfe3ea"]"##))
        XCTAssertTrue(recorded.contains(##"["strokeStyle","#b8c0cc"]"##))

        // The axes themselves: through the centre, on the half pixel, in the
        // pen's own colour at 1.5 px.
        let axisAt = try XCTUnwrap(recorded.firstIndex(of: #"["lineWidth",1.5]"#))
        XCTAssertEqual(recorded[axisAt - 1], ##"["strokeStyle","#1c1c1e"]"##)
        XCTAssertEqual(recorded[axisAt + 1], #"["beginPath"]"#)
        XCTAssertEqual(recorded[axisAt + 2], #"["moveTo",0,350.5]"#)
        XCTAssertEqual(recorded[axisAt + 3], #"["lineTo",1000,350.5]"#)
        XCTAssertEqual(recorded[axisAt + 4], #"["moveTo",500.5,0]"#)
        XCTAssertEqual(recorded[axisAt + 5], #"["lineTo",500.5,700]"#)

        // Arrowheads at the positive ends only: +x is the right edge, +y the
        // top edge (canvas y grows downward). 8 px back along the axis, 4 px
        // either side of it.
        XCTAssertEqual(recorded[axisAt + 6], #"["moveTo",992,346.5]"#)
        XCTAssertEqual(recorded[axisAt + 7], #"["lineTo",1000,350.5]"#)
        XCTAssertEqual(recorded[axisAt + 8], #"["lineTo",992,354.5]"#)
        XCTAssertEqual(recorded[axisAt + 9], #"["moveTo",496.5,8]"#)
        XCTAssertEqual(recorded[axisAt + 10], #"["lineTo",500.5,0]"#)
        XCTAssertEqual(recorded[axisAt + 11], #"["lineTo",504.5,8]"#)

        // A tick on each axis at every grid line, 4 px either side.
        let columns = lines(canvasWidth)
        let rows = lines(canvasHeight)
        XCTAssertEqual(recorded[axisAt + 12], #"["moveTo",0.5,346.5]"#)
        XCTAssertEqual(recorded[axisAt + 13], #"["lineTo",0.5,354.5]"#)
        XCTAssertTrue(recorded.contains(#"["moveTo",496.5,0.5]"#))
        XCTAssertTrue(recorded.contains(#"["lineTo",504.5,0.5]"#))

        // Grid lines + the two axes + two arrowheads (a moveTo and two lineTo
        // each) + a tick per grid line on each axis.
        let total = columns + rows
        XCTAssertEqual(count(recorded, "moveTo"), total + 2 + 2 + total)
        XCTAssertEqual(count(recorded, "lineTo"), total + 2 + 4 + total)
        XCTAssertEqual(count(recorded, "stroke"), 3)
        // The grid's 101 plus (strokeStyle, lineWidth, beginPath, stroke) and
        // the axis, arrowhead and tick points.
        XCTAssertEqual(recorded.count, 101 + 4 + 4 + 6 + 2 * total)
        XCTAssertEqual(recorded.count, 201)

        // The pen is still handed back last.
        XCTAssertEqual(Array(recorded.suffix(2)), [#"["lineWidth",2.5]"#, ##"["strokeStyle","#1c1c1e"]"##])
    }

    // MARK: - Clear keeps the paper

    func testClearRepaintsThePaperItCleared() throws {
        let paint = Array(try ops(try fixtureHarness()).dropFirst(4))

        let h = try fixtureHarness()
        try h.eval("""
        var c = __first('canvas', \(item));
        c.onpointerdown({ clientX: 10, clientY: 20 });
        c.onpointermove({ clientX: 30, clientY: 40 });
        c.onpointerup();
        __all('button', \(item))[0].onclick();
        """)
        let recorded = try ops(h)
        let clearAt = try XCTUnwrap(recorded.lastIndex(of: #"["clearRect"]"#))
        XCTAssertEqual(Array(recorded[(clearAt + 1)...]), paint)
    }

    /// A blank canvas's Clear is still a bare clearRect — nothing follows it.
    func testClearOnABlankCanvasStillOnlyClears() throws {
        let h = try harness(background: nil)
        try h.eval("""
        var c = __first('canvas', \(item));
        c.onpointerdown({ clientX: 1, clientY: 1 });
        c.onpointerup();
        __all('button', \(item))[0].onclick();
        """)
        let recorded = try ops(h)
        XCTAssertEqual(recorded.last, #"["clearRect"]"#)
    }

    // MARK: - order against the P-1 restore

    /// The saved PNG already carries its own paper, so it must land ON TOP of
    /// the paint — a paint after the restore would erase last session's work.
    func testARestoredDrawingIsPaintedAfterTheBackground() throws {
        let paintOps = try ops(try fixtureHarness()).count
        let h = try harness(background: "axes", saved: true)
        let recorded = try ops(h)
        let drawAt = try XCTUnwrap(recorded.firstIndex { $0.hasPrefix("[\"drawImage\"") })
        XCTAssertEqual(drawAt, paintOps, "the restore must follow the whole paint, not sit inside it")
        XCTAssertEqual(
            recorded[drawAt],
            #"["drawImage","data:image/png;base64,\#(DrawingFixture.pngBase64)",0,0,1000,700]"#
        )
    }

    // MARK: - the size fallback still applies

    /// An unsized canvas asking for a grid gets the 800 x 600 default paper.
    func testAnUnsizedGridUsesTheDefaultCanvasSize() throws {
        let h = try RendererHarness(bundleJSON: """
        {"test_id":"t","title":"T","items":[{"type":"drawing_upload","id":"i","stem":"s",
         "canvas":{"width":800,"height":600,"background":"grid"}}]}
        """)
        let json = try XCTUnwrap(h.string("""
        JSON.stringify(__first('canvas').__ops.map(function (o) { return JSON.stringify(o); }))
        """))
        let recorded = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String])
        XCTAssertEqual(recorded[5], #"["fillRect",0,0,800,600]"#)
        // 800 -> 20 lines, 600 -> 15.
        XCTAssertEqual(lines(800), 20)
        XCTAssertEqual(lines(600), 15)
        XCTAssertEqual(count(recorded, "moveTo"), 35)
    }
}
