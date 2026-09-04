import XCTest
@testable import SecureTestCore

/// E3 slice 3. The table item in the fixture is index 8: two columns
/// (Observed / Expected) by two labelled rows (Middle / **Total**) with the
/// corner caption "Chamber position".
final class RendererTableTests: XCTestCase {
    private let item = "__item(8)"

    private func harness() throws -> RendererHarness {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/delivery-bundle.json")
        return try RendererHarness(bundleJSON: try String(contentsOf: url, encoding: .utf8))
    }

    /// A bundle of one table whose rows carry no labels — D-5: the label
    /// column (and the corner with it) is not rendered.
    private func unlabelledHarness() throws -> RendererHarness {
        try RendererHarness(bundleJSON: #"""
        {"test_id":"t","title":"t","items":[{"type":"table","id":"t1","stem":"Record three trials",
          "columns":[{"id":"c1","label":"Mass (g)"},{"id":"c2","label":"Volume (mL)"}],
          "rows":[{"id":"r1","label":""},{"id":"r2","label":" "},{"id":"r3","label":""}],
          "corner":"ignored"}]}
        """#)
    }

    func testRendersOneTextFieldPerBodyCellUnderTheHeadings() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('.fill-table', \(item))"), 1)
        XCTAssertEqual(try h.int("__count('.table-cell', \(item))"), 4)
        // Header row: corner + two headings; body rows: a row label each.
        XCTAssertEqual(try h.int("__count('th', \(item))"), 5)
        XCTAssertEqual(try h.string("__first('.table-corner', \(item)).textContent"), "Chamber position")
        XCTAssertEqual(try h.string("__all('th', \(item))[1].textContent"), "Observed (o)")
        XCTAssertEqual(try h.string("__all('th', \(item))[3].textContent"), "Middle")
    }

    /// Row labels and headings render emphasis like every other authored text:
    /// `**Total**` becomes a strong element, the markers gone.
    func testLabelsCarryEmphasisAsElementsNotMarkers() throws {
        let h = try harness()
        XCTAssertEqual(try h.string("__all('th', \(item))[4].textContent"), "Total")
        XCTAssertEqual(try h.int("__count('strong', __all('th', \(item))[4])"), 1)
    }

    func testEveryFieldNamesItsRowAndColumnForAssistiveTechnology() throws {
        let h = try harness()
        XCTAssertEqual(
            try h.string("__all('.table-cell', \(item))[0].getAttribute('aria-label')"),
            "Middle, Observed (o)"
        )
        XCTAssertEqual(
            try h.string("__all('.table-cell', \(item))[3].getAttribute('aria-label')"),
            "Total, Expected (e)"
        )
        XCTAssertEqual(try h.string("__first('.table-cell', \(item)).type"), "text")
        XCTAssertEqual(try h.string("__first('.table-cell', \(item)).autocomplete"), "off")
    }

    func testPostsOnlyTheCellsThatHoldText() throws {
        let h = try harness()
        try h.eval(
            "var f = __all('.table-cell', \(item));"
            + "f[0].value = '12'; f[0].onchange();"
            + "f[3].value = '1.50'; f[3].onchange();"
        )
        let messages = try h.postedMessages()
        XCTAssertEqual(messages.count, 2)
        let response = messages[1]["response"] as? [String: Any]
        XCTAssertEqual(response?["type"] as? String, "table")
        let cells = response?["cells"] as? [String: [String: String]]
        XCTAssertEqual(cells, ["r1": ["c1": "12"], "r2": ["c2": "1.50"]])
    }

    /// The client records what was typed and judges nothing — the bundle has
    /// no expected text to judge against.
    func testRecordsAnyTextWithoutJudgingIt() throws {
        let h = try harness()
        try h.eval("var f = __all('.table-cell', \(item)); f[1].value = 'H_2O'; f[1].onchange();")
        let cells = (try h.postedMessages().last?["response"] as? [String: Any])?["cells"]
            as? [String: [String: String]]
        XCTAssertEqual(cells, ["r1": ["c2": "H_2O"]])
    }

    func testClearingEveryFieldPostsNothingFurther() throws {
        let h = try harness()
        try h.eval(
            "var f = __all('.table-cell', \(item));"
            + "f[0].value = '12'; f[0].onchange();"
            + "f[0].value = ''; f[0].onchange();"
        )
        // An all-blank grid is the ABSENCE of a response (the match rule), so
        // there is nothing valid to send.
        XCTAssertEqual(try h.postedMessages().count, 1)
    }

    func testHidesTheLabelColumnWhenEveryRowLabelIsBlank() throws {
        let h = try unlabelledHarness()
        XCTAssertEqual(try h.int("__count('.table-cell', __item(0))"), 6)
        XCTAssertEqual(try h.int("__count('.table-corner', __item(0))"), 0)
        // Only the two headings — no corner, no row-label cells.
        XCTAssertEqual(try h.int("__count('th', __item(0))"), 2)
        XCTAssertEqual(
            try h.string("__all('.table-cell', __item(0))[2].getAttribute('aria-label')"),
            "Row 2, Mass (g)"
        )
    }

    func testSpellCheckFollowsTheStudentsAccommodation() throws {
        let on = try RendererHarness(bundleJSON: #"""
        {"test_id":"t","title":"t","accommodations":{"spell_check":"On"},"items":[{"type":"table","id":"t1","stem":"s",
          "columns":[{"id":"c1","label":"A"}],"rows":[{"id":"r1","label":"x"}]}]}
        """#)
        XCTAssertTrue(try on.bool("__first('.table-cell', __item(0)).spellcheck"))
        let off = try RendererHarness(bundleJSON: #"""
        {"test_id":"t","title":"t","items":[{"type":"table","id":"t1","stem":"s",
          "columns":[{"id":"c1","label":"A"}],"rows":[{"id":"r1","label":"x"}]}]}
        """#)
        XCTAssertFalse(try off.bool("__first('.table-cell', __item(0)).spellcheck"))
    }
}
