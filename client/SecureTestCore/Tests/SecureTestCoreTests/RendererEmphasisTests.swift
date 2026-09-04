import XCTest
@testable import SecureTestCore

/// E6 (2026-09-02): `**bold**` / `_italic_` in stems, choices, pairs and
/// stimulus text become strong / em ELEMENTS built as DOM — never markup —
/// and never inside math. Exercised for real in JavaScriptCore (RendererHarness).
final class RendererEmphasisTests: XCTestCase {
    private static let bundle = """
    {
      "test_id": "e6", "title": "E6",
      "items": [
        { "type": "multiple_choice_single", "id": "q1",
          "stem": "Which is **NOT** an _abiotic_ factor? Solve $x_1 + x_2$ for **x** ______ snake_case",
          "choices": [ { "id": "a", "text": "a **fern**" }, { "id": "b", "text": "_sunlight_" } ] },
        { "type": "match", "id": "q2", "stem": "Match.",
          "lefts": [ { "id": "l1", "text": "_Dog_" } ],
          "rights": [ { "id": "r1", "text": "**Puppy**" }, { "id": "r2", "text": "Calf" } ] }
      ],
      "item_sets": [ { "id": "s1", "stimulus": "**Read** the _passage_ first.", "layout": "inline", "item_ids": ["q1"] } ],
      "assets": {}, "accommodations": {}
    }
    """

    private func harness() throws -> RendererHarness {
        try RendererHarness(bundleJSON: Self.bundle)
    }

    func testStemEmphasisBecomesElementsAndMathStaysText() throws {
        let h = try harness()
        let stem = "__first('.stem', __item(0))"
        XCTAssertEqual(try h.int("__count('strong', \(stem))"), 2)
        XCTAssertEqual(try h.string("__first('strong', \(stem)).textContent"), "NOT")
        XCTAssertEqual(try h.int("__count('em', \(stem))"), 1)
        XCTAssertEqual(try h.string("__first('em', \(stem)).textContent"), "abiotic")
        // The markers are gone from the visible text; math and the literal
        // underscores are untouched (renderMathInElement runs later).
        XCTAssertEqual(
            try h.string("\(stem).textContent"),
            "Which is NOT an abiotic factor? Solve $x_1 + x_2$ for x ______ snake_case"
        )
    }

    func testChoicesPairsAndStimulusCarryEmphasis() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('strong', __first('.choice', __item(0)))"), 1)
        XCTAssertEqual(try h.int("__count('em', __item(0))"), 2, "the stem's and the second choice's")
        XCTAssertEqual(try h.string("__first('.match-left', __item(1)).textContent"), "Dog")
        XCTAssertEqual(try h.int("__count('em', __first('.match-left', __item(1)))"), 1)
        // A select option can only hold text: markers stripped, words kept.
        XCTAssertEqual(try h.string("__all('option', __item(1))[1].textContent"), "Puppy")
        XCTAssertEqual(try h.int("__count('strong', __first('.stimulus-body'))"), 1)
        XCTAssertEqual(try h.string("__first('.stimulus-body').textContent"), "Read the passage first.")
    }

    func testNothingAuthoredBecomesMarkup() throws {
        // The renderer still never parses authored text: a stem shaped like a
        // tag is characters, and the script cannot close its own element.
        XCTAssertFalse(AssessmentPage.rendererScript.contains("innerHTML"))
        XCTAssertFalse(AssessmentPage.rendererScript.contains("</"))
    }
}
