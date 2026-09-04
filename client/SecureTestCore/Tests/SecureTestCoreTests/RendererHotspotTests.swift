import XCTest
@testable import SecureTestCore

/// Slice 57. The hotspot item is fixture index 6: a bundled 1x1 PNG with two
/// normalised regions, r1 at (0.1, 0.1) 0.25x0.25 and r2 at (0.6, 0.55) 0.3x0.3.
final class RendererHotspotTests: XCTestCase {
    private let item = "__item(6)"

    private func harness() throws -> RendererHarness {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/delivery-bundle.json")
        return try RendererHarness(bundleJSON: try String(contentsOf: url, encoding: .utf8))
    }

    func testRendersTheBundledImageAsADataURI() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('.hotspot-frame', \(item))"), 1)
        let src = try h.string("__first('img', \(item)).src")
        XCTAssertTrue(src?.hasPrefix("data:image/png;base64,") == true)
        XCTAssertEqual(try h.int("__count('.hotspot-unavailable', \(item))"), 0)
    }

    /// The image IS the question, so any alt describing it would be describing
    /// the answer. The stem carries the prompt instead.
    func testImageAltIsEmptyRatherThanDescriptive() throws {
        let h = try harness()
        XCTAssertEqual(try h.string("__first('img', \(item)).alt"), "")
    }

    /// Batch 0b slice 1 (2026-09-03). The harness has no layout engine, so this
    /// pins only that the rules EXIST: from slice 57 to the first hand-run the
    /// page carried none, and the percent offsets below meant nothing — the
    /// frame was static and the regions were default buttons under the image.
    func testPageCarriesTheRulesThatOverlayRegionsOnTheImage() throws {
        let css = AssessmentPage.itemStyles
        XCTAssertTrue(css.contains(".hotspot-frame { position: relative;"))
        let region = css.range(of: ".hotspot-region {").map { css[$0.upperBound...] }
        XCTAssertTrue(region?.contains("position: absolute;") == true)
        XCTAssertTrue(css.contains(".hotspot-region.selected {"))
        XCTAssertTrue(css.contains(".hotspot-region:focus-visible {"))
    }

    func testRegionsArePositionedFromTheNormalisedCoordinates() throws {
        let h = try harness()
        let first = "__all('.hotspot-region', \(item))[0].style"
        XCTAssertEqual(try h.string("\(first).left"), "10%")
        XCTAssertEqual(try h.string("\(first).top"), "10%")
        XCTAssertEqual(try h.string("\(first).width"), "25%")
        XCTAssertEqual(try h.string("\(first).height"), "25%")

        let second = "__all('.hotspot-region', \(item))[1].style"
        XCTAssertEqual(try h.string("\(second).left"), "60%")
        XCTAssertEqual(try h.string("\(second).top"), "55%")
    }

    /// Buttons rather than a click handler on the image, so a region can be
    /// reached and activated from the keyboard and announces its state.
    func testRegionsAreFocusableButtonsWithAnnouncedState() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('button', \(item))"), 2)
        XCTAssertEqual(try h.string("__all('button', \(item))[0].type"), "button")
        XCTAssertEqual(
            try h.string("__all('button', \(item))[0].getAttribute('aria-label')"),
            "Region 1"
        )
        XCTAssertEqual(
            try h.string("__all('button', \(item))[0].getAttribute('aria-pressed')"),
            "false"
        )
    }

    func testClickingARegionSelectsItAndPostsItsID() throws {
        let h = try harness()
        try h.eval("__all('.hotspot-region', \(item))[1].onclick()")
        XCTAssertEqual(
            try h.string("__all('.hotspot-region', \(item))[1].className"),
            "hotspot-region selected"
        )
        XCTAssertEqual(
            try h.string("__all('.hotspot-region', \(item))[1].getAttribute('aria-pressed')"),
            "true"
        )
        let response = try h.postedMessages().last?["response"] as? [String: Any]
        XCTAssertEqual(response?["type"] as? String, "hotspot")
        XCTAssertEqual(response?["region_ids"] as? [String], ["r2"])
    }

    /// correct_region_ids is an array and the item carries no cardinality flag,
    /// so the renderer supports selecting more than one. Ids are emitted in the
    /// item's own region order, not click order, so the payload is stable.
    func testSelectingSeveralRegionsPostsThemInItemOrder() throws {
        let h = try harness()
        try h.eval(
            "__all('.hotspot-region', \(item))[1].onclick();"
            + "__all('.hotspot-region', \(item))[0].onclick();"
        )
        let ids = (try h.postedMessages().last?["response"] as? [String: Any])?["region_ids"]
            as? [String]
        XCTAssertEqual(ids, ["r1", "r2"])
    }

    func testDeselectingEverythingPostsNothingFurther() throws {
        let h = try harness()
        try h.eval(
            "__all('.hotspot-region', \(item))[0].onclick();"
            + "__all('.hotspot-region', \(item))[0].onclick();"
        )
        // Same rule as the other multi-value types: an unanswered item is the
        // ABSENCE of a response, and the schema requires at least one id.
        XCTAssertEqual(try h.postedMessages().count, 1)
        XCTAssertEqual(
            try h.string("__all('.hotspot-region', \(item))[0].getAttribute('aria-pressed')"),
            "false"
        )
    }

    // MARK: items that cannot be answered

    /// A hotspot may legitimately be a draft — the teacher creates the item and
    /// draws the regions afterwards. Saying so beats presenting a stem with an
    /// invisible answer surface.
    func testDraftHotspotWithNoImageSaysItCannotBeAnswered() throws {
        let h = try RendererHarness(bundleJSON: """
        {"test_id":"t","title":"T","items":[
          {"type":"hotspot","id":"i","stem":"s","regions":[]}]}
        """)
        XCTAssertEqual(try h.int("__count('.hotspot-unavailable')"), 1)
        XCTAssertEqual(try h.int("__count('.hotspot-region')"), 0)
    }

    func testHotspotWithAnImageButNoRegionsIsAlsoUnanswerable() throws {
        let h = try RendererHarness(bundleJSON: """
        {"test_id":"t","title":"T",
         "items":[{"type":"hotspot","id":"i","stem":"s",
                   "image_asset_id":"33333333-3333-4333-8333-333333333333",
                   "regions":[]}],
         "assets":{"33333333-3333-4333-8333-333333333333":
                   {"content_type":"image/png","base64":"AAAA"}}}
        """)
        XCTAssertEqual(try h.int("__count('.hotspot-unavailable')"), 1)
    }

    /// The export path skips assets it cannot read rather than failing the whole
    /// bundle, so a ref with no blob behind it is a state the client will meet.
    func testImageRefWithNoBundledBlobDegradesToTheNotice() throws {
        let h = try RendererHarness(bundleJSON: """
        {"test_id":"t","title":"T","items":[
          {"type":"hotspot","id":"i","stem":"s",
           "image_asset_id":"99999999-9999-4999-8999-999999999999",
           "regions":[{"id":"r1","x":0,"y":0,"w":0.5,"h":0.5}]}]}
        """)
        XCTAssertEqual(try h.int("__count('.hotspot-unavailable')"), 1)
        XCTAssertEqual(try h.int("__count('img')"), 0)
    }
}

