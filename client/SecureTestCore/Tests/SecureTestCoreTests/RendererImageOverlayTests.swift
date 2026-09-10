import XCTest
@testable import SecureTestCore

/// C-4 / D-7 (2026-09-09, `docs/multi-source-stimulus-design.md`):
/// click-to-enlarge on the pictures that are CONTENT — a stem's, a stimulus
/// body's, a source body's — and on nothing else. Runs the real renderer in
/// JavaScriptCore against the delivery fixture, which carries a stem image
/// (item 3, short text), a stimulus image (the own_page set) and a source image
/// (Source B), plus a hotspot whose picture is an answer surface rather than
/// something to enlarge.
final class RendererImageOverlayTests: XCTestCase {
    private func harness() throws -> RendererHarness {
        try RendererHarness(bundleJSON: try RendererHarness.fixtureJSON())
    }

    /// The overlay lives on `document.body`, outside the item tree the
    /// selector helpers default to.
    private let overlay = "__first('.image-overlay', document.body)"

    // MARK: - which pictures are enlargeable

    func testAStemImageIsAButtonAsWellAsAPicture() throws {
        let h = try harness()
        let img = "__first('img', __first('.stem', __item(2)))"
        XCTAssertEqual(try h.string("\(img).className"), "enlargeable")
        XCTAssertEqual(try h.string("\(img).getAttribute('tabindex')"), "0")
        XCTAssertEqual(try h.string("\(img).getAttribute('role')"), "button")
        XCTAssertEqual(
            try h.string("\(img).getAttribute('aria-label')"),
            "Enlarge image: cell diagram"
        )
    }

