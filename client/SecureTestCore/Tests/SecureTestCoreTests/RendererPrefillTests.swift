import XCTest
@testable import SecureTestCore

/// P-1 (docs/resume-prefill-design.md): a student who quits and rejoins finds
/// the fields under the answered marks holding their answers, not blank.
///
/// Driven by the fixture the design tool's own delivery route produced, with
/// `saved_responses` / `saved_uploads` injected in-test — the fixture file
/// itself stays exactly as generated (RendererPagingTests uses the same trick).
/// Item order matches RendererBehaviourTests.Index.
final class RendererPrefillTests: XCTestCase {
    private enum Index {
        static let mcSingle = 0, mcMulti = 1, shortText = 2, essay = 3
        static let match = 4, order = 5, hotspot = 6, drawing = 7, table = 8
    }

    private static let uploadID = "11111111-1111-4111-8111-111111111111"
    /// The harness canvas's own `toDataURL` payload, reused as the stored bytes.
    private static let pngBase64 = "SEVMTE8="

    /// A harness on the untouched fixture, used to read the ids the bundle
    /// actually carries (match and order ids are per-attempt sealed values,
    /// so they cannot be written down here).
    private func probe() throws -> RendererHarness {
        try RendererHarness(bundleJSON: try RendererHarness.fixtureJSON())
    }

    private func itemIDs() throws -> [String] {
        let p = try probe()
        return try (0..<9).map { try XCTUnwrap(p.string("BUNDLE.items[\($0)].id")) }
    }

    /// The fixture plus saved answers for the given item indexes (values are
    /// response JSON, exactly the shapes the page posts).
    private func restored(
        _ saved: [Int: String],
        uploads: [String: String] = [:],
        paged: Bool = false
    ) throws -> RendererHarness {
        var json = try RendererHarness.fixtureJSON()
        let ids = try itemIDs()
        let responses = saved
            .sorted { $0.key < $1.key }
            .map { "\"\(ids[$0.key])\": \($0.value)" }
            .joined(separator: ", ")
        var injected = "\"saved_responses\": {\(responses)}, "
        if !uploads.isEmpty {
            let blobs = uploads
                .sorted { $0.key < $1.key }
                .map { "\"\($0.key)\": \($0.value)" }
                .joined(separator: ", ")
            injected += "\"saved_uploads\": {\(blobs)}, "
        }
        if paged { injected += "\"layout\": \"paged\", " }
        let range = try XCTUnwrap(json.range(of: "\"test_id\":"))
        json.replaceSubrange(range, with: injected + "\"test_id\":")
        return try RendererHarness(bundleJSON: json)
    }

    private func assertNothingWasSent(_ h: RendererHarness, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(try h.postedMessages().count, 0, "a restore must not post", file: file, line: line)
        XCTAssertEqual(try h.postedUploads().count, 0, file: file, line: line)
        XCTAssertEqual(try h.postedWithdrawals().count, 0, file: file, line: line)
        XCTAssertEqual(try h.postedSubmits().count, 0, file: file, line: line)
    }

    // MARK: - every type

