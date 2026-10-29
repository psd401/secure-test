import XCTest
@testable import SecureTestCore

/// P-1 (2026-10-28, `docs/design-tool-manual-checks.md`): a picture the
/// teacher put in a multiple-choice choice (`![alt](asset:…)`) renders as a
/// picture inside the choice's label, not as the raw reference — and, being
/// part of the label, it selects the choice rather than opening the overlay.
final class RendererChoicePictureTests: XCTestCase {
    private static let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    private static let bundle = """
    {
      "test_id": "p1", "title": "P-1",
      "items": [
        { "type": "multiple_choice_single", "id": "q1", "stem": "Which is a plant cell?",
          "choices": [
            { "id": "a", "text": "![Plant cell](asset:44444444-4444-4444-8444-444444444444)" },
            { "id": "b", "text": "An **animal** cell ![missing](asset:55555555-5555-4555-8555-555555555555)" }
          ] }
      ],
      "item_sets": [],
      "assets": { "44444444-4444-4444-8444-444444444444": { "content_type": "image/png", "base64": "\(png)" } },
      "accommodations": {}
    }
    """

    private func harness() throws -> RendererHarness {
        try RendererHarness(bundleJSON: Self.bundle)
    }

    func testAChoicePictureIsAnImageInsideTheLabel() throws {
        let h = try harness()
        let choice = "__all('.choice', __item(0))[0]"
        XCTAssertEqual(try h.int("__count('img', \(choice))"), 1)
        XCTAssertEqual(try h.string("__first('img', \(choice)).alt"), "Plant cell")
        XCTAssertEqual(
            try h.string("__first('img', \(choice)).src"),
            "data:image/png;base64,\(Self.png)"
        )
        XCTAssertFalse(try h.string("\(choice).textContent")?.contains("asset:") ?? true)
    }

    func testAChoicePictureIsNotEnlargeable() throws {
        let h = try harness()
        let img = "__first('img', __all('.choice', __item(0))[0])"
        XCTAssertEqual(try h.string("\(img).className"), "")
        XCTAssertNil(try h.string("\(img).getAttribute('role')"))
    }

    func testEmphasisStillWorksAndAMissingPictureSaysSo() throws {
        let h = try harness()
        let choice = "__all('.choice', __item(0))[1]"
        XCTAssertEqual(try h.int("__count('strong', \(choice))"), 1)
        XCTAssertEqual(try h.int("__count('.missing-asset', \(choice))"), 1)
        XCTAssertEqual(try h.string("__first('.missing-asset', \(choice)).textContent"), "[image not found: missing]")
    }
}