/// Asset refs embedded in authored prose, exercised by the short-text stem which
/// the fixture now carries an `![alt](asset:uuid)` ref in.
final class RendererAssetRefTests: XCTestCase {
    private func harness() throws -> RendererHarness {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/delivery-bundle.json")
        return try RendererHarness(bundleJSON: try String(contentsOf: url, encoding: .utf8))
    }

    func testStemImageRefBecomesAnImageElement() throws {
        let h = try harness()
        let stem = "__first('.stem', __item(2))"
        XCTAssertEqual(try h.int("__count('img', \(stem))"), 1)
        XCTAssertTrue(
            try h.string("__first('img', \(stem)).src")?.hasPrefix("data:image/png;base64,") == true
        )
        XCTAssertEqual(try h.string("__first('img', \(stem)).alt"), "cell diagram")
    }

    func testProseAroundTheRefIsPreservedAsText() throws {
        let h = try harness()
        XCTAssertEqual(
            try h.string("__first('.stem', __item(2)).textContent"),
            "Name the process shown here: "
        )
    }

    func testUnresolvableRefRendersAVisibleMarkerRatherThanVanishing() throws {
        let h = try RendererHarness(bundleJSON: """
        {"test_id":"t","title":"T","items":[
          {"type":"short_text","id":"i",
           "stem":"See ![diagram](asset:99999999-9999-4999-8999-999999999999) here."}]}
        """)
        XCTAssertEqual(try h.int("__count('.missing-asset')"), 1)
        XCTAssertEqual(
            try h.string("__first('.missing-asset').textContent"),
            "[image not found: diagram]"
        )
    }
}