    func testEveryTypeComesBackAndTheRestoreItselfSendsNothing() throws {
        let p = try probe()
        let lefts = try (0..<3).map { try XCTUnwrap(p.string("BUNDLE.items[\(Index.match)].lefts[\($0)].id")) }
        let rights = try (0..<3).map { try XCTUnwrap(p.string("BUNDLE.items[\(Index.match)].rights[\($0)].id")) }
        let entries = try (0..<4).map { try XCTUnwrap(p.string("BUNDLE.items[\(Index.order)].entries[\($0)].id")) }
        // Labels are read off the bundle too: the fixture's shuffle is seeded
        // from ids that churn on every regeneration, so a literal label order
        // here would break each time the fixture is regenerated.
        let labels = try (0..<4).map { try XCTUnwrap(p.string("BUNDLE.items[\(Index.order)].entries[\($0)].label")) }

        let h = try restored([
            Index.mcSingle: #"{"type":"multiple_choice_single","choice_id":"c2"}"#,
            Index.mcMulti: #"{"type":"multiple_choice_multi","choice_ids":["c1","c3"]}"#,
            Index.shortText: #"{"type":"short_text","text":"H_2O"}"#,
            Index.essay: #"{"type":"essay","text":"Two words"}"#,
            Index.match: "{\"type\":\"match\",\"matches\":"
                + "{\"\(lefts[0])\":\"\(rights[2])\",\"\(lefts[1])\":\"\(rights[1])\"}}",
            Index.order: "{\"type\":\"order\",\"ordered_ids\":"
                + "[\"\(entries[2])\",\"\(entries[1])\",\"\(entries[3])\",\"\(entries[0])\"]}",
            Index.hotspot: #"{"type":"hotspot","region_ids":["r2"]}"#,
            Index.table: #"{"type":"table","cells":{"r1":{"c1":"12"},"r2":{"c2":"30"}}}"#,
        ])

        // Single choice: the second radio, and only it.
        XCTAssertEqual(try checkedPattern(h, Index.mcSingle), ".x.")
        // Multi: both saved boxes.
        XCTAssertEqual(try checkedPattern(h, Index.mcMulti), "x.x")
        // Short text: the value AND its formula preview (the harness has no
        // KaTeX, so data-tex is what proves the preview ran).
        XCTAssertEqual(try h.string("__first('.short-text', __item(\(Index.shortText))).value"), "H_2O")
        XCTAssertEqual(
            try h.string("__first('.formula-preview', __item(\(Index.shortText))).getAttribute('data-tex')"),
            "\\mathrm{H_2O}"
        )
        // Essay: the value, and the word counter recomputed from it.
        XCTAssertEqual(try h.string("__first('.essay', __item(\(Index.essay))).value"), "Two words")
        XCTAssertEqual(try h.string("__first('.word-count', __item(\(Index.essay))).textContent"), "2 / 400 words")
        // Match: the saved right on each answered row, "Choose…" on the third.
        XCTAssertEqual(try selectValues(h), "\(rights[2]),\(rights[1]),-")
        // Order: the saved arrangement, read off the labels.
        XCTAssertEqual(try orderLabels(h), [labels[2], labels[1], labels[3], labels[0]].joined(separator: ","))
        // Hotspot: region 2 pressed, region 1 not.
        XCTAssertEqual(try regionClasses(h), "hotspot-region|hotspot-region selected")
        XCTAssertEqual(try regionPressed(h), "false|true")
        // Table: r1/c1 and r2/c2, in row-major order.
        XCTAssertEqual(try cellValues(h), "12|||30")

        try assertNothingWasSent(h)
    }