    func testAStimulusImageAndASourceImageAreEnlargeable() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('.enlargeable', __first('.stimulus-body'))"), 1)
        XCTAssertEqual(try h.int("__count('.enlargeable', __all('.source-body')[1])"), 1)
    }

    /// The hotspot picture is the answer surface — clicking it selects a
    /// region, and an overlay over it would swallow the interaction.
    func testTheHotspotPictureIsNotEnlargeable() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('img', __first('.hotspot-frame'))"), 1)
        XCTAssertEqual(try h.string("__first('img', __first('.hotspot-frame')).className"), "")
        XCTAssertNil(try h.string("__first('img', __first('.hotspot-frame')).getAttribute('role')"))
        XCTAssertEqual(try h.int("__count('.enlargeable', __first('.hotspot-frame'))"), 0)
    }

    /// Nothing is appended to the body until a student actually opens one.
    func testNoOverlayExistsBeforeAnythingIsOpened() throws {
        let h = try harness()
        XCTAssertEqual(try h.int("__count('.image-overlay', document.body)"), 0)
    }

    // MARK: - opening

    func testClickingAStemImageOpensTheOverlayWithTheSamePictureAndItsAlt() throws {
        let h = try harness()
        let img = "__first('img', __first('.stem', __item(2)))"
        try h.eval("\(img).onclick()")
        XCTAssertEqual(try h.int("__count('.image-overlay', document.body)"), 1)
        XCTAssertEqual(try h.string("\(overlay).getAttribute('role')"), "dialog")
        XCTAssertEqual(try h.string("\(overlay).getAttribute('aria-modal')"), "true")
        XCTAssertNil(try h.string("\(overlay).getAttribute('hidden')"))
        XCTAssertEqual(
            try h.string("__first('img', \(overlay)).src"),
            try h.string("\(img).src")
        )
        XCTAssertEqual(try h.string("__first('.image-overlay-caption', \(overlay)).textContent"), "cell diagram")
        XCTAssertEqual(try h.string("\(overlay).getAttribute('aria-label')"), "cell diagram")
        // Focus moves into the dialog.
        XCTAssertEqual(try h.string("document.activeElement.className"), "image-overlay-close")
    }

    func testASourceImageCarriesItsSourceLabelIntoTheCaption() throws {
        let h = try harness()
        try h.eval("__first('.enlargeable', __all('.source-body')[1]).onclick()")
        XCTAssertEqual(
            try h.string("__first('.image-overlay-caption', \(overlay)).textContent"),
            "Source B — cell diagram"
        )
        XCTAssertEqual(try h.string("\(overlay).getAttribute('aria-label')"), "Source B — cell diagram")
    }

    func testEnterAndSpaceOpenItFromTheKeyboard() throws {
        let h = try harness()
        let img = "__first('img', __first('.stem', __item(2)))"
        try h.eval("\(img).onkeydown({ key: 'Enter', preventDefault: function () {} })")
        XCTAssertNil(try h.string("\(overlay).getAttribute('hidden')"))
        try h.eval("document.onkeydown({ key: 'Escape', preventDefault: function () {} })")
        try h.eval("\(img).onkeydown({ key: ' ', preventDefault: function () {} })")
        XCTAssertNil(try h.string("\(overlay).getAttribute('hidden')"))
        // A key it does not handle leaves it as it was.
        try h.eval("document.onkeydown({ key: 'Escape', preventDefault: function () {} })")
        try h.eval("\(img).onkeydown({ key: 'a', preventDefault: function () {} })")
        XCTAssertEqual(try h.string("\(overlay).getAttribute('hidden')"), "")
    }

    // MARK: - closing

    func testTheCloseButtonClosesItAndReturnsFocusToTheOpener() throws {
        let h = try harness()
        let img = "__first('img', __first('.stem', __item(2)))"
        try h.eval("\(img).onclick()")
        try h.eval("__first('.image-overlay-close', \(overlay)).onclick()")
        XCTAssertEqual(try h.string("\(overlay).getAttribute('hidden')"), "")
        XCTAssertEqual(try h.string("document.activeElement.getAttribute('aria-label')"), "Enlarge image: cell diagram")
    }

    func testEscapeClosesItAndReturnsFocusToTheOpener() throws {
        let h = try harness()
        try h.eval("__first('.enlargeable', __all('.source-body')[1]).onclick()")
        try h.eval("document.onkeydown({ key: 'Escape', preventDefault: function () {} })")
        XCTAssertEqual(try h.string("\(overlay).getAttribute('hidden')"), "")
        XCTAssertEqual(try h.string("document.activeElement.getAttribute('role')"), "button")
    }

    /// A click anywhere on the overlay — the backdrop included — dismisses.
    func testAClickOnTheBackdropClosesIt() throws {
        let h = try harness()
        try h.eval("__first('img', __first('.stem', __item(2))).onclick()")
        try h.eval("\(overlay).onclick()")
        XCTAssertEqual(try h.string("\(overlay).getAttribute('hidden')"), "")
    }

    /// While it is shut, Escape belongs to whoever else wants it — the order
    /// item's mid-drag cancel chains onto this handler.
    func testEscapeWhileClosedFallsThroughToTheChainedHandler() throws {
        let h = try harness()
        try h.eval("var __chained = 0; var __prev = document.onkeydown;"
            + "document.onkeydown = function (e) { __chained += 1; return __prev(e); };")
        try h.eval("document.onkeydown({ key: 'Escape', preventDefault: function () {} })")
        XCTAssertEqual(try h.int("__chained"), 1)
        XCTAssertEqual(try h.int("__count('.image-overlay', document.body)"), 0)
    }

    // MARK: - one at a time

    func testOpeningASecondPictureSwapsTheImageInTheSameOverlay() throws {
        let h = try harness()
        try h.eval("__first('img', __first('.stem', __item(2))).onclick()")
        let stemSrc = try h.string("__first('img', \(overlay)).src")
        try h.eval("__first('.enlargeable', __all('.source-body')[1]).onclick()")
        XCTAssertEqual(try h.int("__count('.image-overlay', document.body)"), 1)
        XCTAssertEqual(try h.string("__first('img', \(overlay)).src"), stemSrc)
        XCTAssertEqual(
            try h.string("__first('.image-overlay-caption', \(overlay)).textContent"),
            "Source B — cell diagram"
        )
    }

    // MARK: - the stylesheet

    func testTheStylesheetCarriesTheOverlayAndTheEnlargeableCursor() throws {
        let css = AssessmentPage.html(title: "T", bundleJSON: "{}")
        XCTAssertTrue(css.contains(".enlargeable { cursor: zoom-in; }"))
        XCTAssertTrue(css.contains(".image-overlay {"))
        XCTAssertTrue(css.contains("position: fixed; inset: 0;"))
        XCTAssertTrue(css.contains(".image-overlay[hidden] { display: none; }"))
        XCTAssertTrue(css.contains("max-height: 80vh; object-fit: contain;"))
        XCTAssertTrue(css.contains(".image-overlay-close:focus-visible"))
    }
}