    /// The whole point of D-3: the restored state is the baseline, so the
    /// spool sees nothing until the student actually changes something — and
    /// a change after a restore still posts exactly as it always did.
    func testAChangeAfterARestoreStillPostsNormally() throws {
        let h = try restored([Index.mcSingle: #"{"type":"multiple_choice_single","choice_id":"c2"}"#])
        try assertNothingWasSent(h)
        try h.eval("__all('input', __item(\(Index.mcSingle)))[2].onchange()")
        let messages = try h.postedMessages()
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual((messages[0]["response"] as? [String: Any])?["choice_id"] as? String, "c3")
    }

    // MARK: - what is refused

    func testAValueWhoseTypeDoesNotMatchTheItemIsIgnored() throws {
        let h = try restored([
            Index.mcSingle: #"{"type":"essay","text":"wrong shape"}"#,
            Index.essay: #"{"type":"multiple_choice_single","choice_id":"c1"}"#,
            Index.table: #"{"type":"short_text","text":"nope"}"#,
        ])
        XCTAssertEqual(try checkedPattern(h, Index.mcSingle), "...")
        XCTAssertTrue(try h.bool("__first('.clear-answer', __item(\(Index.mcSingle))).disabled"))
        XCTAssertNil(try h.string("__first('.essay', __item(\(Index.essay))).value"))
        XCTAssertEqual(try cellValues(h), "|||")
        try assertNothingWasSent(h)
    }

    func testAMatchValueThatIsNotOneOfTheOptionsLeavesTheRowUnchosen() throws {
        let p = try probe()
        let lefts = try (0..<3).map { try XCTUnwrap(p.string("BUNDLE.items[\(Index.match)].lefts[\($0)].id")) }
        let rights = try (0..<3).map { try XCTUnwrap(p.string("BUNDLE.items[\(Index.match)].rights[\($0)].id")) }
        let h = try restored([
            Index.match: "{\"type\":\"match\",\"matches\":"
                + "{\"\(lefts[0])\":\"not-a-sealed-id\",\"\(lefts[2])\":\"\(rights[0])\"}}",
        ])
        XCTAssertEqual(try selectValues(h), "-,-,\(rights[0])")
        try assertNothingWasSent(h)
    }

    func testAHotspotIdThatIsNoLongerARegionIsIgnored() throws {
        let h = try restored([Index.hotspot: #"{"type":"hotspot","region_ids":["r9"]}"#])
        XCTAssertEqual(try regionClasses(h), "hotspot-region|hotspot-region")
        XCTAssertEqual(try regionPressed(h), "false|false")
        try assertNothingWasSent(h)
    }

    /// An entry the saved list does not name keeps its relative shuffled
    /// position after the named ones, so every entry appears exactly once.
    func testOrderEntriesTheSavedListDoesNotNameFollowTheOnesItDoes() throws {
        let p = try probe()
        let entries = try (0..<4).map { try XCTUnwrap(p.string("BUNDLE.items[\(Index.order)].entries[\($0)].id")) }
        let labels = try (0..<4).map { try XCTUnwrap(p.string("BUNDLE.items[\(Index.order)].entries[\($0)].label")) }
        let h = try restored([
            Index.order: "{\"type\":\"order\",\"ordered_ids\":[\"\(entries[3])\",\"gone\"]}",
        ])
        // The named entry first, then the other three in their shuffled order.
        XCTAssertEqual(try orderLabels(h), [labels[3], labels[0], labels[1], labels[2]].joined(separator: ","))
        try assertNothingWasSent(h)
    }

    // MARK: - Clear answer on a restored item

    /// Batch 1b (#3) built Clear from a recomputed `checked` state precisely so
    /// this would work: a student must be able to withdraw an answer they gave
    /// last session without first re-picking it.
    func testARestoredChoiceStartsWithClearEnabledAndWithdrawsOnce() throws {
        let h = try restored([Index.mcSingle: #"{"type":"multiple_choice_single","choice_id":"c1"}"#])
        XCTAssertFalse(try h.bool("__first('.clear-answer', __item(\(Index.mcSingle))).disabled"))
        // An item with nothing saved is untouched: its button still starts off.
        XCTAssertTrue(try h.bool("__first('.clear-answer', __item(\(Index.mcMulti))).disabled"))

        try h.eval("__first('.clear-answer', __item(\(Index.mcSingle))).onclick()")
        XCTAssertEqual(try h.postedWithdrawals().count, 1)
        XCTAssertEqual(try checkedPattern(h, Index.mcSingle), "...")
        XCTAssertTrue(try h.bool("__first('.clear-answer', __item(\(Index.mcSingle))).disabled"))
        XCTAssertEqual(try h.postedMessages().count, 0)
    }

    // MARK: - drawing

    func testARestoredDrawingWithBytesIsPaintedOntoTheCanvasAndReadsSaved() throws {
        let item = "__item(\(Index.drawing))"
        let h = try restored(
            [Index.drawing: "{\"type\":\"drawing_upload\",\"upload_id\":\"\(Self.uploadID)\"}"],
            uploads: [Self.uploadID: "{\"content_type\":\"image/png\",\"base64\":\"\(Self.pngBase64)\"}"]
        )
        let ops = try h.string("JSON.stringify(__first('canvas', \(item)).__ops)") ?? ""
        XCTAssertTrue(ops.contains("drawImage"), ops)
        // The stored bytes, drawn to fill the authored canvas (1000x700).
        XCTAssertTrue(ops.contains("data:image/png;base64,\(Self.pngBase64)"), ops)
        XCTAssertTrue(ops.contains("0,0,1000,700"), ops)
        // Marked, so pressing Save on last session's work is not refused.
        XCTAssertTrue(try h.bool("__first('canvas', \(item)).__markedForTest()"))
        XCTAssertEqual(try h.string("__first('.drawing-status', \(item)).textContent"), "Saved.")
        XCTAssertEqual(try h.string("__first('.drawing-status', \(item)).className"), "drawing-status saved")
        try assertNothingWasSent(h)
    }

    /// D-5: past the inline cap (or a type the canvas cannot draw) the answer
    /// is still listed and the field says saved — without the picture.
    func testARestoredDrawingWithoutBytesStillReadsSavedAndPaintsNothing() throws {
        let item = "__item(\(Index.drawing))"
        let h = try restored([Index.drawing: "{\"type\":\"drawing_upload\",\"upload_id\":\"\(Self.uploadID)\"}"])
        let ops = try h.string("JSON.stringify(__first('canvas', \(item)).__ops)") ?? ""
        XCTAssertFalse(ops.contains("drawImage"), ops)
        XCTAssertTrue(try h.bool("__first('canvas', \(item)).__markedForTest()"))
        XCTAssertEqual(try h.string("__first('.drawing-status', \(item)).textContent"), "Saved.")
        XCTAssertEqual(try h.string("__first('.drawing-status', \(item)).className"), "drawing-status saved")
        try assertNothingWasSent(h)
    }

    /// Clear is unchanged by the restore: it wipes the canvas and takes the
    /// item back to untouched, exactly as it does for a drawing made here.
    func testClearingARestoredDrawingWipesItAsBefore() throws {
        let item = "__item(\(Index.drawing))"
        let h = try restored(
            [Index.drawing: "{\"type\":\"drawing_upload\",\"upload_id\":\"\(Self.uploadID)\"}"],
            uploads: [Self.uploadID: "{\"content_type\":\"image/png\",\"base64\":\"\(Self.pngBase64)\"}"]
        )
        try h.eval("__all('button', __first('.drawing-controls', \(item)))[0].onclick()")
        let ops = try h.string("JSON.stringify(__first('canvas', \(item)).__ops)") ?? ""
        XCTAssertTrue(ops.contains("clearRect"))
        XCTAssertFalse(try h.bool("__first('canvas', \(item)).__markedForTest()"))
        XCTAssertEqual(try h.string("__first('.drawing-status', \(item)).textContent"), "")
        XCTAssertEqual(try h.string("__first('.drawing-status', \(item)).className"), "drawing-status")
    }

    // MARK: - marks stay the server's business

    /// A restore never calls markAnswered: the strip is seeded from
    /// `answered_item_ids` and nothing else, so the two can only ever agree
    /// because the server derived them from one query (D-4).
    func testRestoringDoesNotMarkTheStripByItself() throws {
        let h = try restored(
            [Index.mcSingle: #"{"type":"multiple_choice_single","choice_id":"c2"}"#],
            paged: true
        )
        XCTAssertEqual(try h.string("__all('button', __first('.pager-strip'))[0].className"), "unanswered")
        XCTAssertEqual(
            try h.string("__first('.review-count').textContent"),
            "0 of 9 answered. Go back to any question, or hand in."
        )
        XCTAssertEqual(try checkedPattern(h, Index.mcSingle), ".x.", "the field is still restored")
    }

    // MARK: - the untouched path

    /// The offline bundle and every server bundle for a fresh attempt carry
    /// neither field; the tree they build must be exactly what it was before
    /// this slice existed.
    func testABundleWithNoSavedFieldsBuildsTheSameTreeAsOneWithEmptyMaps() throws {
        let plain = try RendererHarness(bundleJSON: try RendererHarness.fixtureJSON())
        var json = try RendererHarness.fixtureJSON()
        let range = try XCTUnwrap(json.range(of: "\"test_id\":"))
        json.replaceSubrange(range, with: "\"saved_responses\": {}, \"saved_uploads\": {}, \"test_id\":")
        let empty = try RendererHarness(bundleJSON: json)

        XCTAssertEqual(try plain.string(Self.serialise), try empty.string(Self.serialise))
        // And that tree holds no answer: nothing checked, no values, no posts.
        XCTAssertEqual(try plain.int("__all('input').filter(function (i) { return i.checked === true; }).length"), 0)
        // A radio's `value` is its choice id and is always set; the fields a
        // student types into are the ones that must start empty.
        XCTAssertEqual(
            try plain.int("__all('input').filter(function (i) { return i.type === 'text' && i.value; }).length"),
            0
        )
        XCTAssertEqual(
            try plain.int("__all('textarea').filter(function (t) { return t.value; }).length"),
            0
        )
        XCTAssertEqual(try plain.int("__count('.selected')"), 0)
        XCTAssertEqual(try plain.string("__first('.drawing-status', __item(\(Index.drawing))).textContent"), "")
        try assertNothingWasSent(plain)
    }

    // MARK: - helpers

    /// One character per input: `x` checked, `.` not.
    private func checkedPattern(_ h: RendererHarness, _ index: Int) throws -> String? {
        try h.string(
            "__all('input', __item(\(index)))"
            + ".map(function (i) { return i.checked === true ? 'x' : '.'; }).join('')"
        )
    }

    private func selectValues(_ h: RendererHarness) throws -> String? {
        try h.string(
            "__all('.match-select', __item(\(Index.match)))"
            + ".map(function (s) { return s.value || '-'; }).join(',')"
        )
    }

    private func orderLabels(_ h: RendererHarness) throws -> String? {
        try h.string(
            "__all('.order-label', __item(\(Index.order)))"
            + ".map(function (n) { return n.textContent; }).join(',')"
        )
    }

    private func regionClasses(_ h: RendererHarness) throws -> String? {
        try h.string(
            "__all('.hotspot-region', __item(\(Index.hotspot)))"
            + ".map(function (b) { return b.className; }).join('|')"
        )
    }

    private func regionPressed(_ h: RendererHarness) throws -> String? {
        try h.string(
            "__all('.hotspot-region', __item(\(Index.hotspot)))"
            + ".map(function (b) { return b.getAttribute('aria-pressed'); }).join('|')"
        )
    }

    private func cellValues(_ h: RendererHarness) throws -> String? {
        try h.string(
            "__all('.table-cell', __item(\(Index.table)))"
            + ".map(function (i) { return i.value; }).join('|')"
        )
    }

    /// Everything the shim records about the built tree, as one string, so
    /// "the DOM is unchanged" is an equality rather than a list of spot checks.
    private static let serialise = """
    JSON.stringify((function walk(n) {
      return {
        tag: n.tagName, cls: n.className, text: n._text, attrs: n.attributes,
        style: n.style, value: n.value, checked: n.checked, disabled: n.disabled,
        type: n.type, placeholder: n.placeholder, spellcheck: n.spellcheck,
        kids: (n.children || []).map(walk)
      };
    })(__root))
    """
}
